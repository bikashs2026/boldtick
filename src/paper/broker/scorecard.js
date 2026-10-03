// src/paper/broker/scorecard.js — the live-market scorecard ("paper fills from live prices")
//
// This is Paper Desk's source of truth for fills, positions and P&L. Orders
// fill only when the LIVE market reaches the limit:
//   fill model "mid"      credit: live mid ≥ limit   debit: live mid ≤ limit
//   fill model "natural"  credit: natural (sell at bid, buy at ask) ≥ limit   debit: natural ≤ limit
// and always fill at the limit price (a limit order never gets a worse price).
// Nothing fills outside regular hours (9:30 AM–4:00 PM ET, weekdays), when
// quotes are stale. Day orders still working at 4:00 PM ET expire. Positions settle at intrinsic
// value from the live underlying after expiration.
//
// Every fill records the live mid and natural price at that moment, so the
// fill can be audited later.
//
// mode "instant" (tests only) fills every order at its limit immediately.

const { BrokerError } = require('./errors');

const SIGN = { STO: -1, STC: -1, BTO: 1, BTC: 1 };
const FINAL = new Set(['filled', 'cancelled', 'rejected', 'expired']);

class ScorecardBroker {
  constructor({ store, clock, market, mode = 'live', fillModel = () => 'mid', shares = '', startingCash = 100000, audit = () => {} }) {
    this.name = mode === 'instant' ? 'instant (test)' : 'live-market';
    this.mode = mode === 'instant' ? 'instant' : 'live';
    this.store = store;
    this.clock = clock;
    this.market = market;
    this.fillModel = fillModel;
    this.audit = audit;
    this.shares = parseShares(shares);
    this.startingCash = Number(startingCash) || 100000;
  }

  async init() {
    this.state = this.store.load('scorecard.json', { seq: 0, orders: [], positions: {}, cash: this.startingCash });
  }

  _save() { this.store.save('scorecard.json', this.state); }

  async dryRun(order) {
    checkOrder(order);
    return { ok: true, buyingPowerEffect: null, fees: 0, warnings: [] };
  }

  async submitOrder(order) {
    checkOrder(order);
    const existing = this.state.orders.find(o => o.externalId === order.externalId);
    if (existing) return view(existing); // idempotent on external id
    const now = this.clock.now();
    const o = {
      brokerOrderId: `SC-${++this.state.seq}`,
      externalId: order.externalId,
      legs: order.legs,
      limitPrice: order.limitPrice,
      priceEffect: order.priceEffect,
      quantity: order.legs[0].quantity,
      status: 'working',
      filledQuantity: 0,
      avgFillPrice: null,
      fillContext: null,
      submittedAt: now,
      submittedDate: this.clock.et(now).date,
      updatedAt: new Date(now).toISOString(),
    };
    this.state.orders.push(o);
    await this._tryFill(o); // marketable orders fill right away
    this._save();
    this.audit({ broker: this.name, call: 'submitOrder', request: order, response: view(o) });
    return view(o);
  }

  async cancelOrder(brokerOrderId) {
    const o = this._find(brokerOrderId);
    if (o.status === 'working') { o.status = 'cancelled'; o.updatedAt = this.clock.iso(); this._save(); }
    this.audit({ broker: this.name, call: 'cancelOrder', request: { brokerOrderId }, response: view(o) });
    return view(o);
  }

  async getOrders() {
    const et = this.clock.et();
    for (const o of this.state.orders) {
      if (o.status !== 'working') continue;
      if (o.submittedDate < et.date || et.minutes >= 960) { // Day order: done at 4:00 PM ET
        o.status = 'expired'; o.updatedAt = this.clock.iso();
        continue;
      }
      await this._tryFill(o);
    }
    this._save();
    return this.state.orders.filter(o => !FINAL.has(o.status) || this.clock.now() - Date.parse(o.updatedAt) < 3 * 86_400_000).map(view);
  }

  async getOrder(brokerOrderId) { return view(this._find(brokerOrderId)); }

  async getPositions() {
    await this._settleExpired();
    const out = Object.entries(this.state.positions)
      .filter(([, p]) => p.quantity !== 0)
      .map(([occSymbol, p]) => ({ occSymbol, quantity: p.quantity, avgOpenPrice: 0, multiplier: 100, instrumentType: 'Equity Option' }));
    for (const [sym, qty] of Object.entries(this.shares)) out.push({ occSymbol: sym, quantity: qty, avgOpenPrice: 0, multiplier: 1, instrumentType: 'Equity' });
    return out;
  }

  async getBalance() {
    return { netLiq: null, buyingPower: null, cash: round(this.state.cash) };
  }

  async sharesHeld(symbol) { return this.shares[String(symbol).toUpperCase()] || 0; }

  // ── internals ──
  _find(id) {
    const o = this.state.orders.find(x => x.brokerOrderId === id);
    if (!o) throw new BrokerError('not_found', `order ${id} not found`);
    return o;
  }

