// Paper Desk tests — no network, no credentials.
//   npm test
// Everything runs against a controllable clock and a test-only market (FakeMarket),
// through the real live-market scorecard. The app itself refuses simulated data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Clock } = require('../src/paper/clock');
const { Store } = require('../src/paper/store');
const { Settings } = require('../src/paper/settings');
const { FakeMarket, fromSchwabShape } = require('../src/paper/marketData');
const { validateIdea, checkShape } = require('../src/paper/validate');
const { riskProfile, mark, roundToTick, normLegs } = require('../src/paper/pricing');
const { evaluate } = require('../src/paper/engine');
const { createPaperApp } = require('../src/paper/app');
const { TastytradePaperBroker, fromTastyOrder, PAPER_HOST } = require('../src/paper/broker/tastytradePaper');

// ── helpers ─────────────────────────────────────────────────────────────────
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paper-test-'));
function testClock(iso) {
  const c = { t: Date.parse(iso) };
  c.clock = new Clock({ now: () => c.t });
  c.set = s => { c.t = Date.parse(s); };
  c.add = ms => { c.t += ms; };
  return c;
}
const MON_1005 = '2026-10-05T10:05:00-04:00'; // Monday, inside the entry window
const KEY = 'k'.repeat(32);
const ENV = { PAPER_OWNER_USER: 'bikash', PAPER_OWNER_PASSWORD: 'secret-pass', MUSE_PAPER_KEY: KEY, PAPER_SHARES: 'SPCX:100', PAPER_MIRROR: 'none' };

async function startApp({ at = MON_1005, env = {}, broker } = {}) {
  const tc = testClock(at);
  const dir = tmpDir();
  const market = new FakeMarket(tc.clock);
  const p = createPaperApp({ env: { ...ENV, ...env }, dataDir: dir, clock: tc.clock, market, broker: broker ? broker({ clock: tc.clock, market, dir }) : undefined, log: { error() {} } });
  await p.broker.init();
  const server = p.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { Authorization: 'Basic ' + Buffer.from('bikash:secret-pass').toString('base64'), 'X-Requested-With': 'paper-desk' };
  const muse = { 'X-API-Key': KEY };
  async function call(method, url, headers = {}, body) {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
  }
  return { ...p, tc, dir, market, server, base, owner, muse, call, close: () => { server.close(); p.stop(); } };
}

// A 0DTE SPX iron condor around the fake spot (7650), priced at live mid.
async function icIdea(ctx, over = {}) {
  const legs = [
    { action: 'sell', type: 'put', strike: 7615, qty: 1 }, { action: 'buy', type: 'put', strike: 7610, qty: 1 },
    { action: 'sell', type: 'call', strike: 7685, qty: 1 }, { action: 'buy', type: 'call', strike: 7690, qty: 1 },
  ];
  const pc = await ctx.call('POST', '/api/paper/price-check', ctx.muse, { symbol: 'SPX', expiry: '2026-10-05', credit_or_debit: 'credit', structure: 'iron_condor', legs });
  assert.equal(pc.status, 200, JSON.stringify(pc.data));
  const mid = Math.floor(pc.data.mid * 20) / 20; // at or below the live mid → the scorecard fills it
  return {
    client_idea_id: 'ic-' + Math.random().toString(36).slice(2, 8), symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', legs,
    limit_price: mid, credit_or_debit: 'credit', max_loss: Math.round((5 - mid) * 100), breakevens: [7615 - mid, 7685 + mid],
    thesis: 'test', ...over,
  };
}

// ── unit: clock, store, pricing ─────────────────────────────────────────────
test('clock: ET conversion, DST, market hours', () => {
  const { clock } = testClock('2026-10-05T14:05:00Z');
  assert.deepEqual(clock.et(), { date: '2026-10-05', hm: '10:05', minutes: 605, weekday: 1 });
  assert.equal(clock.isMarketHours(), true);
  assert.equal(new Date(clock.atET('2026-10-05', '16:00')).toISOString(), '2026-10-05T20:00:00.000Z'); // EDT
  assert.equal(new Date(clock.atET('2026-12-07', '16:00')).toISOString(), '2026-12-07T21:00:00.000Z'); // EST
  assert.equal(testClock('2026-10-03T14:00:00Z').clock.isMarketHours(), false); // Saturday
});

test('store: atomic save, append, refuses unreadable files', () => {
  const s = new Store(tmpDir());
  s.save('a.json', { x: 1 });
  assert.deepEqual(s.load('a.json', null), { x: 1 });
  assert.ok(!fs.existsSync(s.file('a.json.tmp')));
  s.append('l.jsonl', { a: 1 }); s.append('l.jsonl', { a: 2 });
  assert.deepEqual(s.readLines('l.jsonl'), [{ a: 1 }, { a: 2 }]);
  fs.writeFileSync(s.file('bad.json'), '{ broken');
  assert.throws(() => s.load('bad.json', []), /unreadable/);
  const dest = s.backup('2026-10-05');
  assert.ok(fs.existsSync(path.join(dest, 'a.json')));
});

test('marketData: fromSchwabShape carries gamma, theta, vega and open interest, not just delta/iv', () => {
  const chain = {
    underlyingPrice: 101.4,
    callExpDateMap: {
      '2026-10-09:5': {
        '100.0': [{ symbol: 'MU   261009C00100000', bid: 5.2, ask: 5.4, mark: 5.3, delta: 0.62, volatility: 42.1, gamma: 0.031, theta: -0.08, vega: 0.14, openInterest: 1830 }],
      },
    },
    putExpDateMap: {},
  };
  const out = fromSchwabShape('MU', '2026-10-09', chain, 'tastytrade');
  assert.equal(out.contracts.length, 1);
  const c = out.contracts[0];
  assert.equal(c.type, 'call');
  assert.equal(c.strike, 100);
  assert.equal(c.delta, 0.62);
  assert.ok(Math.abs(c.iv - 0.421) < 1e-9);
  assert.equal(c.gamma, 0.031, 'gamma was dropped before — chain consumers (including Muse) only saw delta/iv');
  assert.equal(c.theta, -0.08);
  assert.equal(c.vega, 0.14);
  assert.equal(c.oi, 1830);
});

test('pricing: risk per structure, marks, ticks', () => {
  const ic = normLegs({ expiry: 'E', legs: [{ action: 'sell', type: 'put', strike: 100, qty: 2 }, { action: 'buy', type: 'put', strike: 95, qty: 2 }, { action: 'sell', type: 'call', strike: 110, qty: 2 }, { action: 'buy', type: 'call', strike: 115, qty: 2 }] });
  assert.deepEqual(riskProfile('iron_condor', ic, 1.2), { defined: true, width: 5, max_profit: 240, max_loss: 760, breakevens: [98.8, 111.2] });
  const diag = normLegs({ expiry: 'F', legs: [{ action: 'buy', type: 'call', strike: 105, qty: 1, expiry: 'G' }, { action: 'sell', type: 'call', strike: 100, qty: 1 }] });
  assert.equal(riskProfile('diagonal', diag, 2).max_loss, 700); // debit + strike gap
  const strangle = normLegs({ expiry: 'E', legs: [{ action: 'sell', type: 'call', strike: 170, qty: 1 }, { action: 'sell', type: 'put', strike: 140, qty: 1 }] });
  assert.equal(riskProfile('covered_strangle', strangle, 2).defined, false);

  const legs = normLegs({ expiry: 'E', legs: [{ action: 'sell', type: 'put', strike: 100, qty: 1 }, { action: 'buy', type: 'put', strike: 95, qty: 1 }] });
  const q = new Map([['E|put|100', { bid: 0.9, ask: 1.1, mid: 1.0 }], ['E|put|95', { bid: 0.3, ask: 0.5, mid: 0.4 }]]);
  const m = mark(legs, q, 'credit', 1.0);
  assert.equal(m.value, 0.6);           // cost to close at mid
  assert.equal(m.natural, 0.8);         // buy 100 at ask, sell 95 at bid
  assert.equal(m.pnl, 40);              // (1.00 − 0.60) × 100
  assert.equal(mark(legs, q, 'debit', 0.5).pnl, -110); // the same legs held as a debit structure

  assert.equal(roundToTick('SPX', 1.23), 1.25);
  assert.equal(roundToTick('SPX', 3.44), 3.4);
  assert.equal(roundToTick('AMD', 1.234), 1.23);
});

