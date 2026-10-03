// src/paper/broker/index.js — the scorecard plus the tastytrade paper-account mirror
//
// Fills, positions and P&L always come from the live-market scorecard
// (scorecard.js). Orders are also mirrored to the tastytrade paper (sandbox)
// account when TT_PAPER_* is set in .env, or explicitly with PAPER_MIRROR:
//   PAPER_MIRROR=tastytrade   mirror every order to the paper account (startup fails if it can't connect)
//   PAPER_MIRROR=none         scorecard only
//
// Interface (all async; errors are BrokerError { code, message, raw }):
//   init()                      auth + guards; throws on any misconfiguration
//   dryRun(order)               → { ok, buyingPowerEffect, fees, warnings[] }
//   submitOrder(order)          → BrokerOrder
//   cancelOrder(brokerOrderId)  → BrokerOrder
//   getOrders() / getOrder(id)  → BrokerOrder[] / BrokerOrder
//   getPositions()              → [{ occSymbol, quantity (signed), avgOpenPrice, multiplier, instrumentType }]
//   getBalance()                → { netLiq, buyingPower, cash }
//   sharesHeld(symbol)          → number of shares held (covered structures)
//   mirrorStatus(), mirrorInfo(externalId)
//
// order = { externalId, legs: [{ occSymbol, side: 'BTO'|'STO'|'BTC'|'STC', quantity, meta }],
//           limitPrice, priceEffect: 'credit'|'debit', timeInForce: 'Day' }

const { ScorecardBroker } = require('./scorecard');
const { MirroredBroker } = require('./mirrored');
const { TastytradePaperBroker } = require('./tastytradePaper');

function createBroker({ store, clock, market, settings, env = process.env, audit, dev = false }) {
  const primary = new ScorecardBroker({
    store, clock, market, audit,
    mode: dev && env.SCORECARD_MODE === 'instant' ? 'instant' : 'live',
    fillModel: () => settings.value('fills.model'),
    shares: env.PAPER_SHARES || '',
    startingCash: env.PAPER_STARTING_CASH || 100000,
  });

  const haveCreds = !!(env.TT_PAPER_CLIENT_SECRET || env.TT_PAPER_REFRESH_TOKEN || env.TT_PAPER_ACCOUNT);
  const kind = (env.PAPER_MIRROR || (haveCreds || env.PAPER_BROKER === 'tastytrade' ? 'tastytrade' : 'none')).toLowerCase();
  if (!['tastytrade', 'none'].includes(kind)) throw new Error(`PAPER_MIRROR must be tastytrade or none (got "${kind}")`);
  const mirror = kind === 'tastytrade' ? new TastytradePaperBroker({ env, audit }) : null;

  return new MirroredBroker({ primary, mirror, store, clock });
}

module.exports = { createBroker };
