// Offline test for the tastytrade market-data layer.
// Spins up a fake tastytrade REST API + fake DXLink WebSocket on localhost,
// then drives the real TastyClient → DXLinkClient → TastyMarketData hub and
// feeds the result through the existing src/gex.js.
//
//   npm test
//
// No credentials, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { TastyClient, normalizeNestedChain } = require('../src/tastytrade/client');
const { DXLinkClient } = require('../src/tastytrade/dxlink');
const { TastyMarketData, parseSymbol } = require('../src/tastytrade/hub');
const { computeGexSnapshot } = require('../src/gex');

const { startFakes, occ, today, tomorrow, SPOT } = require('./helpers/fake-tastytrade');

test('normalizeNestedChain handles both payload layouts', () => {
  const flat = normalizeNestedChain({ data: { items: [{ 'root-symbol': 'AAPL', expirations: [{ 'expiration-date': '2030-01-18', 'days-to-expiration': 5, strikes: [{ 'strike-price': '150.0', call: 'AAPL  300118C00150000', 'call-streamer-symbol': '.AAPL300118C150', put: 'AAPL  300118P00150000', 'put-streamer-symbol': '.AAPL300118P150' }] }] }] } });
  const nested = normalizeNestedChain({ data: [{ 'root-symbol': 'AAPL', items: [{ expirations: [{ 'expiration-date': '2030-01-18', 'days-to-expiration': 5, strikes: [{ 'strike-price': 150, call: { 'call-streamer-symbol': '.AAPL300118C150' }, put: { 'put-streamer-symbol': '.AAPL300118P150' } }] }] }] }] });
  for (const c of [flat, nested]) {
    assert.equal(c.length, 1);
    assert.equal(c[0].root, 'AAPL');
    assert.equal(c[0].strikes[0].strike, 150);
    assert.equal(c[0].strikes[0].callStreamer, '.AAPL300118C150');
    assert.equal(c[0].strikes[0].putStreamer, '.AAPL300118P150');
  }
});

test('parseSymbol maps Schwab-style symbols', () => {
  assert.deepEqual([parseSymbol('$SPX').kind, parseSymbol('$SPX').dx], ['index', 'SPX']);
  assert.equal(parseSymbol('SPX').kind, 'index');
  assert.equal(parseSymbol('SPY').kind, 'equity');
  assert.equal(parseSymbol('/ESZ26').rest, '/ESZ6');
  assert.equal(parseSymbol('SPXW  261002C07650000').kind, 'option');
});