// ── unit: settings ──────────────────────────────────────────────────────────
test('settings: defaults, validated updates, version conflicts, per-structure, reset, persistence', () => {
  const dir = tmpDir();
  const { clock } = testClock(MON_1005);
  const s = new Settings(new Store(dir), clock);
  assert.equal(s.value('risk.max_loss_per_trade'), 1000);
  assert.equal(s.mode('risk.max_loss_per_trade'), 'block');

  const r = s.update({ version: 1, values: { 'risk.max_loss_per_trade': 800, 'risk.allowed_symbols': ['spx', '$amd'] }, modes: { 'risk.max_open_positions': 'warn' }, exit_per_structure: { iron_condor: { 'exit.tp_credit_pct': 40 } } });
  assert.equal(r.settings.version, 2);
  assert.deepEqual(s.value('risk.allowed_symbols'), ['SPX', 'AMD']);
  assert.equal(s.exitRules('iron_condor').tp_credit_pct, 40);
  assert.equal(s.exitRules('bull_put_spread').tp_credit_pct, 50);

  assert.throws(() => s.update({ version: 1, values: { 'risk.max_loss_per_trade': 1 } }), e => e.code === 'version_conflict');
  assert.throws(() => s.update({ version: 2, values: { 'exit.tp_credit_pct': 150, 'nope.key': 1, 'entry.window': ['15:00', '10:00'] } }), e => e.details.length === 3);
  assert.equal(s.value('exit.tp_credit_pct'), 50, 'a rejected patch changes nothing');

  const again = new Settings(new Store(dir), clock);
  assert.equal(again.value('risk.max_loss_per_trade'), 800, 'settings persist across restarts');
  assert.equal(again.history().length, 1);
  again.reset();
  assert.equal(again.value('risk.max_loss_per_trade'), 1000);
  assert.equal(again.get().version, 3);
});

// ── unit: validation ────────────────────────────────────────────────────────
test('validation: shape rules per structure', () => {
  const L = (...x) => x.map(([action, type, strike, expiry]) => ({ action, type, strike, qty: 1, expiry: expiry || 'E' }));
  assert.equal(checkShape('iron_condor', L(['sell', 'put', 100], ['buy', 'put', 95], ['sell', 'call', 110], ['buy', 'call', 115]), 'credit').length, 0);
  assert.ok(checkShape('iron_condor', L(['buy', 'put', 100], ['sell', 'put', 95], ['sell', 'call', 110], ['buy', 'call', 115]), 'credit').length);
  assert.ok(checkShape('iron_condor', L(['sell', 'put', 100], ['buy', 'put', 95], ['sell', 'call', 110], ['buy', 'call', 115]), 'debit').length);
  assert.ok(checkShape('bull_put_spread', L(['sell', 'put', 95], ['buy', 'put', 100]), 'credit').length);
  assert.equal(checkShape('diagonal', L(['buy', 'call', 100, 'G'], ['sell', 'call', 105, 'F']), 'debit').length, 0);
  assert.ok(checkShape('diagonal', L(['buy', 'call', 100, 'F'], ['sell', 'call', 105, 'G']), 'debit').length);
  assert.ok(checkShape('calendar', L(['buy', 'call', 100, 'G'], ['sell', 'call', 105, 'F']), 'debit').length);
  assert.equal(checkShape('covered_call', L(['sell', 'call', 170]), 'credit').length, 0);
  assert.ok(checkShape('covered_strangle', L(['sell', 'call', 140], ['sell', 'put', 170]), 'credit').length);
});

