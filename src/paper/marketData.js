// src/paper/marketData.js — live option prices for validation and marks
//
//   PAPER_MARKET_DATA=tastytrade  production tastytrade feed, read-only (uses TASTYTRADE_* in .env)
//   PAPER_MARKET_DATA=tradeforge  your running TradeForge's /api/options (TRADEFORGE_URL)
//   FakeMarket (below) is for the automated tests only; the app refuses it at runtime.
//
// Every source returns the same shape:
//   getChain(symbol, expiry, { strikeRange: [lo, hi] }) →
//     { symbol, expiry, underlying, at, source, contracts: [{ type, strike, occ, bid, ask, mid, delta, iv }] }

const https = require('https');
const axios = require('axios');

const INDEX_ROOTS = { SPX: 'SPXW', NDX: 'NDXP', RUT: 'RUTW', XSP: 'XSP' };

function bareSymbol(s) { return String(s).trim().toUpperCase().replace(/^\$/, ''); }

// ── Schwab-shaped chain → common shape (used by tastytrade and tradeforge sources)
function fromSchwabShape(symbol, expiry, chain, source) {
  const out = [];
  for (const [side, map] of [['call', chain.callExpDateMap || {}], ['put', chain.putExpDateMap || {}]]) {
    for (const [key, strikes] of Object.entries(map)) {
      if (!key.startsWith(expiry)) continue;
      for (const [k, arr] of Object.entries(strikes)) {
        const o = (arr || [])[0];
        if (!o) continue;
        const bid = num(o.bid), ask = num(o.ask);
        out.push({
          type: side, strike: Number(k), occ: o.symbol,
          bid, ask, mid: bid > 0 || ask > 0 ? r2((bid + ask) / 2) : num(o.mark),
          delta: num(o.delta), iv: o.volatility > 0 ? o.volatility / 100 : null,
          gamma: num(o.gamma), theta: num(o.theta), vega: num(o.vega), oi: num(o.openInterest),
        });
      }
    }
  }
  return { symbol: bareSymbol(symbol), expiry, underlying: num(chain.underlyingPrice), at: new Date().toISOString(), source, contracts: out };
}

class TastytradeMarket {
  constructor(hub) { this.hub = hub; this.name = 'tastytrade'; }
  async getChain(symbol, expiry, { strikeRange } = {}) {
    const opts = { fromDate: expiry, toDate: expiry, contractType: 'ALL', strikeCount: 400 };
    if (strikeRange) { opts.fromStrike = strikeRange[0]; opts.toStrike = strikeRange[1]; }
    const chain = await this.hub.getOptionsChain(bareSymbol(symbol), opts);
    return fromSchwabShape(symbol, expiry, chain, 'tastytrade');
  }
  async getExpirations(symbol) {
    const r = await this.hub.getExpirationChain(bareSymbol(symbol));
    return (r.expirationList || []).map(e => e.expirationDate);
  }
  async getUnderlying(symbol) {
    const q = await this.hub.getQuotes([bareSymbol(symbol)]);
    const v = Object.values(q)[0];
    return v ? num(v.quote.lastPrice) || num(v.quote.mark) : null;
  }
}

class TradeForgeMarket {
  constructor(baseUrl) {
    this.name = 'tradeforge';
    this.base = (baseUrl || 'https://127.0.0.1:3000').replace(/\/$/, '');
    // Local TradeForge uses a self-signed certificate; only trust it on this machine.
    const local = /^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.base);
    this.http = axios.create({ timeout: 15000, httpsAgent: new https.Agent({ rejectUnauthorized: !local }) });
  }
  async getChain(symbol, expiry, { strikeRange } = {}) {
    const params = { strikes: 400, type: 'ALL', fromDate: expiry, toDate: expiry };
    if (strikeRange) { params.fromStrike = strikeRange[0]; params.toStrike = strikeRange[1]; }
    const r = await this.http.get(`${this.base}/api/options/${encodeURIComponent(bareSymbol(symbol))}`, { params });
    return fromSchwabShape(symbol, expiry, r.data, 'tradeforge');
  }
  async getExpirations(symbol) {
    const s = bareSymbol(symbol);
    const r = await this.http.get(`${this.base}/api/expirations/${encodeURIComponent(['SPX', 'VIX', 'NDX', 'RUT'].includes(s) ? '$' + s : s)}`);
    return (r.data?.expirationList || []).map(e => e.expirationDate || e).filter(Boolean);
  }
  async getUnderlying(symbol) {
    const r = await this.http.get(`${this.base}/api/quotes/${encodeURIComponent(bareSymbol(symbol))}`);
    const v = Object.values(r.data || {})[0];
    return v ? num(v.quote?.lastPrice) || num(v.quote?.mark) : null;
  }
}

