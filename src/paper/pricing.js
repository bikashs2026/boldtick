// src/paper/pricing.js — structure math: risk, live price, marks, P&L
//
// Prices are per share (a 1.20 credit = $120 per contract). "units" = how many
// of the structure. Every leg has the same quantity in most structures —
// the exception is butterfly, whose body is sold twice: units() there is the
// wing qty, and the body leg's own qty (2x a wing's) is carried through as
// its "weight" wherever a leg's dollar contribution is computed, rather than
// assumed equal to every other leg's.

const MULT = 100;

function normLegs(idea) {
  return (idea.legs || []).map(l => ({
    action: String(l.action).toLowerCase(),
    type: String(l.type).toLowerCase(),
    strike: Number(l.strike),
    qty: Number(l.qty),
    expiry: String(l.expiry || idea.expiry),
  }));
}

// structure is optional — omitting it (or passing one with no special case
// below) keeps the old, simple "every leg is one unit" behavior.
function units(legs, structure) {
  if (!legs.length) return 0;
  if (structure === 'butterfly') {
    const wing = buys(legs)[0];
    return wing ? wing.qty : legs[0].qty;
  }
  return legs[0].qty;
}
const sells = (legs, type) => legs.filter(l => l.action === 'sell' && (!type || l.type === type));
const buys  = (legs, type) => legs.filter(l => l.action === 'buy'  && (!type || l.type === type));

// Risk for one structure at a given limit price. Returns $ totals for all units.
function riskProfile(structure, legs, price, creditOrDebit) {
  const u = units(legs, structure);
  const p = Number(price);
  switch (structure) {
    case 'iron_condor': {
      const sp = sells(legs, 'put')[0], lp = buys(legs, 'put')[0], sc = sells(legs, 'call')[0], lc = buys(legs, 'call')[0];
      const width = Math.max(sp.strike - lp.strike, lc.strike - sc.strike);
      return { defined: true, width, max_profit: r2(p * MULT * u), max_loss: r2((width - p) * MULT * u), breakevens: [r2(sp.strike - p), r2(sc.strike + p)] };
    }
    case 'bull_put_spread': {
      const sp = sells(legs, 'put')[0], lp = buys(legs, 'put')[0];
      const width = sp.strike - lp.strike;
      return { defined: true, width, max_profit: r2(p * MULT * u), max_loss: r2((width - p) * MULT * u), breakevens: [r2(sp.strike - p)] };
    }
    case 'diagonal':
    case 'calendar': {
      const long = buys(legs)[0], short = sells(legs)[0];
      // A long strike further OTM than the short adds the strike gap to the risk.
      const gap = long.type === 'call' ? Math.max(0, long.strike - short.strike) : Math.max(0, short.strike - long.strike);
      return { defined: true, width: null, max_profit: null, max_loss: r2((p + gap) * MULT * u), breakevens: null };
    }
    case 'covered_call':
      return { defined: true, covered: true, width: null, max_profit: r2(p * MULT * u), max_loss: null, breakevens: null };
    case 'covered_strangle': {
      const sp = sells(legs, 'put')[0];
      // The short put is cash-secured: assignment risk, not a defined max loss.
      return { defined: false, covered: true, width: null, max_profit: r2(p * MULT * u), max_loss: null,
        assignment_risk: r2((sp.strike - p) * MULT * u), breakevens: null };
    }
    case 'butterfly':
    case 'rsb':
    case 'custom':
      // A butterfly or RSB's payoff is just another piecewise-linear leg
      // combination — genericRiskProfile's exact breakpoint analysis already
      // gets max profit/loss and both breakevens right without a bespoke
      // formula, and (via units() above) correctly weights a butterfly's
      // doubled body leg rather than assuming every leg is one unit.
      return genericRiskProfile(legs, p, creditOrDebit, structure);
    default:
      return { defined: false, width: null, max_profit: null, max_loss: null, breakevens: null };
  }
}

// Per-share payoff of a leg combination at expiration, for an arbitrary (not
// necessarily named) structure — intrinsic value only, no entry price baked
// in. Used by genericRiskProfile below and by the Build tab's P&L curve, so
// both agree on the same math. u is "one unit" of the structure (see units()
// above) — a leg whose own qty is a multiple of u (a butterfly's body,
// sold twice) counts that many times its intrinsic value, instead of once
// like every other leg.
function payoffAtExpiry(legs, S, u = units(legs)) {
  return legs.reduce((sum, l) => {
    const intrinsic = l.type === 'call' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
    const w = u ? l.qty / u : 1;
    return sum + (l.action === 'buy' ? intrinsic : -intrinsic) * w;
  }, 0);
}

