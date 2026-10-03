// server.js — BoldTick (Paper Desk: paper trading on live prices; never real money)
//
//   npm start          → http://127.0.0.1:3100/paper/
//
// Setup and testing: docs/PAPER_DESK.md · Releases: CHANGELOG.md

require('dotenv').config();
const { createPaperApp } = require('./src/paper/app');
const { VERSION } = require('./src/version');

const PORT = Number(process.env.PAPER_PORT || 3100);
const HOST = process.env.PAPER_BIND || '127.0.0.1';

(async () => {
  let paper;
  try {
    paper = createPaperApp({ env: process.env });
    await paper.start();
  } catch (e) {
    console.error(`\n✖ BoldTick v${VERSION} did not start: ${e.message}\n`);
    process.exit(1);
  }
  paper.app.listen(PORT, HOST, () => {
    const s = paper.desk.status();
    console.log(`\n📄 BoldTick v${VERSION} — Paper Desk — PAPER TRADING ONLY`);
    console.log(`   Website:      http://${HOST}:${PORT}/paper/`);
    console.log(`   Muse API:     http://${HOST}:${PORT}/api/paper/`);
    console.log(`   Fills:        live-market scorecard (${s.fill_model} model)`);
    console.log(`   Paper acct:   ${s.mirror?.name ? `tastytrade paper ${s.mirror.account} (mirror)` : 'not configured — scorecard only'}`);
    console.log(`   Market data:  ${s.market_data} (live)`);
    console.log(`   Clock:        ${s.clock.et} ET${s.clock.market_open ? '' : ' (market closed: no fills until the open)'}`);
    if (s.kill_switch.on) console.log(`   ⚠ Kill switch ON${s.kill_switch.forced_by_env ? ' (PAPER_KILL=1)' : ''}`);
    if (!process.env.MUSE_PAPER_KEY) console.log('   ⚠ MUSE_PAPER_KEY not set: Muse cannot call the API yet');
    console.log('');
  });
  const shutdown = () => { paper.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
