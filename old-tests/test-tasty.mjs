// boldtick-tastytrade-test — standalone, read-only test of the tastytrade API.
// NOT wired into TradeForge. Safe to run/delete independently.
//
// Setup:
//   npm install
//   (make sure .env in this same folder has TASTY_CLIENT_ID, TASTY_CLIENT_SECRET, TASTY_REFRESH_TOKEN)
//   npm test
//
// What it does, in order:
//   1. Exchanges your refresh token for a 15-min access token
//   2. Confirms auth by fetching your account info (masked)
//   3. Pulls a live SPX option chain (nested by expiration/strike)
//   4. Gets a DXLink streaming token and opens a live quote stream for ~8s

import axios from 'axios';
import WebSocket from 'ws';
import 'dotenv/config';

const BASE = 'https://api.tastyworks.com';

const { TASTY_CLIENT_ID, TASTY_CLIENT_SECRET, TASTY_REFRESH_TOKEN } = process.env;

if (!TASTY_CLIENT_ID || !TASTY_CLIENT_SECRET || !TASTY_REFRESH_TOKEN) {
  console.error('❌ Missing TASTY_CLIENT_ID / TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN in .env');
  process.exit(1);
}

function mask(str, keep = 4) {
  if (!str) return '(none)';
  return str.slice(0, keep) + '…' + str.slice(-keep);
}

async function getAccessToken() {
  console.log('\n[1/4] Exchanging refresh token for an access token…');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: TASTY_REFRESH_TOKEN,
    client_id: TASTY_CLIENT_ID,
    client_secret: TASTY_CLIENT_SECRET,
  });
  const res = await axios.post(`${BASE}/oauth/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  console.log(`✅ Got access token (${mask(res.data.access_token)}), expires in ${res.data.expires_in}s`);
  return res.data.access_token;
}

async function checkAuth(accessToken) {
  console.log('\n[2/4] Confirming auth — fetching account info…');
  const res = await axios.get(`${BASE}/customers/me/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const accounts = res.data?.data?.items || [];
  console.log(`✅ Auth works. Found ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(`   - ${mask(a.account?.['account-number'], 3)} (${a.account?.['account-type-name'] || 'unknown type'})`);
  }
}

async function getSpxChain(accessToken) {
  console.log('\n[3/4] Pulling SPX option chain (nested)…');
  const res = await axios.get(`${BASE}/option-chains/SPX/nested`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const chain = res.data?.data?.items?.[0];
  const expirations = chain?.expirations || [];
  console.log(`✅ Got ${expirations.length} expiration(s). First few:`);
  for (const exp of expirations.slice(0, 5)) {
    console.log(`   - ${exp['expiration-date']} (${exp['days-to-expiration']}d, ${exp.strikes?.length || 0} strikes)`);
  }
  if (expirations.length) {
    const first = expirations[0];
    const midStrike = first.strikes?.[Math.floor((first.strikes?.length || 1) / 2)];
    if (midStrike) {
      console.log(`   Sample strike @ ${midStrike['strike-price']}: call=${midStrike.call}  put=${midStrike.put}`);
    }
  }
  return expirations;
}

async function streamQuotes(accessToken) {
  console.log('\n[4/4] Opening DXLink stream for live quotes (~8s)…');

  const tokenRes = await axios.get(`${BASE}/api-quote-tokens`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const quoteToken = tokenRes.data?.data?.token;
  const dxlinkUrl = tokenRes.data?.data?.['dxlink-url'];
  if (!quoteToken || !dxlinkUrl) {
    console.log('❌ No quote token / dxlink URL returned — skipping stream test.');
    return;
  }
  console.log(`   Connecting to ${dxlinkUrl}`);

  const symbols = (process.env.STREAM_SYMBOLS || 'SPY,SPX').split(',').map(s => s.trim());
  const counts = {};

  await new Promise((resolve) => {
    const ws = new WebSocket(dxlinkUrl);
    let channel = 1;
    const timer = setTimeout(() => { ws.close(); }, 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'SETUP', channel: 0, version: '0.1-boldtick-test', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'AUTH_STATE' && msg.state === 'UNAUTHORIZED') {
        ws.send(JSON.stringify({ type: 'AUTH', channel: 0, token: quoteToken }));
      } else if (msg.type === 'AUTH_STATE' && msg.state === 'AUTHORIZED') {
        console.log('   ✅ Stream authorized, opening feed channel…');
        ws.send(JSON.stringify({ type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } }));
      } else if (msg.type === 'CHANNEL_OPENED' && msg.channel === channel) {
        ws.send(JSON.stringify({
          type: 'FEED_SETUP', channel,
          acceptAggregationPeriod: 0.1,
          acceptDataFormat: 'COMPACT',
          acceptEventFields: {
            Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
            Trade: ['eventType', 'eventSymbol', 'price', 'dayVolume'],
          },
        }));
        ws.send(JSON.stringify({
          type: 'FEED_SUBSCRIPTION', channel, reset: true,
          add: symbols.flatMap(s => [{ type: 'Quote', symbol: s }, { type: 'Trade', symbol: s }]),
        }));
        console.log(`   Subscribed to: ${symbols.join(', ')}`);
      } else if (msg.type === 'FEED_DATA') {
        // COMPACT format: msg.data = [eventType, flatValuesArray, eventType2, flatValuesArray2, ...]
        // flatValuesArray repeats the field list we declared in acceptEventFields, INCLUDING eventType itself.
        const payload = msg.data;
        for (let p = 0; p < payload.length; p += 2) {
          const eventType = payload[p];
          const values = payload[p + 1] || [];
          if (eventType === 'Quote') {
            const stride = 6; // eventType, eventSymbol, bidPrice, askPrice, bidSize, askSize
            for (let i = 0; i < values.length; i += stride) {
              const sym = values[i + 1], bid = values[i + 2], ask = values[i + 3], bidSz = values[i + 4], askSz = values[i + 5];
              if (sym === undefined) continue;
              counts[sym] = (counts[sym] || 0) + 1;
              console.log(`   Quote  ${sym}: bid=${bid} ask=${ask} bidSz=${bidSz} askSz=${askSz}`);
            }
          } else if (eventType === 'Trade') {
            const stride = 4; // eventType, eventSymbol, price, dayVolume
            for (let i = 0; i < values.length; i += stride) {
              const sym = values[i + 1], price = values[i + 2], vol = values[i + 3];
              if (sym === undefined) continue;
              counts[sym] = (counts[sym] || 0) + 1;
              console.log(`   Trade  ${sym}: price=${price} dayVolume=${vol}`);
            }
          } else {
            console.log('   (unhandled event type)', eventType, values);
          }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      console.log('\n✅ Stream closed. Messages received per symbol:', counts);
      if (Object.keys(counts).length === 0) {
        console.log('   ⚠️  No data received — market may be closed, or symbol format needs adjusting');
        console.log('      (try STREAM_SYMBOLS=SPY npm test, or check the /instruments endpoint for exact symbols)');
      }
      resolve();
    });

    ws.on('error', (err) => {
      console.error('   ❌ WebSocket error:', err.message);
    });
  });
}

(async () => {
  try {
    const accessToken = await getAccessToken();
    await checkAuth(accessToken);
    await getSpxChain(accessToken);
    await streamQuotes(accessToken);
    console.log('\n🎉 Done.');
  } catch (err) {
    console.error('\n❌ Failed:', err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
})();
