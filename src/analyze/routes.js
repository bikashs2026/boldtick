// src/analyze/routes.js — read-only live market views for the Analyze tabs
// (GEX and Chain). No ideas, orders or settings live here — just quotes,
// expirations, the option chain and the GEX snapshot, straight off the same
// live tastytrade feed Paper Desk already uses. Nothing here places or
// touches an order.

const express = require('express');
const { computeGexSnapshot } = require('../gex');
const { getFlowTracker } = require('./premiumFlow');

const INDEX_ROOTS = new Set(['SPX', 'NDX', 'RUT', 'XSP', 'VIX']);
function bareSymbol(s) { return String(s || '').trim().toUpperCase().replace(/^\$/, ''); }

function makeAnalyzeRouter({ market }) {
  const router = express.Router();
  const hub = market && market.hub; // TastyMarketData — present only when PAPER_MARKET_DATA=tastytrade

  router.use((req, res, next) => {
    if (!hub) return res.status(501).json({ error: { code: 'unavailable', message: 'Analyze needs PAPER_MARKET_DATA=tastytrade (the live tastytrade feed).' } });
    next();
  });

  const fail = (res, e) => res.status(502).json({ error: { code: 'market_data', message: e.message } });

  router.get('/quote/:symbol', async (req, res) => {
    try {
      const symbol = bareSymbol(req.params.symbol);
      const prefixed = INDEX_ROOTS.has(symbol) ? `$${symbol}` : symbol;
      const q = (await hub.getQuotes([prefixed]))[prefixed];
      if (!q) return res.status(404).json({ error: { code: 'not_found', message: `no quote for ${symbol}` } });
      res.json({
        symbol,
        last: q.quote.lastPrice ?? q.quote.mark ?? null,
        change: q.quote.netChange ?? null,
        changePct: q.quote.netPercentChange ?? null,
        prevClose: q.quote.closePrice ?? null,
        source: q.source,
        at: new Date().toISOString(),
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/expirations/:symbol', async (req, res) => {
    try {
      const symbol = bareSymbol(req.params.symbol);
      const prefixed = INDEX_ROOTS.has(symbol) ? `$${symbol}` : symbol;
      const r = await hub.getExpirationChain(prefixed);
      res.json({ symbol, expirations: r.expirationList || [] });
    } catch (e) { fail(res, e); }
  });

  router.get('/chain/:symbol', async (req, res) => {
    try {
      const symbol = bareSymbol(req.params.symbol);
      const prefixed = INDEX_ROOTS.has(symbol) ? `$${symbol}` : symbol;
      const expiry = req.query.expiry || null;
      const strikeCount = Math.min(400, Number(req.query.strikes) || 60);
      const opts = { strikeCount, contractType: 'ALL' };
      if (expiry) { opts.fromDate = expiry; opts.toDate = expiry; }
      const chain = await hub.getOptionsChain(prefixed, opts);
      const rows = [];
      const callKey = Object.keys(chain.callExpDateMap || {}).find(k => !expiry || k.startsWith(expiry)) || Object.keys(chain.callExpDateMap || {})[0];
      const putKey = Object.keys(chain.putExpDateMap || {}).find(k => !expiry || k.startsWith(expiry)) || Object.keys(chain.putExpDateMap || {})[0];
      const calls = (callKey && chain.callExpDateMap[callKey]) || {};
      const puts = (putKey && chain.putExpDateMap[putKey]) || {};
      const strikes = [...new Set([...Object.keys(calls), ...Object.keys(puts)].map(Number))].sort((a, b) => a - b);
      for (const k of strikes) {
        const c = (calls[k] || calls[k.toFixed(1)] || [])[0] || null;
        const p = (puts[k] || puts[k.toFixed(1)] || [])[0] || null;
        rows.push({
          strike: k,
          call: c && { occ: c.symbol, bid: c.bid, ask: c.ask, mark: c.mark, delta: c.delta, gamma: c.gamma, iv: c.volatility, oi: c.openInterest, volume: c.totalVolume },
          put: p && { occ: p.symbol, bid: p.bid, ask: p.ask, mark: p.mark, delta: p.delta, gamma: p.gamma, iv: p.volatility, oi: p.openInterest, volume: p.totalVolume },
        });
      }
      res.json({
        symbol, expiry: (callKey || putKey || '').split(':')[0] || expiry,
        underlying: chain.underlyingPrice, iv: chain.volatility, dataQuality: chain.dataQuality,
        strikes: rows,
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/gex/:symbol', async (req, res) => {
    try {
      const symbol = bareSymbol(req.params.symbol);
      const prefixed = INDEX_ROOTS.has(symbol) ? `$${symbol}` : symbol;
      const expiry = req.query.expiry || null;
      const chain = await hub.getOptionsChain(prefixed, { strikeCount: 400, contractType: 'ALL', ...(expiry ? { fromDate: expiry, toDate: expiry } : {}) });
      const snap = computeGexSnapshot(chain, expiry);
      if (!snap) return res.status(404).json({ error: { code: 'not_found', message: 'no option chain / open interest to compute GEX from' } });
      res.json({ symbol, ...snap });
    } catch (e) { fail(res, e); }
  });

  router.get('/flow/:symbol', async (req, res) => {
    try {
      const symbol = bareSymbol(req.params.symbol);
      const prefixed = INDEX_ROOTS.has(symbol) ? `$${symbol}` : symbol;
      const expiry = req.query.expiry || null;
      const chain = await hub.getOptionsChain(prefixed, { strikeCount: 400, contractType: 'ALL', ...(expiry ? { fromDate: expiry, toDate: expiry } : {}) });
      const callKey = Object.keys(chain.callExpDateMap || {}).find(k => !expiry || k.startsWith(expiry)) || Object.keys(chain.callExpDateMap || {})[0];
      const putKey = Object.keys(chain.putExpDateMap || {}).find(k => !expiry || k.startsWith(expiry)) || Object.keys(chain.putExpDateMap || {})[0];
      if (!callKey && !putKey) return res.status(404).json({ error: { code: 'not_found', message: 'no option chain for that expiry' } });

      const tracker = getFlowTracker(hub, `${symbol}:${callKey || putKey}`);
      const contracts = [];
      for (const arr of Object.values(chain.callExpDateMap[callKey] || {})) for (const o of arr) if (o.streamerSymbol) contracts.push({ streamer: o.streamerSymbol, side: 'CALL', strike: o.strikePrice });
      for (const arr of Object.values(chain.putExpDateMap[putKey] || {})) for (const o of arr) if (o.streamerSymbol) contracts.push({ streamer: o.streamerSymbol, side: 'PUT', strike: o.strikePrice });
      tracker.trackContracts(contracts);
      tracker.recordPriceSample(chain.underlyingPrice);

      res.json({
        symbol,
        expiry: (callKey || putKey || '').split(':')[0] || expiry,
        underlying: chain.underlyingPrice,
        ...tracker.snapshot(),
      });
    } catch (e) { fail(res, e); }
  });

  return router;
}

module.exports = { makeAnalyzeRouter };
