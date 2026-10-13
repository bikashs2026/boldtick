// boldtick-tastytrade-test — premarket OI/Greeks check.
// Answers the real question: does tastytrade have OI/Greeks populated for
// SPX options BEFORE the 9:30am ET open, unlike what we're seeing from Schwab?
//
// Picks the nearest 0DTE/near-term SPX ATM strike, then opens a DXLink stream
// subscribing to Summary (has openInterest) and Greeks (delta/gamma/theta/vega)
// for that one specific contract, and prints whatever comes back.

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

async function pickAtmContracts(accessToken) {
  console.log('[1/2] Pulling SPX chain, picking an ATM call+put for the nearest expiration…');
  const res = await axios.get(`${BASE}/option-chains/SPX/nested`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const chain = res.data?.data?.items?.[0];
  const expirations = chain?.expirations || [];
  if (!expirations.length) throw new Error('No expirations returned');

  // nearest expiration (index 0, same as the live script already showed)
  const exp = expirations[0];
  const strikes = exp.strikes || [];
  if (!strikes.length) throw new Error('No strikes in nearest expiration');

  // naive ATM pick: tastytrade doesn't give us spot price here, so just take the middle strike
  const mid = strikes[Math.floor(strikes.length / 2)];
  console.log(`   Expiration: ${exp['expiration-date']}  Strike: ${mid['strike-price']}`);
  console.log(`   Call symbol: ${mid.call}`);
  console.log(`   Put  symbol: ${mid.put}`);
  return { call: mid.call, put: mid.put };
}

async function streamGreeksAndOI(accessToken, symbols) {
  console.log('\n[2/2] Opening DXLink stream for Summary (OI) + Greeks on these contracts (~10s)…');
  const tokenRes = await axios.get(`${BASE}/api-quote-tokens`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const quoteToken = tokenRes.data?.data?.token;
  const dxlinkUrl = tokenRes.data?.data?.['dxlink-url'];

  const seen = {};

  await new Promise((resolve) => {
    const ws = new WebSocket(dxlinkUrl);
    const channel = 1;
    const timer = setTimeout(() => ws.close(), 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'SETUP', channel: 0, version: '0.1-boldtick-premarket', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 }));
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
        console.log(`   Subscribed Summary+Greeks+Quote for: ${symbols.join(', ')}`);
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
      if (withOI > 0 || withGreeks > 0) {
        console.log(`🎉 RESULT: tastytrade DID return data premarket — OI on ${withOI} contract(s), Greeks on ${withGreeks} contract(s).`);
        console.log('   This would mean tastytrade does NOT have the same premarket gap Schwab has.');
      } else {
        console.log('⚠️  RESULT: No OI or Greeks received for these contracts in 10s.');
        console.log('   Could mean tastytrade ALSO has a premarket gap — or these two specific contracts');
        console.log('   are just illiquid (far-dated, odd strike). Re-run is worth trying on a 0DTE near-ATM strike.');
      }
      resolve();
    });

    ws.on('error', (err) => console.error('   ❌ WebSocket error:', err.message));
  });
}

(async () => {
  try {
    const accessToken = await getAccessToken();
    const { call, put } = await pickAtmContracts(accessToken);
    await streamGreeksAndOI(accessToken, [call, put]);
  } catch (err) {
    console.error('\n❌ Failed:', err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
})();