  async _tryFill(o) {
    let ctx = null;
    if (this.mode === 'live') {
      if (!this.clock.isMarketHours()) return; // quotes outside 9:30–4:00 ET are stale
      ctx = await this._livePrice(o).catch(() => null);
      if (!ctx) return; // no live quote → no fill
      const model = this.fillModel() === 'natural' ? 'natural' : 'mid';
      const px = ctx[model];
      const reached = o.priceEffect === 'credit' ? px >= o.limitPrice - 1e-9 : px <= o.limitPrice + 1e-9;
      if (!reached) return;
      ctx.model = model;
    }
    o.status = 'filled';
    o.filledQuantity = o.quantity;
    o.avgFillPrice = o.limitPrice;
    o.fillContext = ctx ? { ...ctx, at: this.clock.iso() } : null;
    o.updatedAt = this.clock.iso();
    for (const l of o.legs) {
      const p = this.state.positions[l.occSymbol] || { quantity: 0, meta: l.meta };
      p.quantity += SIGN[l.side] * l.quantity;
      p.meta = l.meta || p.meta;
      this.state.positions[l.occSymbol] = p;
    }
    this.state.cash += (o.priceEffect === 'credit' ? 1 : -1) * o.limitPrice * 100 * o.quantity;
  }

  // Live mid and natural for the whole order, per unit, as a positive price.
  async _livePrice(o) {
    let mid = 0, natural = 0, underlying = null;
    const chains = new Map();
    for (const l of o.legs) {
      const m = l.meta;
      if (!m) return null;
      const key = `${m.symbol}|${m.expiry}`;
      if (!chains.has(key)) {
        const lo = Math.min(...o.legs.filter(x => x.meta?.expiry === m.expiry).map(x => x.meta.strike));
        const hi = Math.max(...o.legs.filter(x => x.meta?.expiry === m.expiry).map(x => x.meta.strike));
        chains.set(key, await this.market.getChain(m.symbol, m.expiry, { strikeRange: [lo, hi] }));
      }
      const chain = chains.get(key);
      underlying = chain.underlying || underlying;
      const c = chain.contracts.find(x => x.type === m.type && Number(x.strike) === Number(m.strike));
      if (!c || !(c.mid > 0 || c.bid > 0 || c.ask > 0)) return null;
      const n = l.quantity / o.quantity;
      if (SIGN[l.side] < 0) { mid += n * c.mid; natural += n * c.bid; }   // selling: receive
      else { mid -= n * c.mid; natural -= n * c.ask; }                    // buying: pay
    }
    if (o.priceEffect === 'debit') { mid = -mid; natural = -natural; }
    return { mid: round(mid), natural: round(natural), underlying };
  }

  // Remove legs whose expiration has passed (4:15 PM ET on expiry day), settling cash at intrinsic.
  async _settleExpired() {
    const nowEt = this.clock.et();
    let changed = false;
    for (const p of Object.values(this.state.positions)) {
      if (!p.quantity || !p.meta) continue;
      const done = p.meta.expiry < nowEt.date || (p.meta.expiry === nowEt.date && nowEt.minutes >= 975);
      if (!done) continue;
      const spot = await this.market.getUnderlying(p.meta.symbol).catch(() => null);
      if (spot == null) continue; // try again on the next sync
      const intrinsic = Math.max(0, p.meta.type === 'call' ? spot - p.meta.strike : p.meta.strike - spot);
      this.state.cash += p.quantity * intrinsic * 100;
      p.quantity = 0;
      changed = true;
    }
    if (changed) this._save();
  }
}

function checkOrder(order) {
  if (!order || !Array.isArray(order.legs) || !order.legs.length) throw new BrokerError('invalid_order', 'order needs legs');
  for (const l of order.legs) {
    if (!l.occSymbol || !SIGN[l.side] || !(l.quantity > 0)) throw new BrokerError('invalid_order', 'each leg needs occSymbol, side (BTO/STO/BTC/STC) and quantity');
  }
  if (!(order.limitPrice > 0)) throw new BrokerError('invalid_order', 'limit price must be positive');
  if (!['credit', 'debit'].includes(order.priceEffect)) throw new BrokerError('invalid_order', 'priceEffect must be credit or debit');
}

function view(o) {
  return {
    brokerOrderId: o.brokerOrderId, externalId: o.externalId, status: o.status,
    quantity: o.quantity, filledQuantity: o.filledQuantity, avgFillPrice: o.avgFillPrice,
    fillContext: o.fillContext || null,
    legs: o.legs.map(l => ({ occSymbol: l.occSymbol, side: l.side, quantity: l.quantity })),
    rejectReason: null, updatedAt: o.updatedAt, raw: null,
  };
}

function parseShares(s) {
  const out = {};
  for (const part of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const [sym, qty] = part.split(':');
    if (sym && Number(qty) > 0) out[sym.toUpperCase()] = Number(qty);
  }
  return out;
}

function round(v) { return Math.round(v * 100) / 100 + 0; }

module.exports = { ScorecardBroker };
