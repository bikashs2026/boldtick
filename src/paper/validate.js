// src/paper/validate.js — the three gates every idea passes, plus Settings limits
//
// Returns { errors, warnings, computed, legs, quotes, contracts }.
//   errors   → [{ field, issue }]   hard failures (422)
//   warnings → [string]            shown on the idea card
// Limits whose Settings mode is "block" become errors; "warn" become warnings;
// "off" are skipped. Portfolio limits (open positions, total risk, daily loss,
// trades per day) are only enforced at Approve; at creation they are warnings.

const { STRUCTURES } = require('./settings');
const { normLegs, units, sells, buys, riskProfile, openingPrice, legKey, r2 } = require('./pricing');
const { hmToMinutes } = require('./clock');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREDIT_STRUCTURES = new Set(['iron_condor', 'bull_put_spread', 'covered_strangle', 'covered_call']);

// ── Gate 0: request schema ──────────────────────────────────────────────────
function checkSchema(b) {
  const errors = [];
  const e = (field, issue) => errors.push({ field, issue });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return [{ field: '', issue: 'body must be a JSON object' }];
  if (typeof b.client_idea_id !== 'string' || !/^[\w.:-]{1,64}$/.test(b.client_idea_id)) e('client_idea_id', '1–64 characters: letters, digits, _ . : -');
  if (typeof b.symbol !== 'string' || !/^\$?[A-Za-z0-9./]{1,10}$/.test(b.symbol)) e('symbol', 'required, e.g. SPX');
  if (!STRUCTURES.includes(b.structure)) e('structure', `one of ${STRUCTURES.join(', ')}`);
  if (typeof b.expiry !== 'string' || !DATE.test(b.expiry)) e('expiry', 'YYYY-MM-DD');
  if (!Array.isArray(b.legs) || b.legs.length < 1 || b.legs.length > 4) e('legs', '1–4 legs');
  else b.legs.forEach((l, i) => {
    if (!l || typeof l !== 'object') return e(`legs[${i}]`, 'must be an object');
    if (!['sell', 'buy'].includes(l.action)) e(`legs[${i}].action`, 'sell or buy');
    if (!['call', 'put'].includes(l.type)) e(`legs[${i}].type`, 'call or put');
    if (!(Number(l.strike) > 0)) e(`legs[${i}].strike`, 'positive number');
    if (!Number.isInteger(l.qty) || l.qty < 1) e(`legs[${i}].qty`, 'whole number ≥ 1');
    if (l.expiry !== undefined && (typeof l.expiry !== 'string' || !DATE.test(l.expiry))) e(`legs[${i}].expiry`, 'YYYY-MM-DD');
  });
  if (!(Number(b.limit_price) > 0)) e('limit_price', 'positive number');
  if (!['credit', 'debit'].includes(b.credit_or_debit)) e('credit_or_debit', 'credit or debit');
  if (b.max_loss !== null && b.max_loss !== undefined && !Number.isFinite(Number(b.max_loss))) e('max_loss', 'number');
  if (b.breakevens !== undefined && b.breakevens !== null && (!Array.isArray(b.breakevens) || b.breakevens.some(x => !Number.isFinite(Number(x))))) e('breakevens', 'list of numbers');
  if (typeof b.thesis !== 'string' || !b.thesis.trim()) e('thesis', 'required');
  else if (b.thesis.length > 4000) e('thesis', 'at most 4000 characters');
  if (b.earnings_date !== undefined && b.earnings_date !== null && (typeof b.earnings_date !== 'string' || !DATE.test(b.earnings_date))) e('earnings_date', 'YYYY-MM-DD or null');
  for (const k of ['suggested_stop', 'suggested_take_profit', 'underlying_price']) {
    if (b[k] !== undefined && b[k] !== null && !(Number(b[k]) >= 0)) e(k, 'non-negative number');
  }
  if (b.ttl_minutes !== undefined && b.ttl_minutes !== null && !(Number.isInteger(b.ttl_minutes) && b.ttl_minutes >= 1 && b.ttl_minutes <= 1440)) e('ttl_minutes', 'whole number 1–1440');
  if (b.confidence !== undefined && b.confidence !== null && !(Number(b.confidence) >= 0 && Number(b.confidence) <= 1)) e('confidence', 'number 0–1');
  return errors;
}