test('validation: settings limits, modes, time windows and live market', async () => {
  const tc = testClock(MON_1005);
  const settings = new Settings(new Store(tmpDir()), tc.clock);
  const market = new FakeMarket(tc.clock);
  const idea = {
    client_idea_id: 'v1', symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', thesis: 't', credit_or_debit: 'credit', limit_price: 1,
    legs: [{ action: 'sell', type: 'put', strike: 7600, qty: 1 }, { action: 'buy', type: 'put', strike: 7550, qty: 1 }, { action: 'sell', type: 'call', strike: 7700, qty: 1 }, { action: 'buy', type: 'call', strike: 7705, qty: 1 }],
  };
  let v = await validateIdea(idea, { settings, clock: tc.clock, market });
  assert.ok(v.errors.some(e => e.field === 'risk.max_loss_per_trade'), 'a 50-wide put side breaks the $1,000 limit');
  settings.update({ version: 1, modes: { 'risk.max_loss_per_trade': 'warn' } });
  v = await validateIdea(idea, { settings, clock: tc.clock, market });
  assert.ok(!v.errors.some(e => e.field === 'risk.max_loss_per_trade'));
  assert.ok(v.warnings.some(w => /per-trade limit/.test(w)));
  settings.update({ version: 2, modes: { 'risk.max_loss_per_trade': 'off' } });
  v = await validateIdea(idea, { settings, clock: tc.clock, market });
  assert.ok(!v.warnings.some(w => /per-trade limit/.test(w)));
  assert.equal(v.computed.priced, true);
  assert.ok(v.computed.live_mid > 0);

  v = await validateIdea({ ...idea, symbol: 'TSLA' }, { settings, clock: tc.clock, market });
  assert.ok(v.errors.some(e => e.field === 'risk.allowed_symbols'));

  v = await validateIdea({ ...idea, legs: idea.legs.map(l => ({ ...l, strike: l.strike + 1 })) }, { settings, clock: tc.clock, market });
  assert.ok(v.errors.some(e => /not listed/.test(e.issue)), 'strikes must exist in the chain');

  tc.set('2026-10-05T14:30:00-04:00');
  v = await validateIdea(idea, { settings, clock: tc.clock, market });
  assert.ok(v.errors.some(e => e.field === 'entry.no_0dte_after'));
  tc.set('2026-10-03T11:00:00-04:00'); // Saturday
  v = await validateIdea({ ...idea, expiry: '2026-10-05' }, { settings, clock: tc.clock, market });
  assert.ok(v.errors.some(e => e.field === 'entry.window'));

  tc.set(MON_1005);
  v = await validateIdea({ ...idea, max_loss: 10 }, { settings, clock: tc.clock, market });
  assert.ok(v.warnings.some(w => /Muse's max loss/.test(w)));
  v = await validateIdea({ ...idea, legs: [{ action: 'sell', type: 'put', strike: 'x' }] }, { settings, clock: tc.clock, market });
  assert.ok(v.errors.length >= 2);
});

// ── unit: engine ────────────────────────────────────────────────────────────
test('engine: take profit, stop, hysteresis, Muse prices, expiry-day rules', () => {
  const rules = { tp_credit_pct: 50, stop_credit_mult: 1.5, tp_debit_pct: 25, stop_debit_pct: 50, gamma_from: '14:00', gamma_within_pct: 1, close_expiry_at: '15:30', clear_margin_pct: 10 };
  const pos = { symbol: 'SPX', credit_or_debit: 'credit', units: 1, entry_price: 1.0, max_profit: 100, exit: rules,
    legs: [{ action: 'sell', type: 'put', strike: 7600, expiry: '2026-10-05' }, { action: 'buy', type: 'put', strike: 7595, expiry: '2026-10-05' }] };
  const et = (hm, date = '2026-10-05') => ({ date, hm, minutes: Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), weekday: 1 });
  const m = (pnl, value = 1 - pnl / 100, underlying = 7650) => ({ stale: false, pnl, value, underlying });

  assert.equal(evaluate({ position: pos, mark: m(10), et: et('10:00') }).action, 'HOLD');
  assert.equal(evaluate({ position: pos, mark: m(50), et: et('10:00') }).action, 'TAKE_PROFIT');
  assert.equal(evaluate({ position: pos, mark: m(46), et: et('10:00'), prev: 'TAKE_PROFIT' }).action, 'TAKE_PROFIT', 'stays inside the clear margin');
  assert.equal(evaluate({ position: pos, mark: m(44), et: et('10:00'), prev: 'TAKE_PROFIT' }).action, 'HOLD');
  assert.equal(evaluate({ position: pos, mark: m(-150), et: et('10:00') }).action, 'STOP');
  assert.equal(evaluate({ position: pos, mark: m(-140), et: et('10:00') }).action, 'HOLD');
  assert.equal(evaluate({ position: pos, mark: m(-140), et: et('10:00'), prev: 'STOP' }).action, 'STOP');
  assert.equal(evaluate({ position: pos, mark: m(10, 0.9, 7605), et: et('14:10') }).action, 'ADJUST');
  assert.equal(evaluate({ position: pos, mark: m(60), et: et('15:31') }).action, 'CLOSE_EXPIRY', 'expiry close outranks take profit');
  assert.equal(evaluate({ position: pos, mark: m(-200), et: et('15:31') }).action, 'STOP', 'stop outranks everything');
  assert.equal(evaluate({ position: pos, mark: { stale: true }, et: et('10:00') }).action, 'HOLD');

  const musePos = { ...pos, exit: { ...rules, take_profit_price: 0.7, stop_price: 2.0 } };
  assert.equal(evaluate({ position: musePos, mark: m(25, 0.69), et: et('10:00') }).action, 'TAKE_PROFIT');
  assert.equal(evaluate({ position: musePos, mark: m(-101, 2.01), et: et('10:00') }).action, 'STOP');

  const debit = { ...pos, credit_or_debit: 'debit', entry_price: 2, max_profit: null };
  assert.equal(evaluate({ position: debit, mark: m(50), et: et('10:00', '2026-10-01') }).action, 'TAKE_PROFIT'); // +25% of $200
  assert.equal(evaluate({ position: debit, mark: m(-100), et: et('10:00', '2026-10-01') }).action, 'STOP');
});

// ── API flows ───────────────────────────────────────────────────────────────
test('api: auth — Muse key, owner login, CSRF header, rate limit', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  assert.equal((await ctx.call('GET', '/api/paper/status')).status, 401);
  assert.equal((await ctx.call('GET', '/api/paper/status', { 'X-API-Key': 'wrong'.repeat(8) })).status, 401);
  assert.equal((await ctx.call('GET', '/api/paper/status', ctx.muse)).status, 200);
  assert.equal((await ctx.call('GET', '/paper/api/status', ctx.owner)).status, 200);
  assert.equal((await ctx.call('POST', '/paper/api/kill-switch', { Authorization: ctx.owner.Authorization }, { on: true })).status, 403, 'owner writes need X-Requested-With');
  assert.equal((await ctx.call('POST', '/api/paper/kill-switch', ctx.muse, { on: true })).data.error.code, 'owner_only');
  assert.equal((await ctx.call('PUT', '/api/paper/settings', ctx.muse, { version: 1 })).status, 403);
  const page = await fetch(ctx.base + '/paper/');
  assert.equal(page.status, 401);
  assert.match(page.headers.get('www-authenticate') || '', /Basic/);
  assert.equal((await fetch(ctx.base + '/paper/', { headers: { Authorization: ctx.owner.Authorization } })).status, 200);

  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 1, values: { 'muse.rate_get_per_min': 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await ctx.call('GET', '/api/paper/status', ctx.muse)).status);
  assert.deepEqual(codes.slice(-2), [429, 429]);
});

test('api: idea → approve → fill → signals → close → realized P&L, with events for Muse', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const idea = await icIdea(ctx);
  const created = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  assert.equal((await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea)).status, 200, 'same client_idea_id → same idea');
  assert.equal(ctx.desk.ideas.length, 1);

  const id = created.data.id;
  assert.equal((await ctx.call('POST', `/api/paper/trade-ideas/${id}/approve`, ctx.muse, {})).status, 403, 'Muse can never approve');
  const ap = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  assert.equal(ap.status, 202, JSON.stringify(ap.data));
  assert.equal(ap.data.order.status, 'filled');
  assert.equal((await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {})).status, 409, 'cannot approve twice');

  let positions = (await ctx.call('GET', '/api/paper/positions', ctx.muse)).data;
  assert.equal(positions.length, 1);
  const pos = positions[0];
  assert.equal(pos.units, 1);
  assert.equal(pos.max_loss, Math.round((5 - pos.entry_price) * 100 * 100) / 100);
  assert.equal(pos.client_idea_id, idea.client_idea_id, "position echoes Muse's own idea id, no server-id map needed");
  assert.equal(ap.data.order.client_idea_id, idea.client_idea_id, 'orders echo it too');

  // Price drifts to the short call → engine raises STOP; Muse pushes its own signal.
  ctx.market.setSpot('SPX', 7700);
  await ctx.desk.engineTick();
  positions = (await ctx.call('GET', '/api/paper/positions', ctx.muse)).data;
  assert.equal(positions[0].badge.action, 'STOP');
  assert.equal(positions[0].badge.source, 'system');
  const sig = { client_signal_id: 'muse-1', action: 'CLOSE_EXPIRY', reason: 'get out', pnl_dollars: -200 };
  assert.equal((await ctx.call('POST', `/api/paper/positions/${pos.id}/action`, ctx.muse, sig)).status, 201);
  assert.equal((await ctx.call('POST', `/api/paper/positions/${pos.id}/action`, ctx.muse, sig)).status, 200, 'signals are idempotent too');
  assert.equal((await ctx.call('POST', `/api/paper/positions/${pos.id}/action`, ctx.muse, { action: 'SELL_ALL', reason: 'x' })).status, 422);
  positions = (await ctx.call('GET', '/api/paper/positions', ctx.muse)).data;
  assert.equal(positions[0].badge.source, 'muse', "Muse's newer signal takes the badge");

  assert.equal((await ctx.call('POST', `/api/paper/positions/${pos.id}/close-request`, ctx.muse, {})).status, 403);
  const cl = await ctx.call('POST', `/paper/api/positions/${pos.id}/close-request`, ctx.owner, { price_mode: 'natural' });
  assert.equal(cl.status, 202, JSON.stringify(cl.data));
  assert.equal(cl.data.order.price_effect, 'debit');
  const closed = (await ctx.call('GET', '/api/paper/positions?status=closed', ctx.muse)).data;
  assert.equal(closed.length, 1);
  assert.equal(closed[0].realized_pnl, Math.round((pos.entry_price - closed[0].exit_price) * 100 * 100) / 100);
  assert.ok(closed[0].realized_pnl < 0);

  const ev = (await ctx.call('GET', '/api/paper/events', ctx.muse)).data;
  const types = ev.events.map(e => e.type);
  for (const t2 of ['idea.created', 'idea.approved', 'order.submitted', 'order.filled', 'position.opened', 'signal.raised', 'position.closed']) assert.ok(types.includes(t2), t2);
  const mid = ev.events[3].id;
  const after = (await ctx.call('GET', `/api/paper/events?after=${mid}`, ctx.muse)).data;
  assert.equal(after.events[0].id, ev.events[4].id, 'cursor resumes after the given id');
  assert.equal(ctx.desk.status().realized_today, closed[0].realized_pnl);
});