// Risk profile for any leg combination, computed numerically instead of from
// a named structure's formula — this is what the "custom" structure uses,
// and what the Build tab's stat tiles (max profit/loss, breakevens) use for
// every structure so the UI never has to special-case the math per shape.
//
// Only the upper tail can be unbounded here: every leg's price floor is 0
// (the underlying can't go negative), so the downside is always bounded by
// the payoff at S=0; the upside is unbounded exactly when there are more
// short calls than long calls (a naked/uncovered short call).
function genericRiskProfile(legs, price, creditOrDebit, structure) {
  const u = units(legs, structure);
  const p = Number(price);
  const entryCash = creditOrDebit === 'debit' ? -p : p; // $ received (credit) per share at entry

  const callLegs = legs.filter(l => l.type === 'call');
  // Weighted by each leg's own qty relative to one unit, so a leg sold or
  // bought more than once per unit (a butterfly's body) counts that many
  // times toward whether the upper tail is covered.
  const upSlope = callLegs.reduce((s, l) => s + (l.action === 'buy' ? 1 : -1) * (u ? l.qty / u : 1), 0);
  const definedLoss = upSlope >= 0;

  // pnl(S) is piecewise-linear and kinks only at each leg's own strike, so
  // evaluating exactly at the strikes (plus 0 and one point past the
  // highest strike, where the upper tail's constant slope has already taken
  // over) finds the true extrema and exact breakevens by interpolation —
  // no sweep, no approximation, and no risk of missing a kink between samples.
  const maxStrike = Math.max(...legs.map(l => l.strike));
  const breakpoints = [...new Set([0, ...legs.map(l => l.strike), maxStrike + 1])].sort((a, b) => a - b);
  const samples = breakpoints.map(S => ({ S, pnl: payoffAtExpiry(legs, S, u) + entryCash }));
  let maxPnl = -Infinity, minPnl = Infinity;
  for (const { pnl } of samples) { if (pnl > maxPnl) maxPnl = pnl; if (pnl < minPnl) minPnl = pnl; }

  const breakevens = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].pnl, b = samples[i].pnl;
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      const t = a === b ? 0 : (0 - a) / (b - a);
      breakevens.push(r2(samples[i - 1].S + (samples[i].S - samples[i - 1].S) * t));
    }
  }
  return {
    defined: definedLoss,
    width: null,
    max_profit: upSlope > 0 ? null : r2(maxPnl * MULT * u),
    max_loss: definedLoss ? r2(-minPnl * MULT * u) : null,
    breakevens: breakevens.length ? breakevens : null,
  };
}

// Opening price of the structure from live quotes (per unit, positive number).
// quotes: Map legKey -> { bid, ask, mid, delta }
function openingPrice(legs, quotes, creditOrDebit, structure) {
  let mid = 0, natural = 0;
  for (const l of legs) {
    const q = quotes.get(legKey(l));
    if (!q) return null;
    const n = l.qty / units(legs, structure);
    if (l.action === 'sell') { mid += n * q.mid; natural += n * q.bid; }
    else { mid -= n * q.mid; natural -= n * q.ask; }
  }
  // mid/natural here are net credit; flip for debit structures.
  if (creditOrDebit === 'debit') { mid = -mid; natural = -natural; }
  return { mid: r2(mid), natural: r2(natural) };
}

// The actual credit/debit direction a set of legs prices to, from their live
// quotes — not the direction a caller declares. Every named structure has a
// shape rule that forces its direction (checkShape's `want(credit, ...)` /
// `want(!credit, ...)`), so a caller can't get this wrong for those; "custom"
// and "rsb" have no such rule (which leg combination nets credit vs debit
// genuinely depends on live premiums), so callers for those two must use
// this instead of guessing — openingPrice()/riskProfile() both assume their
// caller already passed the *correct* direction, and silently produce wrong
// numbers (flipped max profit/loss, wrong breakevens) when it's backwards.
function naturalCreditOrDebit(legs, quotes, structure) {
  const raw = openingPrice(legs, quotes, 'credit', structure); // unflipped: positive = truly a net credit
  if (!raw) return null;
  return raw.mid >= 0 ? 'credit' : 'debit';
}

// Mark of an open position: value of the structure now (per unit, positive),
// and P&L in dollars. entryPrice is per unit, positive.
function mark(legs, quotes, creditOrDebit, entryPrice, structure) {
  let netMid = 0, netNat = 0; // value we'd receive by closing (long legs sold, short legs bought)
  for (const l of legs) {
    const q = quotes.get(legKey(l));
    if (!q || q.mid == null) return { stale: true };
    const n = l.qty / units(legs, structure);
    if (l.action === 'buy') { netMid += n * q.mid; netNat += n * q.bid; }
    else { netMid -= n * q.mid; netNat -= n * q.ask; }
  }
  const u = units(legs, structure);
  const credit = creditOrDebit === 'credit';
  const entryNet = credit ? entryPrice : -entryPrice; // cash received per unit at entry
  return {
    stale: false,
    value: r2(credit ? -netMid : netMid),            // structure price now
    natural: r2(credit ? -netNat : netNat),          // what closing at the touch costs / returns
    pnl: r2((entryNet + netMid) * MULT * u),
    pnl_natural: r2((entryNet + netNat) * MULT * u),
  };
}

// Closing order price for a position (per unit, positive).
function closingPrice(m, mode) { return mode === 'natural' ? m.natural : m.value; }

// Exchange tick for an order price.
function roundToTick(symbol, price, dir = 'nearest') {
  const s = String(symbol).toUpperCase().replace(/^\$/, '');
  const tick = (s === 'SPX' || s === 'SPXW' || s === 'XSP') ? (price >= 3 ? 0.10 : 0.05) : 0.01;
  const f = dir === 'up' ? Math.ceil : dir === 'down' ? Math.floor : Math.round;
  const steps = f(Number((price / tick).toFixed(6)));
  return Math.max(tick, r2(steps * tick));
}

function legKey(l) { return `${l.expiry}|${l.type}|${Number(l.strike)}`; }
function r2(v) { return Math.round(v * 100) / 100 + 0; } // + 0 turns -0 into 0

module.exports = { normLegs, units, sells, buys, riskProfile, payoffAtExpiry, openingPrice, naturalCreditOrDebit, mark, closingPrice, roundToTick, legKey, MULT, r2 };