// ── Gate 1: shape per structure ─────────────────────────────────────────────
function checkShape(structure, legs, creditOrDebit) {
  const errors = [];
  const e = issue => errors.push({ field: 'legs', issue });
  const exp = new Set(legs.map(l => l.expiry));
  if (new Set(legs.map(l => l.qty)).size > 1) e('every leg must have the same qty');
  const sp = sells(legs, 'put'), bp = buys(legs, 'put'), sc = sells(legs, 'call'), bc = buys(legs, 'call');
  const want = (cond, msg) => { if (!cond) e(msg); };
  const credit = creditOrDebit === 'credit';

  switch (structure) {
    case 'iron_condor':
      want(legs.length === 4 && sp.length === 1 && bp.length === 1 && sc.length === 1 && bc.length === 1, 'iron condor: sell put, buy put, sell call, buy call');
      if (!errors.length) {
        want(bp[0].strike < sp[0].strike, 'iron condor: long put strike must be below short put');
        want(sp[0].strike < sc[0].strike, 'iron condor: short put must be below short call');
        want(sc[0].strike < bc[0].strike, 'iron condor: long call strike must be above short call');
        want(exp.size === 1, 'iron condor: all legs one expiry');
      }
      want(credit, 'iron condor is a credit trade');
      break;
    case 'bull_put_spread':
      want(legs.length === 2 && sp.length === 1 && bp.length === 1, 'bull put spread: sell put, buy put');
      if (!errors.length) {
        want(bp[0].strike < sp[0].strike, 'bull put spread: long put strike must be below short put');
        want(exp.size === 1, 'bull put spread: both legs one expiry');
      }
      want(credit, 'bull put spread is a credit trade');
      break;
    case 'diagonal':
      want(legs.length === 2 && sc.length === 1 && bc.length === 1, 'diagonal: buy call (back month), sell call (front month)');
      if (!errors.length) want(bc[0].expiry > sc[0].expiry, 'diagonal: long call must expire after the short call');
      want(!credit, 'diagonal is a debit trade');
      break;
    case 'calendar': {
      const long = buys(legs), short = sells(legs);
      want(legs.length === 2 && long.length === 1 && short.length === 1 && long[0].type === short[0].type, 'calendar: buy and sell the same type');
      if (!errors.length) {
        want(long[0].strike === short[0].strike, 'calendar: both legs same strike');
        want(long[0].expiry > short[0].expiry, 'calendar: long leg must expire after the short leg');
      }
      want(!credit, 'calendar is a debit trade');
      break;
    }
    case 'covered_strangle':
      want(legs.length === 2 && sp.length === 1 && sc.length === 1, 'covered strangle: sell call, sell put');
      if (!errors.length) {
        want(sp[0].strike < sc[0].strike, 'covered strangle: put strike must be below call strike');
        want(exp.size === 1, 'covered strangle: both legs one expiry');
      }
      want(credit, 'covered strangle is a credit trade');
      break;
    case 'covered_call':
      want(legs.length === 1 && sc.length === 1, 'covered call: one short call');
      want(credit, 'covered call is a credit trade');
      break;
  }
  return errors;
}

