// scripts/paper-diag.js — one-off: print tastytrade's FULL raw error body for a
// real (non-dry-run) order, and the sandbox account's balance, so we can see the
// exact reason behind a generic "preflight checks failed" (422).
//
// Uses ONLY TT_PAPER_* credentials, ONLY against the sandbox host. Places and
// cancels a far-OTM 1-lot, same as paper:spike — nothing here risks real money.
//
//   node scripts/paper-diag.js

require('dotenv').config();
const { TastytradePaperBroker } = require('../src/paper/broker/tastytradePaper');

(async () => {
  const b = new TastytradePaperBroker({ env: process.env, audit: () => {} });
  await b.init();
  console.log(`Account ${b.account} (price style: ${b.priceStyle})\n`);

  const bal = await b._call('get', `/accounts/${b.account}/balances`);
  const d = bal?.data || {};
  console.log('Balance:');
  for (const k of ['cash-balance', 'net-liquidating-value', 'equity-buying-power', 'derivative-buying-power', 'day-trading-buying-power', 'maintenance-requirement', 'maintenance-excess']) {
    console.log(`  ${k}: ${d[k]}`);
  }

  console.log('\nChain lookup for a 1-lot SPX put spread…');
  const chain = await b._call('get', '/option-chains/SPX/nested');
  const roots = chain?.data?.items || [];
  const exps = roots.flatMap(r => (r.expirations || []).map(e => ({ root: r['root-symbol'], ...e })));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  exps.sort((x, y) => x['expiration-date'].localeCompare(y['expiration-date']));
  const next = exps.find(e => e['expiration-date'] >= today);
  const strikes = next.strikes || [];
  const sorted = strikes.map(s => ({ k: Number(s['strike-price']), put: typeof s.put === 'string' ? s.put : s.put?.symbol })).filter(s => s.put).sort((a, b2) => a.k - b2.k);
  const [lo, hi] = [sorted[0], sorted[1]];

  const order = {
    externalId: `diag-${Date.now()}`,
    legs: [{ occSymbol: hi.put, side: 'STO', quantity: 1 }, { occSymbol: lo.put, side: 'BTO', quantity: 1 }],
    limitPrice: 0.05, priceEffect: 'credit', timeInForce: 'Day',
  };
  console.log('Order body:', JSON.stringify(b.toTastyOrder(order), null, 2));

  console.log('\nSubmitting (real order, not dry-run)…');
  try {
    const placed = await b.submitOrder(order);
    console.log('✔ accepted:', JSON.stringify(placed, null, 2));
    console.log('\nCancelling…');
    const c = await b.cancelOrder(placed.brokerOrderId);
    console.log('✔ cancelled:', c.status);
  } catch (e) {
    console.log('✖ rejected.');
    console.log('  message:', e.message);
    console.log('  raw error body:', JSON.stringify(e.detail, null, 2));
  }
})().catch(e => { console.error('\n✖', e.message); process.exitCode = 1; });
