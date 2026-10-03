// scripts/muse-sim.js — a stand-in for Muse while the real one can't reach your machine
//
// Builds ideas from LIVE prices (Paper Desk's price-check endpoint), sends them
// through the same API Muse will use, then keeps pushing signals for open
// positions and printing the event feed.
//
//   node scripts/muse-sim.js                     # ideas once, then signals every 30 s
//   node scripts/muse-sim.js --once              # just send the ideas
//   node scripts/muse-sim.js --url http://127.0.0.1:3100 --every 15
//
// Uses MUSE_PAPER_KEY from .env, exactly like the real Muse would.

require('dotenv').config();

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = (arg('--url', `http://127.0.0.1:${process.env.PAPER_PORT || 3100}`)).replace(/\/$/, '') + '/api/paper';
const KEY = process.env.MUSE_PAPER_KEY;
const EVERY = Number(arg('--every', 30)) * 1000;
const ONCE = args.includes('--once');
const RUN = Date.now().toString(36);

if (!KEY) { console.error('Set MUSE_PAPER_KEY in .env first.'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

function addWeekdays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6 !== 0) n--; }
  return d.toISOString().slice(0, 10);
}

// Price many single legs in one call and pick the strike whose |delta| is closest to a target.
async function pickStrike(symbol, expiry, type, spot, step, target, span = 24) {
  const legs = [];
  for (let i = 1; i <= span; i++) {
    const k = type === 'put' ? Math.floor(spot / step) * step - i * step : Math.ceil(spot / step) * step + i * step;
    legs.push({ action: 'sell', type, strike: Math.round(k * 100) / 100, qty: 1 });
  }
  const r = await call('POST', '/price-check', { symbol, expiry, credit_or_debit: 'credit', legs });
  if (r.status !== 200) throw new Error(`price-check ${symbol}: ${r.data?.error?.message}`);
  return r.data.legs.sort((a, b) => Math.abs(Math.abs(a.delta) - target) - Math.abs(Math.abs(b.delta) - target))[0];
}

async function sendIdea(idea) {
  const pc = await call('POST', '/price-check', { symbol: idea.symbol, expiry: idea.expiry, credit_or_debit: idea.credit_or_debit, structure: idea.structure, legs: idea.legs });
  if (pc.status !== 200) { console.log(`  ✖ ${idea.client_idea_id}: price-check ${pc.data?.error?.message}`); return; }
  idea.limit_price = Math.max(0.05, Math.round(pc.data.mid * 20) / 20);
  const risk = pc.data.risk_at_mid || {};
  if (risk.max_loss != null) idea.max_loss = Math.round(risk.max_loss);
  if (risk.breakevens) idea.breakevens = risk.breakevens;
  const r = await call('POST', '/trade-ideas', idea);
  const warn = r.data?.validation?.warnings || [];
  const errs = r.data?.validation?.errors || r.data?.error?.details || [];
  console.log(`  ${r.status === 201 ? '✔' : r.status === 200 ? '=' : '✖'} ${r.status} ${idea.client_idea_id} ${idea.symbol} ${idea.structure} @ ${idea.limit_price}${warn.length ? `\n      warnings: ${warn.join(' | ')}` : ''}${errs.length ? `\n      errors: ${errs.map(e => e.issue).join(' | ')}` : ''}`);
}