// ── Full validation ─────────────────────────────────────────────────────────
// ctx: { settings, clock, market, stage: 'create'|'approve', portfolio, overridePrice, overrideUnits }
// portfolio: { openPositions: [{symbol, max_loss, defined}], tradesToday, realizedToday, sharesHeld: async (symbol) => n|null }
async function validateIdea(idea, ctx) {
  const { settings, clock, market, stage = 'create', portfolio = {} } = ctx;
  const out = { errors: [], warnings: [], computed: {}, legs: [], quotes: new Map(), contracts: new Map() };

  const schema = checkSchema(idea);
  if (schema.length) { out.errors = schema; return out; }

  let legs = normLegs(idea);
  if (ctx.overrideUnits) legs = legs.map(l => ({ ...l, qty: ctx.overrideUnits }));
  out.legs = legs;
  const shape = checkShape(idea.structure, legs, idea.credit_or_debit);
  if (shape.length) { out.errors = shape; return out; }

  const symbol = idea.symbol.toUpperCase().replace(/^\$/, '');
  const price = Number(ctx.overridePrice ?? idea.limit_price);
  const u = units(legs);
  const today = clock.today();
  const et = clock.et();
  const expiries = [...new Set(legs.map(l => l.expiry))].sort();
  const firstExpiry = expiries[0];
  const zeroDte = firstExpiry === today;
  const credit = idea.credit_or_debit === 'credit';

  const limit = (key, failing, message, { portfolioLimit = false } = {}) => {
    if (!failing) return;
    const mode = settings.mode(key);
    if (mode === 'off') return;
    if (mode === 'block' && !(portfolioLimit && stage === 'create')) out.errors.push({ field: key, issue: message });
    else out.warnings.push(portfolioLimit && stage === 'create' && mode === 'block' ? `${message} (will block at Approve)` : message);
  };

  // Dates
  if (expiries.some(d => d < today)) out.errors.push({ field: 'expiry', issue: `already expired (today is ${today})` });

  // Static settings limits
  const allowedSyms = settings.value('risk.allowed_symbols');
  limit('risk.allowed_symbols', allowedSyms.length > 0 && !allowedSyms.includes(symbol), `${symbol} is not in the allowed symbols (${allowedSyms.join(', ')})`);
  limit('risk.allowed_structures', !settings.value('risk.allowed_structures').includes(idea.structure), `${idea.structure} is not an allowed structure`);
  limit('risk.max_contracts', u > settings.value('risk.max_contracts'), `${u} contracts exceeds the limit of ${settings.value('risk.max_contracts')}`);

  const risk = riskProfile(idea.structure, legs, price);
  out.computed = { units: u, zero_dte: zeroDte, ...risk };
  if (!risk.defined && !settings.value('risk.allow_undefined_risk')) {
    out.errors.push({ field: 'risk.allow_undefined_risk', issue: `${idea.structure} has undefined risk and undefined-risk structures are turned off in Settings` });
  }
  if (risk.defined && risk.max_loss != null) {
    const lim = settings.value('risk.max_loss_per_trade');
    limit('risk.max_loss_per_trade', risk.max_loss > lim, `max loss $${fmt(risk.max_loss)} exceeds the per-trade limit of $${fmt(lim)}`);
  }
  if (risk.max_loss != null && risk.max_loss <= 0 && credit) out.errors.push({ field: 'limit_price', issue: `credit ${price} is not less than the spread width; max loss would be $${fmt(risk.max_loss)}` });

  // Muse's numbers vs ours
  const tol = settings.value('entry.muse_mismatch_pct') / 100;
  if (idea.max_loss != null && risk.max_loss != null) {
    const diff = Math.abs(Number(idea.max_loss) - risk.max_loss) / Math.max(1, risk.max_loss);
    limit('entry.muse_mismatch_pct', diff > tol, `Muse's max loss $${fmt(idea.max_loss)} differs from computed $${fmt(risk.max_loss)}`);
  }
  if (Array.isArray(idea.breakevens) && risk.breakevens) {
    const theirs = idea.breakevens.map(Number).sort((a, b) => a - b), ours = risk.breakevens.slice().sort((a, b) => a - b);
    const off = theirs.length !== ours.length || theirs.some((v, i) => Math.abs(v - ours[i]) / ours[i] > tol / 10);
    limit('entry.muse_mismatch_pct', off, `Muse's breakevens ${theirs.join(' / ')} differ from computed ${ours.join(' / ')}`);
  }

  // Time rules
  const [ws, we] = settings.value('entry.window');
  const inWindow = et.weekday >= 1 && et.weekday <= 5 && et.minutes >= hmToMinutes(ws) && et.minutes <= hmToMinutes(we);
  limit('entry.window', !inWindow, `outside the entry window ${ws}–${we} ET (now ${et.hm} ET${et.weekday === 0 || et.weekday === 6 ? ', weekend' : ''})`);
  if (zeroDte) limit('entry.no_0dte_after', et.minutes > hmToMinutes(settings.value('entry.no_0dte_after')), `no new 0DTE entries after ${settings.value('entry.no_0dte_after')} ET`);

  // Earnings inside the holding window
  if (idea.earnings_date) {
    const lastExpiry = expiries[expiries.length - 1];
    limit('risk.earnings_in_window', idea.earnings_date >= today && idea.earnings_date <= lastExpiry, `earnings on ${idea.earnings_date} fall inside the holding window`);
  }

  // Gate 3: live market
  let priced = false;
  try {
    const lo = Math.min(...legs.map(l => l.strike)), hi = Math.max(...legs.map(l => l.strike));
    for (const exp of expiries) {
      const chain = await market.getChain(symbol, exp, { strikeRange: [lo, hi] });
      out.computed.underlying = chain.underlying || out.computed.underlying;
      for (const c of chain.contracts) out.contracts.set(`${exp}|${c.type}|${Number(c.strike)}`, c);
    }
    const missing = legs.filter(l => !out.contracts.has(legKey(l)));
    if (missing.length) {
      for (const l of missing) out.errors.push({ field: 'legs', issue: `${l.type} ${l.strike} is not listed for ${l.expiry}` });
    } else {
      for (const l of legs) {
        const c = out.contracts.get(legKey(l));
        out.quotes.set(legKey(l), c);
      }
      const live = openingPrice(legs, out.quotes, idea.credit_or_debit);
      priced = live && live.mid > 0;
      if (live) {
        out.computed.live_mid = live.mid;
        out.computed.live_natural = live.natural;
        if (priced) {
          const diffPct = Math.abs(price - live.mid) / live.mid * 100;
          out.computed.limit_vs_mid_pct = r2(diffPct);
          limit('entry.limit_vs_mid_pct', diffPct > settings.value('entry.limit_vs_mid_pct'),
            `limit ${price.toFixed(2)} is ${r2(Math.abs(price - live.mid)).toFixed(2)} ${price > live.mid ? 'above' : 'below'} live mid ${live.mid.toFixed(2)} (${diffPct.toFixed(0)}%)`);
        }
      }
      const shortDeltas = {};
      for (const l of legs.filter(x => x.action === 'sell')) shortDeltas[l.type] = out.quotes.get(legKey(l)).delta;
      out.computed.short_deltas = shortDeltas;
      const inRange = ([lo2, hi2]) => Object.values(shortDeltas).every(d => Math.abs(d) >= lo2 && Math.abs(d) <= hi2);
      if (idea.structure === 'iron_condor' && zeroDte) {
        const r = settings.value('entry.delta_ic_0dte');
        limit('entry.delta_ic_0dte', !inRange(r), `short deltas ${fmtDeltas(shortDeltas)} outside ${r[0]}–${r[1]}`);
      }
      if (idea.structure === 'covered_strangle') {
        const r = settings.value('entry.delta_strangle');
        limit('entry.delta_strangle', !inRange(r), `short deltas ${fmtDeltas(shortDeltas)} outside ${r[0]}–${r[1]}`);
      }
    }
  } catch (err) {
    out.warnings.push(`unpriced: live market data unavailable (${err.message})`);
    out.computed.market_error = err.message;
  }
  out.computed.priced = priced;

  if (risk.width && credit) {
    const pct = price / risk.width * 100;
    limit('entry.min_credit_pct_width', pct < settings.value('entry.min_credit_pct_width'), `credit is ${pct.toFixed(0)}% of the ${risk.width}-wide spread (minimum ${settings.value('entry.min_credit_pct_width')}%)`);
  }

  // Portfolio limits (enforced at Approve)
  const open = portfolio.openPositions || [];
  limit('risk.max_open_positions', open.length + 1 > settings.value('risk.max_open_positions'), `would make ${open.length + 1} open positions (limit ${settings.value('risk.max_open_positions')})`, { portfolioLimit: true });
  if (risk.defined && risk.max_loss != null) {
    const total = open.filter(p => p.defined && p.max_loss != null).reduce((s, p) => s + p.max_loss, 0) + risk.max_loss;
    limit('risk.max_total_open_risk', total > settings.value('risk.max_total_open_risk'), `total open risk would be $${fmt(total)} (limit $${fmt(settings.value('risk.max_total_open_risk'))})`, { portfolioLimit: true });
  }
  const sameSym = open.filter(p => p.symbol === symbol).length;
  limit('risk.max_positions_per_underlying', sameSym + 1 > settings.value('risk.max_positions_per_underlying'), `would make ${sameSym + 1} open ${symbol} positions (limit ${settings.value('risk.max_positions_per_underlying')})`, { portfolioLimit: true });
  limit('risk.max_trades_per_day', (portfolio.tradesToday || 0) + 1 > settings.value('risk.max_trades_per_day'), `would be trade ${(portfolio.tradesToday || 0) + 1} today (limit ${settings.value('risk.max_trades_per_day')})`, { portfolioLimit: true });
  const lossLimit = settings.value('risk.daily_loss_limit');
  limit('risk.daily_loss_limit', (portfolio.realizedToday || 0) <= -lossLimit, `today's realized loss $${fmt(-(portfolio.realizedToday || 0))} has reached the daily limit of $${fmt(lossLimit)}`, { portfolioLimit: true });

  // Covered structures need the shares
  if (risk.covered && portfolio.sharesHeld) {
    const held = await portfolio.sharesHeld(symbol);
    const need = 100 * u;
    if (held !== null && held < need) {
      const msg = `covered ${idea.structure.replace('_', ' ')} needs ${need} ${symbol} shares; the paper account holds ${held}`;
      if (stage === 'approve') out.errors.push({ field: 'symbol', issue: msg }); else out.warnings.push(msg);
    }
  }

  return out;
}

function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function fmtDeltas(d) { return Object.entries(d).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join(', '); }

module.exports = { validateIdea, checkSchema, checkShape, CREDIT_STRUCTURES };
