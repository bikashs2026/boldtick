// scripts/paper-spike.js — answer the sandbox questions before trusting the paper adapter
//
// Uses ONLY the TT_PAPER_* credentials, ONLY against https://api.cert.tastyworks.com
// (the same guarded adapter Paper Desk uses). Nothing here can reach a real account.
//
//   node scripts/paper-spike.js            # read-only checks + a dry-run order
//   node scripts/paper-spike.js --submit   # also place a far-out-of-the-money 1-lot, watch it, then cancel it
//   node scripts/paper-spike.js --symbol SPY

require('dotenv').config();
const { TastytradePaperBroker } = require('../src/paper/broker/tastytradePaper');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SYMBOL = arg('--symbol', 'SPX');
const SUBMIT = args.includes('--submit');
const results = [];
const note = (q, a) => { results.push([q, a]); console.log(`  → ${a}`); };
const keys = o => (o && typeof o === 'object' ? Object.keys(o).join(', ') : String(o));

(async () => {
  let b;
  try {
    console.log('\n1. Paper OAuth + account');
    b = new TastytradePaperBroker({ env: process.env, audit: () => {} });
    await b.init();
    note('Paper OAuth works with its own client and refresh token on the cert host', `yes — account ${b.account} visible`);

    console.log('\n2. Balances and positions');
    const bal = await b._call('get', `/accounts/${b.account}/balances`);
    console.log('   balance fields:', keys(bal?.data));
    const pos = await b._call('get', `/accounts/${b.account}/positions`);
    const items = pos?.data?.items || [];
    console.log(`   ${items.length} positions; fields: ${keys(items[0])}`);
    const shares = items.filter(p => p['instrument-type'] === 'Equity').map(p => `${p.symbol} ${p.quantity}`);
    note('Shares held in the paper account (for covered trades)', shares.length ? shares.join(', ') : 'none');

    console.log(`\n3. ${SYMBOL} option chain on the sandbox`);
    const chain = await b._call('get', `/option-chains/${SYMBOL}/nested`);
    const roots = chain?.data?.items || [];
    const exps = roots.flatMap(r => (r.expirations || []).map(e => ({ root: r['root-symbol'], ...e })));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    exps.sort((x, y) => x['expiration-date'].localeCompare(y['expiration-date']));
    const next = exps.find(e => e['expiration-date'] >= today);
    note(`${SYMBOL} options listed on the sandbox`, exps.length ? `yes — ${exps.length} expirations, roots ${[...new Set(roots.map(r => r['root-symbol']))].join('/')}, next ${next?.['expiration-date']} (${next?.root})` : 'NO — sandbox has no chain for this symbol');
    if (!next) throw new Error('no upcoming expiration to test with');
    const strikes = next.strikes || [];
    console.log('   strike fields:', keys(strikes[0]));

    // Far OTM 1-lot put credit spread: lowest listed strikes, so it will never fill at a silly price.
    const sorted = strikes.map(s => ({ k: Number(s['strike-price']), put: typeof s.put === 'string' ? s.put : s.put?.symbol })).filter(s => s.put).sort((a, b2) => a.k - b2.k);
    const [lo, hi] = [sorted[0], sorted[1]];
    const order = {
      externalId: `spike-${Date.now()}`,
      legs: [{ occSymbol: hi.put, side: 'STO', quantity: 1 }, { occSymbol: lo.put, side: 'BTO', quantity: 1 }],
      limitPrice: 0.05, priceEffect: 'credit', timeInForce: 'Day',
    };
    console.log('\n4. Order JSON and dry-run');
    console.log('   sending:', JSON.stringify(b.toTastyOrder(order)));
    const dry = await b.dryRun(order);
    note(`Dry-run with price style "${b.priceStyle}"`, dry.ok ? `accepted (buying power effect ${dry.buyingPowerEffect}, fees ${dry.fees})` : `rejected: ${dry.warnings.join('; ')} — try TT_PAPER_PRICE_STYLE=${b.priceStyle === 'effect' ? 'signed' : 'effect'}`);

    if (SUBMIT) {
      console.log('\n5. Submit, watch for 15 s, cancel');
      const placed = await b.submitOrder(order);
      console.log(`   placed ${placed.brokerOrderId}, status ${placed.status}; raw fields: ${keys(placed.raw)}`);
      note('External order identifier accepted and returned', placed.externalId === order.externalId ? 'yes' : `no (got ${placed.externalId})`);
      let last = placed;
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 3000));
        last = await b.getOrder(placed.brokerOrderId);
        console.log(`   t+${(i + 1) * 3}s status ${last.status}, filled ${last.filledQuantity}/${last.quantity}`);
        if (['filled', 'cancelled', 'rejected', 'expired'].includes(last.status)) break;
      }
      note('How the sandbox fills a far-OTM 2-leg limit order', `${last.status}${last.avgFillPrice != null ? ' at ' + last.avgFillPrice : ''} after up to 15 s`);
      const live = await b.getOrders();
      note('Order appears in /orders/live', live.some(o => o.brokerOrderId === placed.brokerOrderId) ? 'yes' : 'no — Paper Desk falls back to GET /orders/{id}');
      if (!['filled', 'cancelled', 'rejected', 'expired'].includes(last.status)) {
        const c = await b.cancelOrder(placed.brokerOrderId);
        note('Cancel works', `status ${c.status}`);
      } else if (last.status === 'filled') {
        console.log('   ⚠ it filled — close it from Paper Desk or the tastytrade sandbox site');
      }
    } else {
      console.log('\n(Run with --submit to also place and cancel a 1-lot order.)');
    }
  } catch (e) {
    console.error(`\n✖ ${e.message}`);
    process.exitCode = 1;
  }

  console.log('\nSummary');
  for (const [q, a] of results) console.log(`- ${q}: ${a}`);
  console.log('');
})();
