// scripts/tt-smoke.js — live check of the tastytrade market-data layer
//
// Uses your real tastytrade credentials from .env (never printed). Run it
// from the repo root while your normal TradeForge server keeps running on
// Schwab, so nothing you rely on changes:
//
//   node scripts/tt-smoke.js                         # tastytrade only
//   node scripts/tt-smoke.js --symbol SPY            # any underlying
//   node scripts/tt-smoke.js --compare https://127.0.0.1:3000
//        └ also pulls the same chain from your running (Schwab-mode)
//          TradeForge and prints both GEX snapshots side by side.

require('dotenv').config();
const https = require('https');
const axios = require('axios');
const { TastyMarketData } = require('../src/tastytrade/hub');
const { computeGexSnapshot } = require('../src/gex');

const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const SYMBOL  = arg('--symbol', '$SPX');
const STRIKES = Number(arg('--strikes', 200));
const COMPARE = arg('--compare', null);

const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

(async () => {
  const hub = new TastyMarketData();
  if (!hub.configured) {
    console.error('Set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN in .env first.');
    process.exit(1);
  }
  hub.on('state', s => console.log(`  DXLink: ${s}`));

  try {
    console.log(`\n▶ Quote ${SYMBOL}`);
    const q = (await hub.getQuotes([SYMBOL]))[SYMBOL];
    if (!q) throw new Error(`no quote returned for ${SYMBOL}`);
    console.log(`  last ${fmt(q.quote.lastPrice)}  chg ${fmt(q.quote.netChange)} (${fmt(q.quote.netPercentChange)}%)  prev close ${fmt(q.quote.closePrice)}  [${q.source}]`);

    console.log(`\n▶ Expirations`);
    const exp = await hub.getExpirationChain(SYMBOL);
    const list = exp.expirationList;
    console.log(`  ${list.length} expirations; next: ${list.slice(0, 5).map(e => `${e.expirationDate} (${e.daysToExpiration}d ${e.optionRoots})`).join(', ')}`);
    const expDate = arg('--exp', list[0]?.expirationDate);

    console.log(`\n▶ Chain ${SYMBOL} ${expDate}, ${STRIKES} strikes`);
    const chain = await hub.getOptionsChain(SYMBOL, { strikeCount: STRIKES, fromDate: expDate, toDate: expDate });
    const dq = chain.dataQuality;
    console.log(`  underlying ${fmt(chain.underlyingPrice)}  ATM IV ${fmt(chain.volatility)}%`);
    console.log(`  contracts ${dq.contracts}  quotes ${dq.withQuote}  greeks ${dq.withGreeks}  OI ${dq.withOI}  filled=${dq.filled}  first fill ${dq.waitedMs}ms`);

    const t0 = Date.now();
    await hub.getOptionsChain(SYMBOL, { strikeCount: STRIKES, fromDate: expDate, toDate: expDate });
    console.log(`  repeat request served in ${Date.now() - t0}ms (from the live stream)`);

    const k = Object.keys(chain.callExpDateMap)[0];
    const atm = Object.keys(chain.callExpDateMap[k] || {}).map(Number)
      .sort((a, b) => Math.abs(a - chain.underlyingPrice) - Math.abs(b - chain.underlyingPrice)).slice(0, 3).sort((a, b) => a - b);
    console.log('\n  strike     C bid/ask        C Δ     C γ     C IV   C OI  |  P bid/ask        P Δ     P OI');
    for (const s of atm) {
      const c = chain.callExpDateMap[k][s.toFixed(1)][0], p = chain.putExpDateMap[k]?.[s.toFixed(1)]?.[0] || {};
      console.log(`  ${String(s).padEnd(8)} ${fmt(c.bid)}/${fmt(c.ask)}`.padEnd(30) + `${fmt(c.delta, 3)}  ${fmt(c.gamma, 4)}  ${fmt(c.volatility, 1)}  ${String(c.openInterest).padStart(6)}  |  ${fmt(p.bid)}/${fmt(p.ask)}`.padEnd(40) + `  ${fmt(p.delta, 3)}  ${String(p.openInterest ?? '—').padStart(6)}`);
    }

    const tSnap = computeGexSnapshot(chain, expDate);
    let sSnap = null;
    if (COMPARE) {
      console.log(`\n▶ Schwab chain from ${COMPARE}`);
      const agent = new https.Agent({ rejectUnauthorized: false }); // local self-signed cert
      const r = await axios.get(`${COMPARE.replace(/\/$/, '')}/api/options/${encodeURIComponent(SYMBOL)}`, {
        params: { strikes: STRIKES, type: 'ALL', fromDate: expDate, toDate: expDate }, httpsAgent: agent, timeout: 20000,
      });
      sSnap = computeGexSnapshot(r.data, expDate);
    }

    console.log('\n▶ GEX snapshot (src/gex.js)');
    const rows = [
      ['regime', s => s?.regime], ['flip', s => fmt(s?.flip)], ['call wall', s => fmt(s?.callWall)], ['put wall', s => fmt(s?.putWall)],
      ['max pain', s => fmt(s?.maxPain)], ['pin', s => fmt(s?.pin)], ['exp. move', s => fmt(s?.expectedMove)],
      ['IV', s => s ? fmt(s.iv * 100) + '%' : '—'], ['total GEX', s => s ? fmt(s.totalGEX / 1e6, 1) + 'M' : '—'],
      ['net DEX', s => s ? fmt(s.dex.netDEX / 1e6, 1) + 'M' : '—'], ['has OI', s => String(s?.hasOI)],
    ];
    console.log(`  ${''.padEnd(11)}${'tastytrade'.padStart(14)}${COMPARE ? 'schwab'.padStart(14) : ''}`);
    for (const [label, f] of rows) {
      console.log(`  ${label.padEnd(11)}${String(f(tSnap)).padStart(14)}${COMPARE ? String(f(sSnap)).padStart(14) : ''}`);
    }
    console.log('\nDone.');
  } catch (e) {
    console.error('\n✖', e.message);
    process.exitCode = 1;
  } finally {
    hub.stop();
  }
})();