async function sendIdeas() {
  const st = await call('GET', '/status');
  if (st.status !== 200) throw new Error(`cannot reach Paper Desk at ${BASE} (${st.status} ${st.data?.error?.message || ''})`);
  const today = st.data.clock.et.slice(0, 10);
  console.log(`Paper Desk: fills ${st.data.fill_model}, data ${st.data.market_data}, ${st.data.clock.et} ET${st.data.clock.market_open ? '' : ' (market closed)'}`);
  const exps = async sym => {
    const r = await call('GET', `/expirations/${sym}`);
    if (r.status !== 200) throw new Error(`expirations ${sym}: ${r.data?.error?.message}`);
    return r.data.expirations.filter(d => d >= today).sort();
  };
  const atLeast = (list, minDate) => list.find(d => d >= minDate);

  // 1. SPX nearest-expiry iron condor (0DTE on trading days), ~12Δ shorts, 5-wide
  const spxExp = (await exps('SPX'))[0];
  const spx = (await call('GET', '/quote/SPX')).data.price;
  const sp = await pickStrike('SPX', spxExp, 'put', spx, 5, 0.12);
  const sc = await pickStrike('SPX', spxExp, 'call', spx, 5, 0.12);
  await sendIdea({
    client_idea_id: `sim-${RUN}-spx-ic`, symbol: 'SPX', structure: 'iron_condor', expiry: spxExp,
    legs: [
      { action: 'sell', type: 'put', strike: sp.strike, qty: 1 }, { action: 'buy', type: 'put', strike: sp.strike - 5, qty: 1 },
      { action: 'sell', type: 'call', strike: sc.strike, qty: 1 }, { action: 'buy', type: 'call', strike: sc.strike + 5, qty: 1 },
    ],
    credit_or_debit: 'credit', thesis: `Simulated: positive gamma, pin near ${Math.round(spx / 5) * 5}; shorts at ~12Δ outside the walls.`,
    earnings_flag: false, earnings_date: null, confidence: 0.65,
  });

  // 2. AMD bull put spread a week out, ~25Δ
  const amdList = await exps('AMD');
  const amdExp = atLeast(amdList, addWeekdays(today, 5)) || amdList[0];
  const amd = (await call('GET', '/quote/AMD')).data.price;
  const ap = await pickStrike('AMD', amdExp, 'put', amd, 2.5, 0.25);
  await sendIdea({
    client_idea_id: `sim-${RUN}-amd-bps`, symbol: 'AMD', structure: 'bull_put_spread', expiry: amdExp,
    legs: [{ action: 'sell', type: 'put', strike: ap.strike, qty: 1 }, { action: 'buy', type: 'put', strike: ap.strike - 2.5, qty: 1 }],
    credit_or_debit: 'credit', thesis: 'Simulated: support holding, IV elevated; sell the 25Δ put spread.', confidence: 0.55,
  });

  // 3. AMD call diagonal with earnings inside the window (shows the earnings warning)
  const front = atLeast(amdList, addWeekdays(today, 3)) || amdList[0];
  const back = atLeast(amdList, addWeekdays(front, 5)) || amdList[amdList.length - 1];
  const atm = Math.round(amd / 2.5) * 2.5;
  await sendIdea({
    client_idea_id: `sim-${RUN}-amd-diag`, symbol: 'AMD', structure: 'diagonal', expiry: front,
    legs: [{ action: 'buy', type: 'call', strike: atm, qty: 1, expiry: back }, { action: 'sell', type: 'call', strike: atm + 5, qty: 1, expiry: front }],
    credit_or_debit: 'debit', thesis: 'Simulated: long back-month call against a short front-month call into earnings.',
    earnings_flag: true, earnings_date: addWeekdays(today, 1), suggested_take_profit: null, suggested_stop: null,
  });

  // 4. Deliberately invalid: wrong leg order for an iron condor
  const bad = await call('POST', '/trade-ideas', {
    client_idea_id: `sim-${RUN}-bad`, symbol: 'SPX', structure: 'iron_condor', expiry: spxExp,
    legs: [{ action: 'buy', type: 'put', strike: sp.strike, qty: 1 }, { action: 'sell', type: 'put', strike: sp.strike - 5, qty: 1 }, { action: 'sell', type: 'call', strike: sc.strike, qty: 1 }, { action: 'buy', type: 'call', strike: sc.strike + 5, qty: 1 }],
    limit_price: 1, credit_or_debit: 'credit', max_loss: 400, breakevens: [], thesis: 'Simulated invalid idea.',
  });
  console.log(`  ${bad.status === 422 ? '✔ rejected as expected' : '✖ unexpected'} ${bad.status} invalid idea: ${(bad.data?.error?.details || []).map(d => d.issue).join(' | ')}`);
}

let cursor = null;
async function followUp() {
  const pos = await call('GET', '/positions');
  for (const p of pos.data || []) {
    if (!p.mark || p.mark.stale) continue;
    const pct = p.mark.pct_max;
    const action = pct != null && pct >= 45 ? 'TAKE_PROFIT' : 'HOLD';
    const r = await call('POST', `/positions/${p.id}/action`, {
      client_signal_id: `sim-${RUN}-${p.id}-${Math.floor(Date.now() / EVERY)}`,
      action, current_value: p.mark.value, pnl_dollars: p.mark.pnl,
      reason: action === 'HOLD' ? `Simulated: P&L ${p.mark.pnl}, nothing to do.` : `Simulated: ${pct}% of max profit captured.`,
    });
    console.log(`  signal ${p.symbol} ${p.structure} → ${action} (${r.status})`);
  }
  const ev = await call('GET', '/events' + (cursor ? `?after=${cursor}` : '?limit=20'));
  for (const e of ev.data?.events || []) console.log(`  event ${e.at} ${e.type} ${e.idea_id || ''}${e.position_id ? ' ' + e.position_id : ''}${e.data?.realized_pnl != null ? ' P&L ' + e.data.realized_pnl : ''}`);
  cursor = ev.data?.next || cursor;
}

(async () => {
  try {
    console.log('Sending ideas…');
    await sendIdeas();
    if (ONCE) return;
    console.log(`\nFollowing up every ${EVERY / 1000}s (Ctrl+C to stop)…`);
    const ev = await call('GET', '/events?limit=500');
    let page = ev.data; while (page?.more) page = (await call('GET', `/events?after=${page.next}&limit=500`)).data;
    cursor = page?.next || null;
    for (;;) { await new Promise(r => setTimeout(r, EVERY)); await followUp().catch(e => console.log('  follow-up error:', e.message)); }
  } catch (e) {
    console.error('✖', e.message);
    process.exit(1);
  }
})();