// ── Simulated market (deterministic, driven by the Paper Desk clock) ─────────
const FAKE_SPOTS = { SPX: 7650, AMD: 160, SPCX: 152, SPY: 765, QQQ: 600 };
const FAKE_IV = { SPX: 0.15, SPY: 0.15, QQQ: 0.2, AMD: 0.45 };

class FakeMarket {
  constructor(clock) {
    this.name = 'fake';
    this.clock = clock;
    this.spots = { ...FAKE_SPOTS };
  }
  setSpot(symbol, price) { this.spots[bareSymbol(symbol)] = Number(price); }
  spot(symbol) { const s = bareSymbol(symbol); return this.spots[s] ?? 100; }
  step(symbol) { const s = bareSymbol(symbol), px = this.spot(s); return s === 'SPX' ? 5 : px >= 100 ? 2.5 : px >= 25 ? 1 : 0.5; }

  expirations(symbol) {
    const out = [];
    let ms = this.clock.atET(this.clock.today(), '12:00');
    while (out.length < 12) {
      const e = this.clock.et(ms);
      if (e.weekday >= 1 && e.weekday <= 5) out.push(e.date);
      ms += 86_400_000;
    }
    return out;
  }

  async getUnderlying(symbol) { return this.spot(symbol); }
  async getExpirations(symbol) { return this.expirations(symbol); }

  async getChain(symbol, expiry, { strikeRange } = {}) {
    const s = bareSymbol(symbol);
    const S = this.spot(s);
    if (!this.expirations(s).includes(expiry)) {
      return { symbol: s, expiry, underlying: S, at: this.clock.iso(), source: 'fake', contracts: [] };
    }
    const step = this.step(s);
    const lo = strikeRange ? Math.min(...strikeRange) : S * 0.85;
    const hi = strikeRange ? Math.max(...strikeRange) : S * 1.15;
    const T = Math.max(60_000, this.clock.atET(expiry, '16:00') - this.clock.now()) / (365 * 86_400_000);
    const baseIv = FAKE_IV[s] ?? 0.35;
    const root = INDEX_ROOTS[s] || s;
    const contracts = [];
    for (let K = Math.ceil(lo / step) * step; K <= hi + 1e-9; K = r2(K + step)) {
      const m = Math.log(K / S);
      const iv = baseIv * (1 + (m < 0 ? -m * 4 : m * 1.5)); // simple put skew
      for (const type of ['call', 'put']) {
        const { price, delta } = bs(type, S, K, T, iv);
        const mid = Math.max(0.025, price);
        const half = Math.max(0.025, mid * 0.03);
        contracts.push({
          type, strike: K, occ: occ(root, expiry, type, K),
          bid: r2(Math.max(0, mid - half)), ask: r2(mid + half), mid: r2(mid), delta: r4(delta), iv: r4(iv),
        });
      }
    }
    return { symbol: s, expiry, underlying: S, at: this.clock.iso(), source: 'fake', contracts };
  }
}

function bs(type, S, K, T, v) {
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / sq, d2 = d1 - sq;
  const call = S * ncdf(d1) - K * ncdf(d2);
  return type === 'call' ? { price: call, delta: ncdf(d1) } : { price: call - S + K, delta: ncdf(d1) - 1 };
}
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function occ(root, expiry, type, strike) {
  const [y, m, d] = expiry.split('-');
  return `${root.padEnd(6)}${y.slice(2)}${m}${d}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

function createMarket({ kind, clock, hub, tradeforgeUrl }) {
  if (kind === 'tradeforge') return new TradeForgeMarket(tradeforgeUrl);
  if (kind === 'tastytrade') {
    if (!hub) {
      const { TastyMarketData } = require('../tastytrade/hub');
      hub = new TastyMarketData();
    }
    if (!hub.configured) throw new Error('PAPER_MARKET_DATA=tastytrade needs TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN in .env (read-only production grant)');
    return new TastytradeMarket(hub);
  }
  throw new Error(`Unknown PAPER_MARKET_DATA "${kind}" (use tastytrade or tradeforge)`);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(v * 100) / 100; }
function r4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { createMarket, FakeMarket, TastytradeMarket, TradeForgeMarket, fromSchwabShape, occ, bareSymbol };
