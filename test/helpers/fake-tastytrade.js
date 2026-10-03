// test/helpers/fake-tastytrade.js — local stand-ins for the tastytrade REST
// API and the DXLink WebSocket, used by the offline tests.

const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer } = require('ws');

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const tomorrow = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const SPOT = 7648.2;

function occ(root, date, side, strike) {
  const [y, m, d] = date.split('-');
  return `${root.padEnd(6)}${y.slice(2)}${m}${d}${side}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}
function streamer(root, date, side, strike) {
  const [y, m, d] = date.split('-');
  return `.${root}${y.slice(2)}${m}${d}${side}${strike}`;
}
function strikesFor(root, date) {
  const out = [];
  for (let k = 7400; k <= 7900; k += 5) {
    out.push({
      'strike-price': k.toFixed(1),
      call: occ(root, date, 'C', k), 'call-streamer-symbol': streamer(root, date, 'C', k),
      put: occ(root, date, 'P', k), 'put-streamer-symbol': streamer(root, date, 'P', k),
    });
  }
  return out;
}

// Deterministic fake option data from a streamer symbol.
function fakeOption(sym) {
  const m = sym.match(/([CP])(\d+(?:\.\d+)?)$/);
  const side = m[1], K = Number(m[2]);
  const x = (SPOT - K) / 11;
  const cd = 1 / (1 + Math.exp(-x));
  const delta = side === 'C' ? cd : cd - 1;
  const gamma = cd * (1 - cd) / 11 * 0.9;
  const dist = Math.abs(K - SPOT);
  const tv = 6.2 * Math.exp(-(dist * dist) / (2 * 22 * 22)) + 0.08;
  const mark = Math.max(side === 'C' ? SPOT - K : K - SPOT, 0) + tv;
  const oi = Math.round((K % 50 === 0 ? 3000 : 900) * Math.exp(-dist / 80)) + (K === 7700 && side === 'C' ? 6000 : 0) + (K === 7600 && side === 'P' ? 6000 : 0);
  return { delta, gamma, iv: 0.142 + dist * 0.0006, bid: Math.max(0.05, mark - 0.1), ask: mark + 0.1, oi, vol: Math.round(oi * 0.8), price: mark };
}

function startFakes() {
  const seen = { ua: new Set(), byTypeQuery: null, tokenCalls: 0, rejectedOnce: false, subs: [] };
  let wsUrl;

  const server = http.createServer((req, res) => {
    seen.ua.add(req.headers['user-agent']);
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b);
        assert.equal(body.grant_type, 'refresh_token');
        assert.equal(body.refresh_token, 'rt-test');
        seen.tokenCalls++;
        send(200, { access_token: `at-${seen.tokenCalls}`, token_type: 'Bearer', expires_in: 900 });
      });
      return;
    }
    // First authenticated call gets a 401 to prove the client re-auths once.
    if (!seen.rejectedOnce) { seen.rejectedOnce = true; return send(401, { error: { message: 'expired' } }); }
    if (!String(req.headers.authorization || '').startsWith('Bearer at-')) return send(401, {});

    if (url.pathname === '/option-chains/SPX/nested') {
      return send(200, { data: { items: [
        { 'underlying-symbol': 'SPX', 'root-symbol': 'SPXW', expirations: [
          { 'expiration-date': today, 'days-to-expiration': 0, 'expiration-type': 'Weekly', 'settlement-type': 'PM', strikes: strikesFor('SPXW', today) },
          { 'expiration-date': tomorrow, 'days-to-expiration': 1, 'expiration-type': 'Weekly', 'settlement-type': 'PM', strikes: strikesFor('SPXW', tomorrow) },
        ] },
        { 'underlying-symbol': 'SPX', 'root-symbol': 'SPX', expirations: [
          { 'expiration-date': '2020-01-17', 'days-to-expiration': 0, 'expiration-type': 'Regular', 'settlement-type': 'AM', strikes: strikesFor('SPX', '2020-01-17') },
        ] },
      ] } });
    }
    if (url.pathname === '/market-data/by-type') {
      seen.byTypeQuery = url.search;
      const items = [];
      url.searchParams.getAll('index').forEach(s => items.push({ symbol: s, 'instrument-type': 'Index', last: String(SPOT), bid: '0', ask: '0', 'prev-close': '7629.80', open: '7631.0', 'day-high-price': '7655.0', 'day-low-price': '7620.5', volume: '0' }));
      url.searchParams.getAll('equity').forEach(s => items.push({ symbol: s, 'instrument-type': 'Equity', last: '763.10', bid: '763.09', ask: '763.11', mark: '763.10', 'prev-close': '761.00', volume: '1000' }));
      return send(200, { data: { items } });
    }
    if (url.pathname === '/api-quote-tokens') {
      return send(200, { data: { token: 'dx-token', 'dxlink-url': wsUrl, level: 'api', 'expires-at': new Date(Date.now() + 86400000).toISOString() } });
    }
    send(404, { error: 'nope' });
  });

  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', ws => {
    let fields;
    ws.on('message', buf => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'SETUP') { ws.send(JSON.stringify({ type: 'SETUP', channel: 0 })); ws.send(JSON.stringify({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })); }
      if (m.type === 'AUTH') { assert.equal(m.token, 'dx-token'); ws.send(JSON.stringify({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })); }
      if (m.type === 'CHANNEL_REQUEST') ws.send(JSON.stringify({ type: 'CHANNEL_OPENED', channel: m.channel, service: 'FEED' }));
      if (m.type === 'FEED_SETUP') {
        fields = m.acceptEventFields;
        assert.equal(m.acceptDataFormat, 'COMPACT');
        ws.send(JSON.stringify({ type: 'FEED_CONFIG', channel: m.channel, dataFormat: 'COMPACT', eventFields: fields }));
        seen.conn = { ws, channel: m.channel, fields };
      }
      if (m.type === 'FEED_SUBSCRIPTION' && m.add) {
        seen.subs.push(...m.add);
        const byType = {};
        for (const { type, symbol } of m.add) {
          const f = fields[type];
          let vals;
          if (symbol.startsWith('.')) {
            const o = fakeOption(symbol);
            const src = {
              Quote: { bidPrice: o.bid, askPrice: o.ask, bidSize: 10, askSize: 12 },
              Trade: { price: o.price, dayVolume: o.vol, size: 1, change: 0.5 },
              Greeks: { price: o.price, volatility: o.iv, delta: o.delta, gamma: o.gamma, theta: -1.2, rho: 0.01, vega: 0.3 },
              Summary: { openInterest: o.oi, dayOpenPrice: o.price, dayHighPrice: o.price + 1, dayLowPrice: o.price - 1, prevDayClosePrice: o.price - 0.4 },
            }[type];
            vals = f.map(k => k === 'eventType' ? type : k === 'eventSymbol' ? symbol : (src[k] ?? 'NaN'));
          } else {
            const src = {
              Quote: { bidPrice: 'NaN', askPrice: 'NaN', bidSize: 'NaN', askSize: 'NaN' },
              Trade: { price: SPOT, dayVolume: 0, size: 0, change: 18.4 },
              Summary: { openInterest: 0, dayOpenPrice: 7631, dayHighPrice: 7655, dayLowPrice: 7620.5, prevDayClosePrice: 7629.8 },
            }[type];
            vals = f.map(k => k === 'eventType' ? type : k === 'eventSymbol' ? symbol : (src[k] ?? 'NaN'));
          }
          (byType[type] = byType[type] || []).push(...vals);
        }
        // Mix two event types in one frame to exercise the multi-pair COMPACT path.
        const data = Object.entries(byType).flat();
        setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'FEED_DATA', channel: m.channel, data })), 20);
      }
    });
  });

  // Push one more Trade tick for an already-subscribed option streamer symbol
  // (a later print, e.g. a bigger dayVolume at a new price) — used by tests
  // that exercise live accumulation instead of just the first fill.
  function pushTrade(symbol, { price, dayVolume, size = 1, change = 0 } = {}) {
    const c = seen.conn;
    if (!c) throw new Error('pushTrade: no DXLink connection yet');
    const f = c.fields.Trade;
    const src = { price, dayVolume, size, change };
    const vals = f.map(k => k === 'eventType' ? 'Trade' : k === 'eventSymbol' ? symbol : (src[k] ?? 'NaN'));
    const data = ['Trade', vals];
    c.ws.readyState === 1 && c.ws.send(JSON.stringify({ type: 'FEED_DATA', channel: c.channel, data }));
  }

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      wsUrl = `ws://127.0.0.1:${wss.address().port}`;
      resolve({ base: `http://127.0.0.1:${server.address().port}`, seen, pushTrade, close: () => { server.close(); wss.close(); } });
    });
  });
}

module.exports = { startFakes, occ, streamer, today, tomorrow, SPOT };
