// src/paper/app.js — builds the Paper Desk app (used by server.js and the tests)

const path = require('path');
const express = require('express');
const { Store } = require('./store');
const { Clock } = require('./clock');
const { Settings } = require('./settings');
const { Events } = require('./events');
const { createMarket } = require('./marketData');
const { createBroker } = require('./broker');
const { PaperDesk } = require('./desk');
const { makeAuth } = require('./api/auth');
const { makeRouter } = require('./api/routes');
const { makeAnalyzeRouter } = require('../analyze/routes');

// Live data only: market data is the production tastytrade feed (or, optionally,
// a running TradeForge's /api/options). Tests inject `clock` and `market` and pass dev: true.
function createPaperApp({ env = process.env, dataDir, clock, market, broker, log = console, dev = false } = {}) {
  if (!clock) clock = new Clock();
  if (env.PAPER_SIM_TIME || env.PAPER_MARKET_DATA === 'fake') throw new Error('Paper Desk runs on live market data only; remove PAPER_SIM_TIME / PAPER_MARKET_DATA=fake from .env');
  const store = new Store(dataDir || env.PAPER_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'paper'));
  const settings = new Settings(store, clock);
  const events = new Events(store, clock);

  if (!market) {
    const kind = (env.PAPER_MARKET_DATA || 'tastytrade').toLowerCase();
    if (!['tastytrade', 'tradeforge'].includes(kind)) throw new Error('PAPER_MARKET_DATA must be tastytrade or tradeforge');
    market = createMarket({ kind, clock, tradeforgeUrl: env.TRADEFORGE_URL });
  }
  const audit = entry => { try { store.append('audit.jsonl', { at: clock.iso(), ...entry }); } catch { /* ignore */ } };
  if (!broker) broker = createBroker({ store, clock, market, settings, env, audit, dev });

  const desk = new PaperDesk({ store, clock, settings, events, market, broker, env });
  const auth = makeAuth({ env, settings });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_request', message: 'Body is not valid JSON.' } });
    next(err);
  });

  const router = makeRouter({ desk, settings, events, store, auth, market, clock });
  app.use('/api/paper', router);
  app.use('/paper/api', router);
  app.use('/paper', auth.ownerPage, express.static(path.join(__dirname, '..', '..', 'public', 'paper'), { index: 'index.html' }));
  app.use('/api/analyze', auth.ownerPage, makeAnalyzeRouter({ market }));
  app.use('/analyze', auth.ownerPage, express.static(path.join(__dirname, '..', '..', 'public', 'analyze'), { index: 'index.html' }));
  app.get('/', (req, res) => res.redirect('/analyze/'));

  // ── background loops ──
  const timers = [];
  let stopped = false;
  function loop(name, fn, intervalKey) {
    const tick = async () => {
      if (stopped) return;
      try { await fn(); } catch (e) { log.error(`Paper Desk ${name} error:`, e.message); }
      if (stopped) return;
      const secs = clock.isMarketHours()
        ? settings.value(intervalKey)
        : settings.value('timing.offhours_interval_s');
      timers.push(setTimeout(tick, secs * 1000));
    };
    timers.push(setTimeout(tick, 500));
  }

  async function start() {
    await broker.init();
    loop('sync', () => desk.sync(), 'timing.sync_interval_s');
    loop('engine', async () => {
      await desk.engineTick();
      const et = clock.et();
      const state = desk.state;
      if (et.minutes >= 17 * 60 && state.last_backup !== et.date) {
        store.backup(et.date);
        state.last_backup = et.date;
        desk.save('state');
      }
    }, 'timing.engine_interval_s');
  }

  function stop() {
    stopped = true;
    timers.forEach(clearTimeout);
    if (market.hub && market.hub.stop) market.hub.stop();
  }

  return { app, desk, settings, events, store, clock, market, broker, auth, start, stop };
}

module.exports = { createPaperApp };
