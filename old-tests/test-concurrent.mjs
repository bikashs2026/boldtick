// boldtick-tastytrade-test — concurrent-session check.
// Simulates "AWS" and "local" each independently exchanging the SAME refresh
// token for their own access token, then checks that BOTH access tokens
// stay valid at the same time (i.e. getting token B does not revoke token A).
// This is the direct analog of the Schwab token-collision problem.

import axios from 'axios';
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

async function exchange(label) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: TASTY_REFRESH_TOKEN,
    client_id: TASTY_CLIENT_ID,
    client_secret: TASTY_CLIENT_SECRET,
  });
  const res = await axios.post(`${BASE}/oauth/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  console.log(`   [${label}] got access token ${mask(res.data.access_token)}`);
  return res.data.access_token;
}

async function useToken(label, token) {
  try {
    const res = await axios.get(`${BASE}/customers/me/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const count = res.data?.data?.items?.length || 0;
    console.log(`   [${label}] ✅ token still works — ${count} account(s) returned`);
    return true;
  } catch (err) {
    console.log(`   [${label}] ❌ token FAILED — ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    return false;
  }
}

(async () => {
  console.log('\n[Step 1] "AWS" and "local" independently exchange the SAME refresh token, at the same time…');
  const [tokenAWS, tokenLocal] = await Promise.all([
    exchange('AWS'),
    exchange('local'),
  ]);

  console.log('\n[Step 2] Both use their OWN access token right away — do both work?');
  const [awsOk1, localOk1] = await Promise.all([
    useToken('AWS', tokenAWS),
    useToken('local', tokenLocal),
  ]);

  console.log('\n[Step 3] Wait 3s, then re-check AWS\'s token — did issuing local\'s token revoke it?');
  await new Promise(r => setTimeout(r, 3000));
  const awsOk2 = await useToken('AWS (re-check)', tokenAWS);

  console.log('\n[Step 4] One more exchange from "AWS" again — does refreshing again revoke local\'s still-active token?');
  const tokenAWS2 = await exchange('AWS (2nd refresh)');
  const [localOk2, aws2Ok] = await Promise.all([
    useToken('local (after AWS re-refreshed)', tokenLocal),
    useToken('AWS (brand new token)', tokenAWS2),
  ]);

  console.log('\n──────────────────────────────────────────');
  if (awsOk1 && localOk1 && awsOk2 && localOk2 && aws2Ok) {
    console.log('🎉 RESULT: Two independent access tokens from the same refresh token coexisted fine,');
    console.log('   and repeated refreshing did not revoke the other side\'s active token.');
    console.log('   This is the opposite of the Schwab behavior — no authority/follower split needed.');
  } else {
    console.log('⚠️  RESULT: Something got revoked. Re-read the ✅/❌ lines above to see exactly which step broke.');
    console.log('   That tells us tastytrade DOES have some form of single-session limit after all.');
  }
})();
