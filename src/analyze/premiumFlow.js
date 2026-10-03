// src/analyze/premiumFlow.js — live net premium flow, from real tastytrade
// Trade prints (not periodic chain polling).
//
// For every option contract the Analyze GEX tab has pulled into the chain,
// a FlowTracker listens to the hub's 'trade' event (every Trade tick on the
// live DXLink feed, emitted in src/tastytrade/hub.js) and, for each new
// print, computes:
//   - the print's size, from the delta in the contract's cumulative
//     dayVolume (never from DXLink's `size` field alone, which is just the
//     last trade's size and can under/over-count when ticks are missed or
//     batched)
//   - its dollar premium (size * price * 100)
//   - which side was aggressive, by comparing the print's price to the
//     contract's prevailing bid/ask at that moment
// and buckets it by 5-minute ET slots for the session, so the Analyze page
// can chart it. Resets at the start of each new ET trading day.
//
// One tracker per (symbol, expiry) — held in a WeakMap keyed by the hub
// instance, so trackers never leak across test runs or server restarts.

const { Clock } = require('../paper/clock');

const BUCKET_MIN = 5;
const MULTIPLIER = 100;

function num(v) { return v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v); }

function emptyTotals() {
  return { callPremium: 0, putPremium: 0, callBuy: 0, callSell: 0, putBuy: 0, putSell: 0 };
}

class FlowTracker {
  constructor(hub, clock = new Clock()) {
    this.hub = hub;
    this.clock = clock;
    this.contracts = new Map();  // streamer symbol -> { side, strike }
    this.baseline = new Map();   // streamer symbol -> last-seen dayVolume
    this.buckets = new Map();    // bucket index (since ET midnight) -> row
    this.totals = emptyTotals();
    this.lastPrint = null;
    this.day = null;
    this._onTrade = (sym, rec) => this._handleTrade(sym, rec);
    hub.on('trade', this._onTrade);
  }

  // Register (or refresh) the contracts this tracker should watch. Safe to
  // call on every poll — contracts already known are left alone.
  trackContracts(list) {
    this._rollDayIfNeeded();
    for (const c of list) {
      if (!c || !c.streamer || this.contracts.has(c.streamer)) continue;
      this.contracts.set(c.streamer, { side: c.side, strike: c.strike });
      // Seed the baseline from whatever the hub already has live, so the
      // first print after we start watching isn't misread as one giant
      // trade equal to the whole day's volume so far.
      const L = this.hub.live.get(c.streamer);
      const dv = L && L.trade && num(L.trade.dayVolume);
      if (dv != null) this.baseline.set(c.streamer, dv);
    }
  }

  recordPriceSample(price) {
    this._rollDayIfNeeded();
    const p = num(price);
    if (p == null) return;
    this._currentBucket().price = p;
  }

  snapshot() {
    this._rollDayIfNeeded();
    const points = [...this.buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({ ...b }));
    return { totals: { ...this.totals }, lastPrint: this.lastPrint, points };
  }

  _rollDayIfNeeded() {
    const d = this.clock.today();
    if (this.day === d) return;
    this.day = d;
    this.buckets = new Map();
    this.baseline = new Map();
    this.totals = emptyTotals();
    this.lastPrint = null;
  }

  _currentBucket() {
    const e = this.clock.et();
    const idx = Math.floor(e.minutes / BUCKET_MIN);
    let b = this.buckets.get(idx);
    if (!b) {
      b = { t: e.hm, callPremium: 0, putPremium: 0, callBuy: 0, callSell: 0, putBuy: 0, putSell: 0, price: null };
      this.buckets.set(idx, b);
    }
    return b;
  }

  _handleTrade(sym, rec) {
    const meta = this.contracts.get(sym);
    if (!meta) return;
    this._rollDayIfNeeded();

    const dayVolume = rec.trade && num(rec.trade.dayVolume);
    const price = rec.trade && num(rec.trade.price);
    if (dayVolume == null || price == null) return;

    const prev = this.baseline.get(sym);
    this.baseline.set(sym, dayVolume);
    if (prev == null) return; // first sighting of this contract — baseline only, no print yet
    const size = dayVolume - prev;
    if (!(size > 0)) return; // no new volume (duplicate tick, or OI/greeks-only update reusing the record)

    const premium = size * price * MULTIPLIER;
    const bid = rec.quote && num(rec.quote.bidPrice);
    const ask = rec.quote && num(rec.quote.askPrice);
    let aggressor = 'mid';
    if (bid != null && ask != null && ask > bid) {
      if (price >= ask) aggressor = 'buy';
      else if (price <= bid) aggressor = 'sell';
      else aggressor = price > (bid + ask) / 2 ? 'buy' : 'sell';
    }

    const b = this._currentBucket();
    const field = meta.side === 'CALL' ? 'call' : 'put';
    this.totals[`${field}Premium`] += premium;
    b[`${field}Premium`] += premium;
    if (aggressor === 'buy' || aggressor === 'sell') {
      this.totals[`${field}${aggressor === 'buy' ? 'Buy' : 'Sell'}`] += premium;
      b[`${field}${aggressor === 'buy' ? 'Buy' : 'Sell'}`] += premium;
    }

    this.lastPrint = { side: meta.side, strike: meta.strike, size, price, aggressor, at: Date.now() };
  }
}

const registries = new WeakMap(); // hub -> Map<key, FlowTracker>

function getFlowTracker(hub, key) {
  let reg = registries.get(hub);
  if (!reg) { reg = new Map(); registries.set(hub, reg); }
  let t = reg.get(key);
  if (!t) { t = new FlowTracker(hub); reg.set(key, t); }
  return t;
}

module.exports = { FlowTracker, getFlowTracker };