test("api: Muse can pull a symbol's option chain with its own key", async t => {
  const ctx = await startApp();
  t.after(ctx.close);

  // No expiry given → defaults to the nearest listed expiration.
  const auto = await ctx.call('GET', '/api/paper/chain/AMD', ctx.muse);
  assert.equal(auto.status, 200, JSON.stringify(auto.data));
  assert.equal(auto.data.symbol, 'AMD');
  assert.ok(auto.data.expiry);
  assert.ok(auto.data.underlying > 0);
  assert.ok(Array.isArray(auto.data.contracts) && auto.data.contracts.length > 0);
  assert.ok(auto.data.contracts[0].strike > 0 && ['call', 'put'].includes(auto.data.contracts[0].type));

  // An explicit expiry + strike range narrows it.
  const exp = auto.data.expiry;
  const narrow = await ctx.call('GET', `/api/paper/chain/AMD?expiry=${exp}&strikeLow=155&strikeHigh=165`, ctx.muse);
  assert.equal(narrow.status, 200);
  assert.ok(narrow.data.contracts.every(c => c.strike >= 155 && c.strike <= 165));
  assert.ok(narrow.data.contracts.length < auto.data.contracts.length);

  // No credentials at all → unauthorized, same as every other route here.
  const anon = await ctx.call('GET', '/api/paper/chain/AMD', {});
  assert.equal(anon.status, 401);
});

test('api: invalid ideas are stored and reported; unknown symbols and bad JSON rejected', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const idea = await icIdea(ctx);
  const bad = { ...idea, client_idea_id: 'bad-1', legs: [idea.legs[1], idea.legs[0], idea.legs[2], idea.legs[3]].map((l, i) => i < 2 ? { ...l, action: l.action === 'sell' ? 'buy' : 'sell' } : l) };
  const r = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, bad);
  assert.equal(r.status, 422);
  assert.equal(r.data.idea.status, 'invalid');
  assert.ok(r.data.error.details.length);
  const nobody = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, { symbol: 'SPX' });
  assert.equal(nobody.status, 422);
  const raw = await fetch(ctx.base + '/api/paper/trade-ideas', { method: 'POST', headers: { ...ctx.muse, 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(raw.status, 400);
  const ev = (await ctx.call('GET', '/api/paper/events', ctx.muse)).data.events;
  assert.ok(ev.some(e => e.type === 'idea.invalid'));
});

test('api: an off-tick limit price is rejected, not silently rounded', async t => {
  const ctx = await startApp();
  t.after(ctx.close);

  // SPX trades in $0.05 increments under $3 — 1.28 isn't one. Muse sending
  // this should come back invalid, not get rounded into validation/risk math
  // and only rounded for the order later (the old behavior).
  const idea = await icIdea(ctx, { client_idea_id: 'tick-1', limit_price: 1.28 });
  const r = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea);
  assert.equal(r.status, 422);
  assert.equal(r.data.idea.status, 'invalid');
  assert.ok(r.data.error.details.some(e => e.field === 'limit_price' && /not a valid tick/.test(e.issue)), JSON.stringify(r.data.error.details));

  // A valid on-tick price for the same idea is accepted.
  const ok = await icIdea(ctx, { client_idea_id: 'tick-2' });
  const r2 = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, ok);
  assert.equal(r2.status, 201, JSON.stringify(r2.data));

  // A manual override at Approve is checked the same way — the tick error
  // throws before the reprice/portfolio checks even run.
  const r3 = await ctx.call('POST', `/paper/api/trade-ideas/${r2.data.id}/approve`, ctx.owner, { confirm: true, limit_price: 2.03 });
  assert.equal(r3.status, 422, JSON.stringify(r3.data));
  assert.ok(r3.data.error.details.some(e => e.field === 'limit_price' && /not a valid tick/.test(e.issue)));
});

test('api: reprice check, kill switch, portfolio limits at approve', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const idea = await icIdea(ctx, { client_idea_id: 'rp-1' });
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea)).data.id;

  ctx.market.setSpot('SPX', 7672); // mid moves well away from the limit
  let r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'reprice_required');
  assert.ok(r.data.live_mid > 0);
  const liveMid = Math.floor(r.data.live_mid * 20) / 20;

  await ctx.call('POST', '/paper/api/kill-switch', ctx.owner, { on: true, reason: 'test' });
  r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, { confirm: true });
  assert.equal(r.status, 423);
  await ctx.call('POST', '/paper/api/kill-switch', ctx.owner, { on: false });

  r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, { confirm: true, limit_price: liveMid });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.order.status, 'filled', 'approving at the new live mid fills on the scorecard');

  // Max open positions = 1 → a second approval is blocked.
  const v = ctx.settings.get().version;
  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: v, values: { 'risk.max_open_positions': 1 } });
  ctx.market.setSpot('SPX', 7650);
  const idea2 = await icIdea(ctx, { client_idea_id: 'rp-2' });
  const c2 = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea2);
  assert.equal(c2.status, 201);
  assert.ok(c2.data.validation.warnings.some(w => /will block at Approve/.test(w)), 'portfolio limits warn at creation');
  r = await ctx.call('POST', `/paper/api/trade-ideas/${c2.data.id}/approve`, ctx.owner, { confirm: true });
  assert.equal(r.status, 422);
  assert.ok(r.data.error.details.some(d => d.field === 'risk.max_open_positions'));

  // Closing still works with the kill switch on.
  await ctx.call('POST', '/paper/api/kill-switch', ctx.owner, { on: true });
  const pos = ctx.desk.positions[0];
  r = await ctx.call('POST', `/paper/api/positions/${pos.id}/close-request`, ctx.owner, { price_mode: 'mid' });
  assert.equal(r.status, 202);
});

test('api: idea time-to-live, unfilled entry timeout, working orders count as exposure', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const ideaA = await icIdea(ctx, { client_idea_id: 'ttl-a' });
  ideaA.limit_price = Math.round((ideaA.limit_price + 1) * 100) / 100; // asks far more than the live mid → never fills
  const a = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, ideaA)).data;
  const b = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, await icIdea(ctx, { client_idea_id: 'ttl-b' }))).data;
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.received_at), 15 * 60_000, '0DTE ideas live 15 min');

  const ap = await ctx.call('POST', `/paper/api/trade-ideas/${a.id}/approve`, ctx.owner, { confirm: true });
  assert.equal(ap.data.order.status, 'working');
  assert.equal(ctx.desk.status().counts.working_orders, 1);

  ctx.tc.add(16 * 60_000);
  assert.equal((await ctx.call('POST', `/paper/api/trade-ideas/${b.id}/approve`, ctx.owner, {})).status, 410);
  await ctx.desk.sync();
  const order = ctx.desk.orders.find(o => o.id === ap.data.order.id);
  assert.equal(order.status, 'cancelled', 'unfilled 0DTE entry cancelled after 10 min');
  assert.equal(ctx.desk.ideas.find(i => i.id === a.id).status, 'expired');
});

