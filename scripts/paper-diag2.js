// scripts/paper-diag2.js — check whether the sandbox actually lists the exact
// contracts the two failed orders used (live data may list strikes/expirations
// the sandbox's smaller mirrored universe doesn't have).
//
//   node scripts/paper-diag2.js

require('dotenv').config();
const { TastytradePaperBroker } = require('../src/paper/broker/tastytradePaper');

async function checkChain(b, symbol, expDate, wantStrikes) {
  console.log(`\n${symbol} sandbox chain:`);
  let chain;
  try {
    chain = await b._call('get', `/option-chains/${symbol}/nested`);
  } catch (e) {
    console.log(`  ✖ no chain at all: ${e.message}`);
    return;
  }
  const roots = chain?.data?.items || [];
  if (!roots.length) { console.log('  ✖ empty chain — not listed in the sandbox'); return; }
  const exps = roots.flatMap(r => (r.expirations || []).map(e => ({ root: r['root-symbol'], ...e })));
  console.log(`  ${exps.length} expirations: ${exps.map(e => e['expiration-date']).join(', ')}`);
  const match = exps.find(e => e['expiration-date'] === expDate);
  if (!match) { console.log(`  ✖ ${expDate} is NOT listed in the sandbox for ${symbol}`); return; }
  const strikes = new Set((match.strikes || []).map(s => Number(s['strike-price'])));
  console.log(`  ${expDate}: ${strikes.size} strikes listed (${Math.min(...strikes)}–${Math.max(...strikes)})`);
  for (const k of wantStrikes) {
    console.log(`  strike ${k}: ${strikes.has(k) ? 'listed' : '✖ NOT listed'}`);
  }
}

(async () => {
  const b = new TastytradePaperBroker({ env: process.env, audit: () => {} });
  await b.init();
  await checkChain(b, 'SPX', '2026-10-05', [7650, 7655, 7775, 7780]);
  await checkChain(b, 'AMD', '2026-10-09', [607.5, 610]);
})().catch(e => { console.error('\n✖', e.message); process.exitCode = 1; });
