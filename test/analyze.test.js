// test/analyze.test.js — offline test for the Analyze API (GEX + Chain tabs).
// Same fake tastytrade REST + DXLink server as test/tastytrade.test.js; no
// network, no credentials.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { TastyClient } = require('../src/tastytrade/client');
const { TastyMarketData } = require('../src/tastytrade/hub');
const { makeAnalyzeRouter } = require('../src/analyze/routes');
const { startFakes, today } = require('./helpers/fake-tastytrade');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('analyze API: quote, expirations, chain and gex over a real hub (fake tastytrade)', async (t) => {
  const fakes = await startFakes();
  const client = new TastyClient({ baseURL: fakes.base, clientSecret: 'cs-test', refreshToken: 'rt-test' });
  const hub = new TastyMarketData({ client });
  const market = { name: 'tastytrade', hub };

  const app = express();
  app.use('/api/analyze', makeAnalyzeRouter({ market }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { hub.stop(); fakes.close(); server.close(); });

  const get = async (path) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json() };
  };

  const q = await get('/api/analyze/quote/SPX');
  assert.equal(q.status, 200);
  assert.equal(q.body.symbol, 'SPX');
  assert.ok(q.body.last > 0);

  const exp = await get('/api/analyze/expirations/SPX');
  assert.equal(exp.status, 200);
  assert.ok(exp.body.expirations.length >= 2);
  const expiry = exp.body.expirations[0].expirationDate;
  assert.equal(expiry, today);

  const chain = await get(`/api/analyze/chain/SPX?expiry=${expiry}&strikes=400`);
  assert.equal(chain.status, 200);
  assert.ok(chain.body.strikes.length > 50);
  assert.ok(chain.body.underlying > 0);
  const row = chain.body.strikes.find(r => r.strike === 7650);
  assert.ok(row.call && row.put, 'both sides present at an ATM strike');
  assert.ok(row.call.oi > 0 && row.call.delta > 0);

  const gex = await get(`/api/analyze/gex/SPX?expiry=${expiry}`);
  assert.equal(gex.status, 200);
  assert.equal(gex.body.symbol, 'SPX');
  assert.ok(Array.isArray(gex.body.byStrike) && gex.body.byStrike.length > 0, 'per-strike GEX profile is exposed');
  assert.ok(gex.body.byStrike.every(r => 'callGEX' in r && 'putGEX' in r && 'strike' in r));
  assert.ok(['Positive', 'Negative'].includes(gex.body.regime));
  assert.ok(gex.body.flip > 0);
});

test('analyze API: 501 when there is no live tastytrade hub (e.g. PAPER_MARKET_DATA=tradeforge)', async () => {
  const app = express();
  app.use('/api/analyze', makeAnalyzeRouter({ market: { name: 'tradeforge', hub: null } }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/analyze/quote/SPX`);
  assert.equal(r.status, 501);
  server.close();
});