test('api: reconcile flags mismatches and closes expired positions at intrinsic value', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, await icIdea(ctx))).data.id;
  await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  const pos = ctx.desk.positions[0];

  const leg = pos.legs[0].occ;
  ctx.broker.primary.state.positions[leg].quantity += 1; // someone touched the account by hand
  await ctx.desk.sync();
  assert.ok(ctx.desk.positions[0].reconcile?.mismatch);
  assert.ok(ctx.events.items.some(e => e.type === 'reconcile.mismatch'));
  ctx.broker.primary.state.positions[leg].quantity -= 1;
  await ctx.desk.sync();
  assert.equal(ctx.desk.positions[0].reconcile, null, 'cleared once it matches again');

  ctx.market.setSpot('SPX', 7650);
  await ctx.desk.engineTick();
  ctx.tc.set('2026-10-05T16:20:00-04:00'); // after expiration: the broker drops the legs
  await ctx.desk.sync();
  const closed = ctx.desk.positions[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.close_reason, 'expired');
  assert.equal(closed.exit_price, 0, 'expired worthless between the shorts');
  assert.equal(closed.realized_pnl, Math.round(closed.entry_price * 100 * 100) / 100);
});

test('api: daily loss limit turns the kill switch on for the day', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 1, values: { 'risk.daily_loss_limit': 50 } });
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, await icIdea(ctx))).data.id;
  await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  ctx.market.setSpot('SPX', 7690);
  await ctx.call('POST', `/paper/api/positions/${ctx.desk.positions[0].id}/close-request`, ctx.owner, { price_mode: 'natural' });
  assert.ok(ctx.desk.realizedToday() <= -50);
  await ctx.desk.engineTick();
  const st = ctx.desk.status();
  assert.equal(st.kill_switch.on, true);
  assert.equal(st.kill_switch.auto, true);
  ctx.tc.set('2026-10-06T09:40:00-04:00');
  await ctx.desk.engineTick();
  assert.equal(ctx.desk.status().kill_switch.on, false, 'resets the next trading day');
});

test('api: covered structures need the shares; settings round-trip over HTTP', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const exp = '2026-10-09';
  const base = { symbol: 'SPCX', structure: 'covered_call', expiry: exp, credit_or_debit: 'credit', thesis: 't', legs: [{ action: 'sell', type: 'call', strike: 160, qty: 1 }] };
  const pc = await ctx.call('POST', '/api/paper/price-check', ctx.muse, base);
  const ok = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, { ...base, client_idea_id: 'cc-1', limit_price: Math.max(0.05, pc.data.mid) });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const two = await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, { ...base, client_idea_id: 'cc-2', limit_price: Math.max(0.05, pc.data.mid), legs: [{ ...base.legs[0], qty: 2 }] });
  assert.ok(two.data.validation.warnings.some(w => /needs 200 SPCX shares/.test(w)));
  const r = await ctx.call('POST', `/paper/api/trade-ideas/${two.data.id}/approve`, ctx.owner, { confirm: true });
  assert.equal(r.status, 422, 'blocked at approve without the shares');

  const s = (await ctx.call('GET', '/api/paper/settings?meta=1', ctx.muse)).data;
  assert.ok(s.meta.fields.length > 30);
  const up = await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: s.version, values: { 'exit.tp_credit_pct': 150 } });
  assert.equal(up.status, 422);
  assert.equal(up.data.error.details[0].field, 'exit.tp_credit_pct');
  const stale = await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 0, values: { 'exit.tp_credit_pct': 40 } });
  assert.equal(stale.status, 409);
});

// ── tastytrade paper adapter ────────────────────────────────────────────────
test('tastytrade paper adapter: refuses anything but the sandbox', () => {
  const env = { TT_PAPER_CLIENT_SECRET: 's', TT_PAPER_REFRESH_TOKEN: 'r', TT_PAPER_ACCOUNT: '5WT00001' };
  assert.throws(() => new TastytradePaperBroker({ env: { ...env, TT_PAPER_API_URL: 'https://api.tastyworks.com' } }), /only https:\/\/api\.cert\.tastyworks\.com/);
  assert.throws(() => new TastytradePaperBroker({ env: { TT_PAPER_CLIENT_SECRET: 's' } }), /TT_PAPER_REFRESH_TOKEN, TT_PAPER_ACCOUNT/);
  assert.throws(() => new TastytradePaperBroker({ env: { ...env, TASTYTRADE_REFRESH_TOKEN: 'r' } }), /same as the production/);
  assert.throws(() => new TastytradePaperBroker({ env: { ...env, TASTYTRADE_CLIENT_SECRET: 's' } }), /same as the production/);
  assert.throws(() => new TastytradePaperBroker({ env, client: { baseURL: 'https://api.tastyworks.com' } }), /refusing/);
  process.env.TASTYTRADE_CLIENT_ID = 'production-client-id';
  const b = new TastytradePaperBroker({ env });
  delete process.env.TASTYTRADE_CLIENT_ID;
  assert.equal(b.client.clientId, undefined, 'never picks up the production client id');
  assert.equal(b.client.baseURL, PAPER_HOST);
  assert.equal(b.client.scope, 'read trade');
  assert.equal(PAPER_HOST, 'https://api.cert.tastyworks.com');
});

