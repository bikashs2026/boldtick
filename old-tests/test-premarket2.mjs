// boldtick-tastytrade-test — premarket OI/Greeks check, v2.
// Fix over v1: finds the REAL ATM strike (via a live SPX price read first)
// instead of blindly picking the middle of the strikes array, and checks
// a small cluster of strikes around it instead of just one, over 15s.

import axios from 'axios';
import WebSocket from 'ws';
import 'dotenv/config';

const BASE = 'https://api.tastyworks.com';
const { TASTY_CLIENT_ID, TASTY_CLIENT_SECRET, TASTY_REFRESH_TOKEN } = process.env;

if (!TASTY_CLIENT_ID || !TASTY_CLIENT_SECRET || !TASTY_REFRESH_TOKEN) {
  console.error('❌ Missing TASTY_CLIENT_ID / TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN in .env');
  process.exit(1);
}

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: TASTY_REFRESH_TOKEN,
    client_id: TASTY_CLIENT_ID,
    client_secret: TASTY_CLIENT_SECRET,
  });
  const res = await axios.post(`${BASE}/oauth/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.data.access_token;
}

async function getQuoteToken(accessToken) {
  const res = await axios.get(`${BASE}/api-quote-tokens`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { token: res.data?.data?.token, url: res.data?.data?.['dxlink-url'] };
}

// Open a short-lived DXLink connection just to read SPX's current trade/quote price.
async function getSpxPrice(quoteToken, dxlinkUrl) {
  console.log('[1/3] Reading current SPX price (premarket may only have a Quote, not a Trade)…');
  return new Promise((resolve) => {
    let price = null;
    const ws = new WebSocket(dxlinkUrl);
    const channel = 1;
    const timer = setTimeout(() => { ws.close(); }, 6000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'SETUP', channel: 0, version: '0.1-boldtick-premarket2', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'AUTH_STATE' && msg.state === 'UNAUTHORIZED') {
        ws.send(JSON.stringify({ type: 'AUTH', channel: 0, token: quoteToken }));
      } else if (msg.type === 'AUTH_STATE' && msg.state === 'AUTHORIZED') {
        ws.send(JSON.stringify({ type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } }));
      } else if (msg.type === 'CHANNEL_OPENED' && msg.channel === channel) {
        ws.send(JSON.stringify({
          type: 'FEED_SETUP', channel, acceptAggregationPeriod: 0.1, acceptDataFormat: 'COMPACT',
          acceptEventFields: {
            Trade: ['eventType', 'eventSymbol', 'price'],
            Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
          },
        }));
        ws.send(JSON.stringify({
          type: 'FEED_SUBSCRIPTION', channel, reset: true,
          add: [{ type: 'Trade', symbol: 'SPX' }, { type: 'Quote', symbol: 'SPX' }],
        }));
      } else if (msg.type === 'FEED_DATA') {
        const payload = msg.data;
        for (let p = 0; p < payload.length; p += 2) {
          const eventType = payload[p], values = payload[p + 1] || [];
          if (eventType === 'Trade' && values[2] !== undefined) {
            price = values[2];
            console.log(`   Trade price: ${price}`);
          } else if (eventType === 'Quote' && values[2] !== undefined && values[3] !== undefined) {
            const mid = (values[2] + values[3]) / 2;
            if (!price) price = mid;
            console.log(`   Quote bid=${values[2]} ask=${values[3]} (mid=${mid})`);
          }
        }
        if (price) { clearTimeout(timer); ws.close(); }
      }
    });
    ws.on('close', () => resolve(price));
    ws.on('error', (err) => { console.error('   ❌', err.message); resolve(price); });
  });
}

async function pickNearAtmContracts(accessToken, price) {
  console.log('\n[2/3] Pulling SPX chain, finding strikes nearest to', price, '…');
  const res = await axios.get(`${BASE}/option-chains/SPX/nested`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const chain = res.data?.data?.items?.[0];
  const expirations = chain?.expirations || [];
  if (!expirations.length) throw new Error('No expirations returned');
  const exp = expirations[0]; // nearest (today, 0DTE, per the earlier run)
  const strikes = exp.strikes || [];
  if (!strikes.length) throw new Error('No strikes in nearest expiration');

  const refPrice = price || strikes[Math.floor(strikes.length / 2)]['strike-price'];
  const sorted = [...strikes].sort((a, b) =>
    Math.abs(a['strike-price'] - refPrice) - Math.abs(b['strike-price'] - refPrice));
  const nearest5 = sorted.slice(0, 5);

  console.log(`   Expiration: ${exp['expiration-date']}  Reference price: ${refPrice}`);
  console.log('   Nearest strikes picked:', nearest5.map(s => s['strike-price']).join(', '));
  console.log('\n   RAW strike object (so we can see every field name tastytrade actually sends):');
  console.log('   ' + JSON.stringify(nearest5[0], null, 2).split('\n').join('\n   '));

  // Prefer a dedicated streamer-symbol field if tastytrade provides one (dxfeed's
  // streamer symbol convention often differs from the OCC trading symbol in `call`/`put`).
  const streamerSym = (s, side) =>
    s[`${side}-streamer-symbol`] || s[`streamer-symbol-${side}`] || s[side];

  const symbols = nearest5.flatMap(s => [streamerSym(s, 'call'), streamerSym(s, 'put')]).filter(Boolean);
  console.log('\n   Symbols that will be subscribed:', symbols);
  return symbols;
}

async function streamGreeksAndOI(quoteToken, dxlinkUrl, symbols) {
  console.log(`\n[3/3] Opening DXLink stream for Summary (OI) + Greeks on ${symbols.length} contracts (~15s)…`);
  const seen = {};

  await new Promise((resolve) => {
    const ws = new WebSocket(dxlinkUrl);
    const channel = 1;
    const timer = setTimeout(() => ws.close(), 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'SETUP', channel: 0, version: '0.1-boldtick-premarket2b', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'AUTH_STATE' && msg.state === 'UNAUTHORIZED') {
        ws.send(JSON.stringify({ type: 'AUTH', channel: 0, token: quoteToken }));
      } else if (msg.type === 'AUTH_STATE' && msg.state === 'AUTHORIZED') {
        ws.send(JSON.stringify({ type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } }));
      } else if (msg.type === 'CHANNEL_OPENED' && msg.channel === channel) {
        ws.send(JSON.stringify({
          type: 'FEED_SETUP', channel,
          acceptAggregationPeriod: 0.1,
          acceptDataFormat: 'COMPACT',
          acceptEventFields: {
            Summary: ['eventType', 'eventSymbol', 'openInterest', 'dayOpenPrice'],
            Greeks: ['eventType', 'eventSymbol', 'delta', 'gamma', 'theta', 'vega', 'volatility'],
            Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
          },
        }));
        ws.send(JSON.stringify({
          type: 'FEED_SUBSCRIPTION', channel, reset: true,
          add: symbols.flatMap(s => [
            { type: 'Summary', symbol: s },
            { type: 'Greeks', symbol: s },
            { type: 'Quote', symbol: s },
          ]),
        }));
        console.log(`   Subscribed Summary+Greeks+Quote for ${symbols.length} contracts`);
      } else if (msg.type === 'FEED_DATA') {
        const payload = msg.data;
        for (let p = 0; p < payload.length; p += 2) {
          const eventType = payload[p];
          const values = payload[p + 1] || [];
          if (eventType === 'Summary') {
            for (let i = 0; i < values.length; i += 4) {
              const sym = values[i + 1], oi = values[i + 2], dayOpen = values[i + 3];
              if (sym === undefined) continue;
              seen[sym] = seen[sym] || {};
              seen[sym].openInterest = oi;
              console.log(`   Summary ${sym}: openInterest=${oi} dayOpenPrice=${dayOpen}`);
            }
          } else if (eventType === 'Greeks') {
            for (let i = 0; i < values.length; i += 6) {
              const sym = values[i + 1], delta = values[i + 2], gamma = values[i + 3], theta = values[i + 4], vega = values[i + 5];
              if (sym === undefined) continue;
              seen[sym] = seen[sym] || {};
              seen[sym].greeks = { delta, gamma, theta, vega };
              console.log(`   Greeks  ${sym}: delta=${delta} gamma=${gamma} theta=${theta} vega=${vega}`);
            }
          } else if (eventType === 'Quote') {
            for (let i = 0; i < values.length; i += 3) {
              const sym = values[i + 1], bid = values[i + 2];
              if (sym === undefined) continue;
              seen[sym] = seen[sym] || {};
              seen[sym].quoted = true;
              console.log(`   Quote   ${sym}: bid=${bid}`);
            }
          }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      console.log('\n──────────────────────────────────────────');
      const withOI = Object.values(seen).filter(s => s.openInterest !== undefined && s.openInterest !== null).length;
      const withGreeks = Object.values(seen).filter(s => s.greeks && s.greeks.gamma !== undefined).length;
      const withQuote = Object.values(seen).filter(s => s.quoted).length;
      console.log(`Contracts touched: ${Object.keys(seen).length} / ${symbols.length}`);
      console.log(`  with OI: ${withOI}   with Greeks: ${withGreeks}   with Quote: ${withQuote}`);
      if (withOI > 0 || withGreeks > 0) {
        console.log('🎉 RESULT: tastytrade DID return OI/Greeks premarket for at least some near-ATM contracts.');
      } else if (withQuote > 0) {
        console.log('⚠️  RESULT: Got quotes but no OI/Greeks — tastytrade may also gate Greeks/OI until the open,');
        console.log('   or these specific dxfeed event types need a different subscription approach.');
      } else {
        console.log('⚠️  RESULT: Nothing at all came back for these contracts — worth double-checking symbol format.');
      }
      resolve();
    });

    ws.on('error', (err) => console.error('   ❌ WebSocket error:', err.message));
  });
}

(async () => {
  try {
    const accessToken = await getAccessToken();
    const { token: quoteToken, url: dxlinkUrl } = await getQuoteToken(accessToken);
    const price = await getSpxPrice(quoteToken, dxlinkUrl);
    const symbols = await pickNearAtmContracts(accessToken, price);
    await streamGreeksAndOI(quoteToken, dxlinkUrl, symbols);
  } catch (err) {
    console.error('\n❌ Failed:', err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
})();