test('end to end: Schwab-shaped quotes, expirations and chain feed gex.js', async (t) => {
  const fakes = await startFakes();
  const client = new TastyClient({ baseURL: fakes.base, clientSecret: 'cs-test', refreshToken: 'rt-test' });
  const hub = new TastyMarketData({ client });
  t.after(() => { hub.stop(); fakes.close(); });

  // Quotes (REST first time) — also proves 401 → re-auth and repeated-key params
  const q = await hub.getQuotes(['$SPX', 'SPY']);
  assert.ok(fakes.seen.tokenCalls >= 2, 'client should re-auth after a 401');
  assert.match(fakes.seen.byTypeQuery, /index=SPX/);
  assert.match(fakes.seen.byTypeQuery, /equity=SPY/);
  assert.equal(q.$SPX.quote.lastPrice, SPOT);
  assert.equal(q.$SPX.assetMainType, 'INDEX');
  assert.equal(q.$SPX.quote.closePrice, 7629.8);
  assert.ok(Math.abs(q.$SPX.quote.netChange - 18.4) < 1e-6);
  assert.equal(q.SPY.quote.mark, 763.1);
  assert.ok([...fakes.seen.ua].every(ua => ua === 'tradeforge/1.0'), 'every request carries the User-Agent');

  // Expirations: expired AM root dropped, dates sorted, Schwab keys
  const exp = await hub.getExpirationChain('$SPX');
  assert.deepEqual(exp.expirationList.map(e => e.expirationDate), [today, tomorrow]);
  assert.equal(exp.expirationList[0].daysToExpiration, 0);
  assert.equal(exp.expirationList[0].settlementType, 'P');

  // Chain: default = nearest expiry only, 60 nearest strikes, both sides
  const chain = await hub.getOptionsChain('$SPX', { strikeCount: 60 });
  assert.equal(chain.status, 'SUCCESS');
  assert.equal(chain.source, 'tastytrade');
  assert.equal(chain.underlyingPrice, SPOT);
  const keys = Object.keys(chain.callExpDateMap);
  assert.deepEqual(keys, [`${today}:0`]);
  const strikes = Object.keys(chain.callExpDateMap[keys[0]]);
  assert.equal(strikes.length, 60);
  assert.ok(strikes.includes('7650.0'), 'strike keys use Schwab "7650.0" format');
  const c = chain.callExpDateMap[keys[0]]['7650.0'][0];
  assert.equal(c.putCall, 'CALL');
  assert.equal(c.symbol, occ('SPXW', today, 'C', 7650));
  assert.ok(c.gamma > 0 && c.delta > 0 && c.delta < 1);
  assert.ok(c.volatility > 5 && c.volatility < 50, 'IV is in percent like Schwab');
  assert.ok(c.openInterest > 0);
  assert.ok(c.bid > 0 && c.ask > c.bid);
  assert.equal(chain.dataQuality.contracts, 120);
  assert.equal(chain.dataQuality.withGreeks, 120);
  assert.equal(chain.dataQuality.withOI, 120);
  assert.equal(chain.dataQuality.filled, true);

  // Second request is served from memory (no new option subscriptions)
  const subsBefore = fakes.seen.subs.length;
  const t0 = Date.now();
  await hub.getOptionsChain('$SPX', { strikeCount: 60 });
  assert.equal(fakes.seen.subs.length, subsBefore);
  assert.ok(Date.now() - t0 < 200, 'cached chain should be near-instant');

  // Explicit date range picks the right expiry; CALL-only works
  const t1 = await hub.getOptionsChain('SPX', { strikeCount: 10, fromDate: tomorrow, toDate: tomorrow, contractType: 'CALL' });
  assert.deepEqual(Object.keys(t1.callExpDateMap), [`${tomorrow}:1`]);
  assert.deepEqual(t1.putExpDateMap, {});

  // The existing GEX math runs unchanged on the tastytrade chain
  const snap = computeGexSnapshot(chain);
  assert.ok(snap, 'gex snapshot computed');
  assert.equal(snap.expDate, today);
  assert.equal(snap.hasOI, true);
  assert.equal(snap.callWall, 7700);
  assert.equal(snap.putWall, 7600);
  assert.ok(['Positive', 'Negative'].includes(snap.regime));
  assert.ok(snap.expectedMove > 0);

  // Quotes now come from the live stream (no REST call)
  await new Promise(r => setTimeout(r, 100));
  const before = fakes.seen.byTypeQuery;
  fakes.seen.byTypeQuery = null;
  const q2 = await hub.getQuotes('$SPX');
  assert.equal(fakes.seen.byTypeQuery, null, 'second $SPX quote should come from DXLink');
  assert.equal(q2.$SPX.source, 'tastytrade-stream');
  assert.equal(q2.$SPX.quote.lastPrice, SPOT);
  fakes.seen.byTypeQuery = before;

  const st = hub.status();
  assert.equal(st.stream, 'ready');
  assert.ok(st.optionContracts >= 120);
});

test('DXLink client reconnects and replays subscriptions', async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  const replayed = [];
  wss.on('connection', ws => {
    connections++;
    ws.on('message', buf => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'SETUP') ws.send(JSON.stringify({ type: 'AUTH_STATE', state: 'UNAUTHORIZED' }));
      if (m.type === 'AUTH') ws.send(JSON.stringify({ type: 'AUTH_STATE', state: 'AUTHORIZED' }));
      if (m.type === 'CHANNEL_REQUEST') ws.send(JSON.stringify({ type: 'CHANNEL_OPENED', channel: m.channel }));
      if (m.type === 'FEED_SETUP') ws.send(JSON.stringify({ type: 'FEED_CONFIG', channel: m.channel, eventFields: m.acceptEventFields }));
      if (m.type === 'FEED_SUBSCRIPTION') {
        if (connections === 1) setTimeout(() => ws.terminate(), 20); // drop the first connection
        else replayed.push(...(m.add || []));
      }
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const dx = new DXLinkClient(async () => ({ token: 't', url }));
  t.after(() => { dx.stop(); wss.close(); });
  await dx.whenReady(5000);
  dx.subscribe([{ type: 'Trade', symbol: 'SPX' }, { type: 'Quote', symbol: 'SPY' }]);
  await new Promise(r => setTimeout(r, 2500));
  assert.ok(connections >= 2, 'should have reconnected');
  assert.deepEqual(replayed.map(s => s.symbol).sort(), ['SPX', 'SPY']);
  assert.equal(dx.state, 'ready');
});