test('tastytrade paper adapter: order JSON, status mapping, account check, safe retries', async () => {
  const env = { TT_PAPER_CLIENT_SECRET: 's', TT_PAPER_REFRESH_TOKEN: 'r', TT_PAPER_ACCOUNT: '5WT00001' };
  const calls = [];
  let failSubmit = false;
  const client = {
    baseURL: PAPER_HOST,
    async request(method, url, opts = {}) {
      calls.push({ method, url, data: opts.data });
      if (url === '/customers/me/accounts') return { data: { items: [{ account: { 'account-number': '5WT00001' } }] } };
      if (url.endsWith('/dry-run')) { const e = new Error('insufficient buying power'); e.status = 422; throw e; }
      if (method === 'post' && url.endsWith('/orders')) {
        if (failSubmit) { const e = new Error('socket hang up'); throw e; }
        return { data: { order: { id: 77, status: 'Live', 'external-identifier': opts.data['external-identifier'], legs: opts.data.legs.map(l => ({ ...l, 'remaining-quantity': l.quantity, fills: [] })) } } };
      }
      if (url.endsWith('/orders/live')) return { data: { items: [{ id: 78, status: 'Live', 'external-identifier': 'idea_retry', legs: [{ symbol: 'X', quantity: 1, 'remaining-quantity': 1, action: 'Sell to Open' }] }] } };
      throw new Error('unexpected ' + url);
    },
  };
  const b = new TastytradePaperBroker({ env, client });
  await b.init();
  const order = { externalId: 'idea_1', limitPrice: 1.25, priceEffect: 'credit', legs: [{ occSymbol: 'SPXW  261005P07600000', side: 'STO', quantity: 1 }, { occSymbol: 'SPXW  261005P07595000', side: 'BTO', quantity: 1 }] };
  const body = b.toTastyOrder(order);
  assert.deepEqual(body, {
    'time-in-force': 'Day', 'order-type': 'Limit', price: 1.25, 'price-effect': 'Credit', 'external-identifier': 'idea_1',
    legs: [{ 'instrument-type': 'Equity Option', symbol: 'SPXW  261005P07600000', quantity: 1, action: 'Sell to Open' }, { 'instrument-type': 'Equity Option', symbol: 'SPXW  261005P07595000', quantity: 1, action: 'Buy to Open' }],
  });
  const signed = new TastytradePaperBroker({ env: { ...env, TT_PAPER_PRICE_STYLE: 'signed' }, client });
  assert.equal(signed.toTastyOrder({ ...order, priceEffect: 'debit' }).price, -1.25);
  assert.equal(signed.toTastyOrder(order)['price-effect'], undefined);

  const dry = await b.dryRun(order);
  assert.equal(dry.ok, false);
  assert.match(dry.warnings[0], /buying power/);
  const placed = await b.submitOrder(order);
  assert.equal(placed.brokerOrderId, '77');
  assert.equal(placed.status, 'working');
  assert.ok(calls.every(c => !/^https?:/.test(c.url)), 'only relative paths on the paper client');

  failSubmit = true;
  const recovered = await b.submitOrder({ ...order, externalId: 'idea_retry' });
  assert.equal(recovered.brokerOrderId, '78', 'a timed-out submit is found by external id, not resent');

  const partial = fromTastyOrder({ id: 5, status: 'Live', price: '1.20', legs: [
    { symbol: 'A', action: 'Sell to Open', quantity: 2, 'remaining-quantity': 1, fills: [{ quantity: 1, 'fill-price': '3.00' }] },
    { symbol: 'B', action: 'Buy to Open', quantity: 2, 'remaining-quantity': 1, fills: [{ quantity: 1, 'fill-price': '1.80' }] },
  ] });
  assert.equal(partial.status, 'partially_filled');
  assert.equal(partial.filledQuantity, 1);
  assert.equal(partial.avgFillPrice, 1.2);
  assert.equal(fromTastyOrder({ id: 6, status: 'Filled', price: '1.1', legs: [{ symbol: 'A', quantity: 1, 'remaining-quantity': 0 }] }).filledQuantity, 1);
  assert.equal(fromTastyOrder({ id: 7, status: 'Rejected', legs: [] }).status, 'rejected');
});

// ── live-market scorecard ───────────────────────────────────────────────────
test('scorecard: fills only when the live price reaches the limit, during market hours', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const idea = await icIdea(ctx, { client_idea_id: 'sc-1' });
  const asked = Math.round((idea.limit_price + 0.3) * 20) / 20; // above the live mid
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea)).data.id;
  let r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, { confirm: true, limit_price: asked });
  assert.equal(r.data.order.status, 'working', 'not marketable yet');

  // The market moves toward a short strike → the condor is worth more → the credit is now available.
  ctx.market.setSpot('SPX', 7678);
  await ctx.desk.sync();
  const order = ctx.desk.orders.find(o => o.id === r.data.order.id);
  assert.equal(order.status, 'filled');
  assert.equal(order.avg_fill_price, asked, 'fills at the limit, never better');
  assert.ok(order.fill_context.mid >= asked, 'records the live mid that triggered the fill');
  assert.ok(order.fill_context.natural <= order.fill_context.mid);
});

test('scorecard: nothing fills outside market hours; day orders expire at 4 PM; natural model is stricter', async t => {
  const ctx = await startApp({ at: '2026-10-05T09:20:00-04:00' }); // before the open
  t.after(ctx.close);
  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 1, modes: { 'entry.window': 'off' } });
  const idea = await icIdea(ctx, { client_idea_id: 'sc-pre' });
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea)).data.id;
  let r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  assert.equal(r.data.order.status, 'working', 'pre-market: quotes are stale, no fill');
  ctx.tc.set('2026-10-05T09:31:00-04:00');
  await ctx.desk.sync();
  assert.equal(ctx.desk.orders[0].status, 'filled', 'fills once the market opens');

  // Natural model: the same marketable-at-mid limit no longer fills.
  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 2, values: { 'fills.model': 'natural' } });
  const idea2 = await icIdea(ctx, { client_idea_id: 'sc-nat' });
  const id2 = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea2)).data.id;
  r = await ctx.call('POST', `/paper/api/trade-ideas/${id2}/approve`, ctx.owner, {});
  assert.equal(r.data.order.status, 'working', 'mid-priced limit does not fill at the natural price');

  ctx.tc.set('2026-10-05T16:01:00-04:00');
  await ctx.desk.sync();
  assert.equal(ctx.desk.orders.find(o => o.id === r.data.order.id).status, 'expired', 'Day order expires at the close');
});

test('app: refuses simulated data at runtime', () => {
  assert.throws(() => createPaperApp({ env: { ...ENV, PAPER_SIM_TIME: '2026-10-05T10:00:00-04:00' }, dataDir: tmpDir() }), /live market data only/);
  assert.throws(() => createPaperApp({ env: { ...ENV, PAPER_MARKET_DATA: 'fake' }, dataDir: tmpDir() }), /live market data only/);
  assert.throws(() => createPaperApp({ env: { ...ENV, PAPER_MARKET_DATA: 'random' }, dataDir: tmpDir() }), /tastytrade or tradeforge/);
});

// ── tastytrade paper-account mirror ─────────────────────────────────────────
// A fake sandbox that follows tastytrade's published rules: limits under $3 fill
// at once, $3 and up stay Live, and a reset wipes every order.
function fakeSandbox() {
  const sb = { orders: new Map(), seq: 100, down: false, submits: 0, cancels: 0 };
  sb.client = {
    baseURL: PAPER_HOST,
    async request(method, url, opts = {}) {
      if (sb.down) { const e = new Error('connect ETIMEDOUT'); throw e; }
      if (url === '/customers/me/accounts') return { data: { items: [{ account: { 'account-number': '5WT00001' } }] } };
      if (url.endsWith('/dry-run')) return { data: { 'buying-power-effect': { 'change-in-buying-power': '-400' }, 'fee-calculation': { 'total-fees': '1.00' } } };
      if (url.endsWith('/balances')) return { data: { 'net-liquidating-value': '100000', 'cash-balance': '100000' } };
      if (method === 'post' && url.endsWith('/orders')) {
        sb.submits++;
        const d = opts.data, id = ++sb.seq, price = Number(d.price);
        const filled = price < 3;
        const o = { id, status: filled ? 'Filled' : 'Live', price: d.price, 'external-identifier': d['external-identifier'],
          legs: d.legs.map(l => ({ ...l, 'remaining-quantity': filled ? 0 : l.quantity, fills: filled ? [{ quantity: l.quantity, 'fill-price': String(l.action.startsWith('Sell') ? price : 0) }] : [] })) };
        sb.orders.set(String(id), o);
        return { data: { order: o } };
      }
      if (url.endsWith('/orders/live')) return { data: { items: [...sb.orders.values()] } };
      const m = url.match(/\/orders\/(\d+)$/);
      if (m && method === 'get') { const o = sb.orders.get(m[1]); if (!o) { const e = new Error('not found'); e.status = 404; throw e; } return { data: o }; }
      if (m && method === 'delete') { sb.cancels++; const o = sb.orders.get(m[1]); o.status = 'Cancelled'; return { data: o }; }
      throw new Error('unexpected ' + method + ' ' + url);
    },
  };
  return sb;
}

function mirroredFactory(sb) {
  const { ScorecardBroker } = require('../src/paper/broker/scorecard');
  const { MirroredBroker } = require('../src/paper/broker/mirrored');
  return ({ clock, market, dir }) => {
    const store = new Store(dir);
    const primary = new ScorecardBroker({ store, clock, market, fillModel: () => 'mid', shares: 'SPCX:100' });
    const mirror = new TastytradePaperBroker({ env: { TT_PAPER_CLIENT_SECRET: 's', TT_PAPER_REFRESH_TOKEN: 'r', TT_PAPER_ACCOUNT: '5WT00001' }, client: sb.client });
    return new MirroredBroker({ primary, mirror, store, clock });
  };
}

test('mirror: every order goes to the paper account; the scorecard stays the source of truth', async t => {
  const sb = fakeSandbox();
  const ctx = await startApp({ broker: mirroredFactory(sb) });
  t.after(ctx.close);
  await ctx.broker.init();

  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, await icIdea(ctx, { client_idea_id: 'm-1' }))).data.id;
  const ap = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, {});
  assert.equal(ap.data.order.status, 'filled', 'scorecard fill from live prices');
  assert.equal(ap.data.order.mirror.status, 'filled', 'sandbox fills a sub-$3 limit at once');
  assert.ok(ap.data.order.mirror.broker_order_id);
  assert.equal(sb.submits, 1);

  const st = (await ctx.call('GET', '/api/paper/status', ctx.muse)).data;
  assert.equal(st.version, require('../package.json').version.split('.').slice(0, 2).join('.'), 'status carries the MAJOR.MINOR release');
  assert.equal(st.mirror.name, 'tastytrade-paper');
  assert.equal(st.mirror.account, '5WT00001');
  assert.equal(st.mirror.ok, true);

  // Close: mirrored because the entry filled in the paper account.
  const pos = ctx.desk.positions[0];
  const cl = await ctx.call('POST', `/paper/api/positions/${pos.id}/close-request`, ctx.owner, { price_mode: 'mid' });
  assert.equal(cl.status, 202);
  assert.ok(['filled', 'working'].includes(cl.data.order.mirror.status));
  assert.equal(sb.submits, 2);
  assert.equal(ctx.desk.positions[0].status, 'closed', 'scorecard closed the position');
});

test('mirror: sandbox down, $3+ orders that never fill, closes skipped, daily reset', async t => {
  const sb = fakeSandbox();
  const ctx = await startApp({ broker: mirroredFactory(sb) });
  t.after(ctx.close);
  await ctx.broker.init();

  // $3+ debit (AMD diagonal): the sandbox leaves it Live forever; the scorecard fills from live prices.
  const exp1 = '2026-10-08', exp2 = '2026-10-15';
  const legs = [{ action: 'buy', type: 'call', strike: 160, qty: 1, expiry: exp2 }, { action: 'sell', type: 'call', strike: 165, qty: 1 }];
  const pc = await ctx.call('POST', '/api/paper/price-check', ctx.muse, { symbol: 'AMD', expiry: exp1, credit_or_debit: 'debit', structure: 'diagonal', legs });
  const limit = Math.ceil(pc.data.mid * 100) / 100;
  assert.ok(limit >= 3, `diagonal costs ${limit}`);
  const di = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, { client_idea_id: 'm-diag', symbol: 'AMD', structure: 'diagonal', expiry: exp1, legs, limit_price: limit, credit_or_debit: 'debit', thesis: 't' })).data;
  let r = await ctx.call('POST', `/paper/api/trade-ideas/${di.id}/approve`, ctx.owner, {});
  assert.equal(r.data.order.status, 'filled');
  assert.equal(r.data.order.mirror.status, 'working', 'sandbox never fills $3+ limits');

  // Closing it: not mirrored, because the paper account never held it.
  const pos = ctx.desk.positions.find(p => p.symbol === 'AMD');
  r = await ctx.call('POST', `/paper/api/positions/${pos.id}/close-request`, ctx.owner, { price_mode: 'mid' });
  assert.equal(r.data.order.mirror.status, 'skipped');
  assert.match(r.data.order.mirror.error, /working in the paper account/);

  // Sandbox reset: the working entry order disappears from the paper account.
  sb.orders.clear();
  await ctx.desk.sync();
  const entry = ctx.desk.orders.find(o => o.idea_id === di.id && o.kind === 'entry');
  assert.equal(ctx.desk.viewOrder(entry).mirror.status, 'expired');
  assert.match(ctx.desk.viewOrder(entry).mirror.error, /sandbox reset/);

  // Sandbox unreachable: the scorecard still trades; the mirror records the error.
  sb.down = true;
  const ic = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, await icIdea(ctx, { client_idea_id: 'm-down' }))).data;
  r = await ctx.call('POST', `/paper/api/trade-ideas/${ic.id}/approve`, ctx.owner, {});
  assert.equal(r.status, 202);
  assert.equal(r.data.order.status, 'filled', 'scorecard unaffected');
  assert.equal(r.data.order.mirror.status, 'rejected');
  assert.equal((await ctx.call('GET', '/api/paper/status', ctx.muse)).data.mirror.ok, false);
});

test('mirror: cancelling a working order cancels its paper-account copy', async t => {
  const sb = fakeSandbox();
  const ctx = await startApp({ broker: mirroredFactory(sb) });
  t.after(ctx.close);
  await ctx.broker.init();
  const idea = await icIdea(ctx, { client_idea_id: 'm-cxl' });
  const id = (await ctx.call('POST', '/api/paper/trade-ideas', ctx.muse, idea)).data.id;
  const r = await ctx.call('POST', `/paper/api/trade-ideas/${id}/approve`, ctx.owner, { confirm: true, limit_price: 3.5 }); // $3+ → Live in the sandbox, too rich for the scorecard
  assert.equal(r.data.order.status, 'working');
  assert.equal(r.data.order.mirror.status, 'working');
  const c = await ctx.call('POST', `/paper/api/orders/${r.data.order.id}/cancel`, ctx.owner);
  assert.equal(c.data.status, 'cancelled');
  assert.equal(c.data.mirror.status, 'cancelled');
  assert.equal(sb.cancels, 1);
});

// ── Build tab ────────────────────────────────────────────────────────────────
test('api: Build tab — /build/price reuses the same risk math as approve, owner-only', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const legs = [
    { action: 'sell', type: 'put', strike: 7615 }, { action: 'buy', type: 'put', strike: 7610 },
    { action: 'sell', type: 'call', strike: 7685 }, { action: 'buy', type: 'call', strike: 7690 },
  ];
  const body = { symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', credit_or_debit: 'credit', legs };
  assert.equal((await ctx.call('POST', '/api/paper/build/price', ctx.muse, body)).status, 403, 'Muse cannot use the Build tab');

  const r = await ctx.call('POST', '/paper/api/build/price', ctx.owner, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.symbol, 'SPX');
  assert.equal(r.data.underlying, 7650);
  assert.equal(r.data.legs.length, 4);
  assert.ok(r.data.legs.every(l => l.mid > 0 && l.iv > 0 && l.occ), 'every leg carries a live quote, ready to submit');
  assert.equal(r.data.risk.defined, true);
  assert.equal(r.data.risk.max_loss, Math.round((5 - r.data.entry.mid) * 100 * 100) / 100);

  // The same two legs as a "custom" structure must agree exactly with the named bull_put_spread
  // formula on everything economic — "width" is the one field the generic math doesn't report.
  const vertical = { symbol: 'SPX', structure: 'custom', expiry: '2026-10-05', credit_or_debit: 'credit', legs: legs.slice(0, 2) };
  const rc = await ctx.call('POST', '/paper/api/build/price', ctx.owner, vertical);
  const named = await ctx.call('POST', '/paper/api/build/price', ctx.owner, { ...vertical, structure: 'bull_put_spread' });
  assert.equal(rc.status, 200, JSON.stringify(rc.data));
  assert.equal(rc.data.risk.width, null);
  const { width: _w, ...customEconomics } = rc.data.risk;
  const { width: _w2, ...namedEconomics } = named.data.risk;
  assert.deepEqual(customEconomics, namedEconomics);
});

test('api: Build tab — submit to Trade Ideas vs direct to broker', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const legs = [
    { action: 'sell', type: 'put', strike: 7615 }, { action: 'buy', type: 'put', strike: 7610 },
    { action: 'sell', type: 'call', strike: 7685 }, { action: 'buy', type: 'call', strike: 7690 },
  ];
  const priced = await ctx.call('POST', '/paper/api/build/price', ctx.owner, { symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', credit_or_debit: 'credit', legs });
  const limit = Math.floor(priced.data.entry.mid * 20) / 20;
  const base = { symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', credit_or_debit: 'credit', legs, limit_price: limit, quantity: 1, thesis: 'test build' };

  const toIdeas = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, { ...base, destination: 'ideas' });
  assert.equal(toIdeas.status, 201, JSON.stringify(toIdeas.data));
  assert.equal(toIdeas.data.idea.status, 'pending', 'queued for review, nothing sent to the broker yet');
  assert.equal(toIdeas.data.idea.source, 'owner');
  assert.equal((await ctx.call('GET', '/paper/api/orders', ctx.owner)).data.length, 0);

  const toBroker = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, { ...base, destination: 'broker' });
  assert.equal(toBroker.status, 202, JSON.stringify(toBroker.data));
  assert.equal(toBroker.data.idea.status, 'approved', 'direct-to-broker auto-approves the idea it just created');
  assert.equal(toBroker.data.order.status, 'filled');

  assert.equal((await ctx.call('POST', '/api/paper/build/submit', ctx.muse, { symbol: 'SPX' })).status, 403, 'Muse cannot submit from Build');
});

test('api: Build tab — a custom structure\'s risk is computed, not assumed: a naked short call is undefined risk', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  await ctx.call('PUT', '/paper/api/settings', ctx.owner, { version: 1, values: { 'risk.allow_undefined_risk': false } });
  const r = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, {
    symbol: 'SPX', structure: 'custom', expiry: '2026-10-05', credit_or_debit: 'credit',
    legs: [{ action: 'sell', type: 'call', strike: 7685 }],
    limit_price: 2, quantity: 1, thesis: 'naked call', destination: 'ideas',
  });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.ok(r.data.idea.validation.errors.some(e => /undefined risk/.test(e.issue)));
});

test('api: Build tab — butterfly: priced like the textbook formula, must be symmetric around one body strike and debit', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  // Long call butterfly: buy 7630, sell 7650 x2, buy 7670 — one strike (7650)
  // sold twice, same pattern a real butterfly order ticket uses.
  const legs = [
    { action: 'buy', type: 'call', strike: 7630 }, { action: 'sell', type: 'call', strike: 7650 },
    { action: 'sell', type: 'call', strike: 7650 }, { action: 'buy', type: 'call', strike: 7670 },
  ];
  const priced = await ctx.call('POST', '/paper/api/build/price', ctx.owner, { symbol: 'SPX', structure: 'butterfly', expiry: '2026-10-05', credit_or_debit: 'debit', legs });
  assert.equal(priced.status, 200, JSON.stringify(priced.data));
  assert.equal(priced.data.risk.defined, true);
  assert.equal(priced.data.risk.breakevens.length, 2, 'a butterfly has two breakevens, one on each side of the body');
  const debit = priced.data.entry.mid;
  assert.ok(debit > 0 && debit < 20, 'a long butterfly is entered for a debit');
  assert.equal(priced.data.risk.max_loss, Math.round(debit * 100 * 100) / 100, 'max loss is exactly the debit paid');
  assert.equal(priced.data.risk.max_profit, Math.round((20 - debit) * 100 * 100) / 100, 'max profit is the wing width minus the debit');

  const limit = roundToTick('SPX', debit, 'down');
  const base = { symbol: 'SPX', structure: 'butterfly', expiry: '2026-10-05', legs, limit_price: limit, quantity: 1, thesis: 'test butterfly', destination: 'ideas' };

  // A butterfly submitted as a credit is rejected — same direction rule as the named debit structures.
  const asCredit = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, { ...base, credit_or_debit: 'credit' });
  assert.equal(asCredit.status, 422, JSON.stringify(asCredit.data));
  assert.ok(asCredit.data.idea.validation.errors.some(e => /debit trade/.test(e.issue)));

  // Mismatched body strikes (the two "sell" legs at different strikes) are rejected too.
  const lopsided = legs.map((l, i) => (i === 2 ? { ...l, strike: 7655 } : l));
  const badBody = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, { ...base, credit_or_debit: 'debit', legs: lopsided });
  assert.equal(badBody.status, 422, JSON.stringify(badBody.data));
  assert.ok(badBody.data.idea.validation.errors.some(e => /same \(body\) strike/.test(e.issue)));

  // The correct shape, as a debit, goes through to Trade Ideas.
  const ok = await ctx.call('POST', '/paper/api/build/submit', ctx.owner, { ...base, credit_or_debit: 'debit' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.idea.status, 'pending');
});

test('api: Build tab — templates (reusable shape) and drafts (concrete saved order)', async t => {
  const ctx = await startApp();
  t.after(ctx.close);
  const legs = [
    { action: 'sell', type: 'put', strike: 7615 }, { action: 'buy', type: 'put', strike: 7610 },
    { action: 'sell', type: 'call', strike: 7685 }, { action: 'buy', type: 'call', strike: 7690 },
  ];

  const tpl = await ctx.call('POST', '/paper/api/build/templates', ctx.owner, {
    name: 'My 0DTE condor', symbol: 'SPX', structure: 'iron_condor', credit_or_debit: 'credit', underlying: 7650, legs,
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  assert.equal(tpl.data.legs[0].strike_offset, -35, 'strike stored as an offset from spot, not a fixed number');
  assert.equal((await ctx.call('GET', '/paper/api/build/templates', ctx.owner)).data.length, 1);
  assert.equal((await ctx.call('DELETE', `/paper/api/build/templates/${tpl.data.id}`, ctx.owner)).status, 200);
  assert.equal((await ctx.call('GET', '/paper/api/build/templates', ctx.owner)).data.length, 0);

  const draft = await ctx.call('POST', '/paper/api/build/drafts', ctx.owner, {
    name: 'Maybe later', symbol: 'SPX', structure: 'iron_condor', expiry: '2026-10-05', credit_or_debit: 'credit',
    legs, limit_price: 1.5, quantity: 1, thesis: 'parked for now',
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.legs[0].strike, 7615, 'draft keeps the concrete strike, not an offset');
  assert.equal((await ctx.call('GET', '/paper/api/build/drafts', ctx.owner)).data.length, 1);
  assert.equal((await ctx.call('DELETE', `/paper/api/build/drafts/${draft.data.id}`, ctx.owner)).status, 200);
  assert.equal((await ctx.call('GET', '/paper/api/build/drafts', ctx.owner)).data.length, 0);

  assert.equal((await ctx.call('GET', '/api/paper/build/templates', ctx.muse)).status, 403, 'Muse cannot read Build templates or drafts');
  assert.equal((await ctx.call('GET', '/api/paper/build/drafts', ctx.muse)).status, 403);
});
