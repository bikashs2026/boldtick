// src/paper/broker/tastytradePaper.js — tastytrade PAPER (sandbox) broker
//
// Refuses to start unless every guard passes:
//   1. host is exactly https://api.cert.tastyworks.com (no override)
//   2. credentials come from TT_PAPER_* names only, never the production TASTYTRADE_* ones
//   3. the paper refresh token is not the production one
//   4. TT_PAPER_ACCOUNT is one of the accounts the paper login can see
//
//   TT_PAPER_CLIENT_SECRET, TT_PAPER_REFRESH_TOKEN, TT_PAPER_ACCOUNT  (required)
//   TT_PAPER_CLIENT_ID                                                 (optional)
//   TT_PAPER_PRICE_STYLE=effect|signed   order price as price + "price-effect" (default)
//                                        or as a signed number; the sandbox spike tells which

const { TastyClient } = require('../../tastytrade/client');
const { BrokerError } = require('./errors');

const PAPER_HOST = 'https://api.cert.tastyworks.com';
const ACTION = { STO: 'Sell to Open', BTO: 'Buy to Open', STC: 'Sell to Close', BTC: 'Buy to Close' };
const STATUS = {
  Received: 'received', Routed: 'working', 'In Flight': 'working', Live: 'working', Contingent: 'working',
  'Cancel Requested': 'working', 'Replace Requested': 'working',
  Filled: 'filled', Cancelled: 'cancelled', Expired: 'expired', Rejected: 'rejected', Removed: 'cancelled', 'Partially Removed': 'cancelled',
};

class TastytradePaperBroker {
  constructor({ env = process.env, audit = () => {}, client = null } = {}) {
    this.name = 'tastytrade-paper';
    this.audit = audit;

    if (env.TT_PAPER_API_URL && env.TT_PAPER_API_URL.replace(/\/$/, '') !== PAPER_HOST) {
      throw new Error(`Paper broker refuses host ${env.TT_PAPER_API_URL}: only ${PAPER_HOST} is allowed`);
    }
    const missing = ['TT_PAPER_CLIENT_SECRET', 'TT_PAPER_REFRESH_TOKEN', 'TT_PAPER_ACCOUNT'].filter(k => !env[k]);
    if (missing.length) throw new Error(`Paper broker needs ${missing.join(', ')} in .env (paper/sandbox credentials only)`);
    if (env.TASTYTRADE_REFRESH_TOKEN && env.TT_PAPER_REFRESH_TOKEN === env.TASTYTRADE_REFRESH_TOKEN) {
      throw new Error('TT_PAPER_REFRESH_TOKEN is the same as the production TASTYTRADE_REFRESH_TOKEN — use the sandbox grant');
    }
    if (env.TASTYTRADE_CLIENT_SECRET && env.TT_PAPER_CLIENT_SECRET === env.TASTYTRADE_CLIENT_SECRET) {
      throw new Error('TT_PAPER_CLIENT_SECRET is the same as the production TASTYTRADE_CLIENT_SECRET — use the sandbox OAuth app');
    }
    this.account = String(env.TT_PAPER_ACCOUNT).trim();
    this.priceStyle = env.TT_PAPER_PRICE_STYLE === 'signed' ? 'signed' : 'effect';
    this.client = client || new TastyClient({
      useEnv: false,
      baseURL: PAPER_HOST,
      clientId: env.TT_PAPER_CLIENT_ID || undefined,
      clientSecret: env.TT_PAPER_CLIENT_SECRET,
      refreshToken: env.TT_PAPER_REFRESH_TOKEN,
      scope: 'read trade',
    });
    this._assertHost();
  }

  _assertHost() {
    if (this.client.baseURL !== PAPER_HOST) throw new Error(`Paper broker client points at ${this.client.baseURL}; refusing`);
  }

  async _call(method, url, opts = {}) {
    this._assertHost();
    const started = Date.now();
    try {
      const res = await this.client.request(method, url, opts);
      this.audit({ broker: 'tastytrade-paper', call: `${method.toUpperCase()} ${url}`, request: opts.data || opts.params || null, response: res, ms: Date.now() - started });
      return res;
    } catch (e) {
      this.audit({ broker: 'tastytrade-paper', call: `${method.toUpperCase()} ${url}`, request: opts.data || opts.params || null, error: e.message, status: e.status || null, ms: Date.now() - started });
      throw new BrokerError(e.status ? 'broker_rejected' : 'network', e.message, { status: e.status });
    }
  }

  async init() {
    const r = await this._call('get', '/customers/me/accounts');
    const accounts = (r?.data?.items || []).map(i => i.account?.['account-number'] || i['account-number']).filter(Boolean);
    if (!accounts.includes(this.account)) {
      throw new Error(`TT_PAPER_ACCOUNT ${this.account} is not visible to this paper login (found: ${accounts.join(', ') || 'none'})`);
    }
  }

  toTastyOrder(order) {
    const credit = order.priceEffect === 'credit';
    const body = {
      'time-in-force': order.timeInForce || 'Day',
      'order-type': 'Limit',
      price: this.priceStyle === 'signed' ? (credit ? order.limitPrice : -order.limitPrice) : order.limitPrice,
      'external-identifier': order.externalId,
      legs: order.legs.map(l => ({
        'instrument-type': 'Equity Option',
        symbol: l.occSymbol,
        quantity: l.quantity,
        action: ACTION[l.side],
      })),
    };
    if (this.priceStyle === 'effect') body['price-effect'] = credit ? 'Credit' : 'Debit';
    return body;
  }

  async dryRun(order) {
    try {
      const r = await this._call('post', `/accounts/${this.account}/orders/dry-run`, { data: this.toTastyOrder(order) });
      const d = r?.data || {};
      return {
        ok: true,
        buyingPowerEffect: num(d['buying-power-effect']?.['change-in-buying-power']),
        fees: num(d['fee-calculation']?.['total-fees']),
        warnings: (d.warnings || []).map(w => w.message || String(w)),
      };
    } catch (e) {
      if (e.code === 'broker_rejected') return { ok: false, buyingPowerEffect: null, fees: null, warnings: [e.message] };
      throw e;
    }
  }

  async submitOrder(order) {
    try {
      const r = await this._call('post', `/accounts/${this.account}/orders`, { data: this.toTastyOrder(order) });
      return fromTastyOrder(r?.data?.order || r?.data);
    } catch (e) {
      // A timeout may still have placed the order: look it up before anyone retries.
      if (e.code === 'network') {
        const found = (await this.getOrders().catch(() => [])).find(o => o.externalId === order.externalId);
        if (found) return found;
      }
      throw e;
    }
  }

  async cancelOrder(brokerOrderId) {
    const r = await this._call('delete', `/accounts/${this.account}/orders/${encodeURIComponent(brokerOrderId)}`);
    return fromTastyOrder(r?.data);
  }

  async getOrders() {
    const live = await this._call('get', `/accounts/${this.account}/orders/live`);
    const items = live?.data?.items || [];
    return items.map(fromTastyOrder);
  }

  async getOrder(brokerOrderId) {
    const r = await this._call('get', `/accounts/${this.account}/orders/${encodeURIComponent(brokerOrderId)}`);
    return fromTastyOrder(r?.data);
  }

  async getPositions() {
    const r = await this._call('get', `/accounts/${this.account}/positions`);
    return (r?.data?.items || []).map(p => ({
      occSymbol: p.symbol,
      quantity: (p['quantity-direction'] === 'Short' ? -1 : 1) * num(p.quantity),
      avgOpenPrice: num(p['average-open-price']),
      multiplier: num(p.multiplier) || 100,
      instrumentType: p['instrument-type'],
    }));
  }

  async getBalance() {
    const r = await this._call('get', `/accounts/${this.account}/balances`);
    const d = r?.data || {};
    return {
      netLiq: num(d['net-liquidating-value']),
      buyingPower: num(d['derivative-buying-power'] ?? d['equity-buying-power']),
      cash: num(d['cash-balance']),
    };
  }

  async sharesHeld(symbol) {
    const pos = await this.getPositions();
    const p = pos.find(x => x.instrumentType === 'Equity' && String(x.occSymbol).toUpperCase() === String(symbol).toUpperCase());
    return p ? Math.max(0, p.quantity) : 0;
  }
}

function fromTastyOrder(o) {
  if (!o) throw new BrokerError('broker_rejected', 'empty order in tastytrade response');
  const legs = (o.legs || []).map(l => {
    const qty = num(l.quantity);
    const remaining = l['remaining-quantity'] != null ? num(l['remaining-quantity']) : qty;
    const fills = l.fills || [];
    const fq = fills.reduce((s, f) => s + num(f.quantity || f['fill-quantity']), 0);
    const avg = fq ? fills.reduce((s, f) => s + num(f['fill-price']) * num(f.quantity || f['fill-quantity']), 0) / fq : null;
    return { occSymbol: l.symbol, action: l.action, quantity: qty, filled: Math.max(0, qty - remaining), avg };
  });
  const quantity = legs.length ? Math.min(...legs.map(l => l.quantity)) : num(o.size);
  const filledQuantity = legs.length ? Math.min(...legs.map(l => l.filled)) : 0;
  let avgFillPrice = null;
  if (filledQuantity > 0 && legs.every(l => l.avg != null)) {
    const net = legs.reduce((s, l) => s + (String(l.action).startsWith('Sell') ? 1 : -1) * l.avg * (l.quantity / quantity), 0);
    avgFillPrice = Math.round(Math.abs(net) * 100) / 100;
  }
  let status = STATUS[o.status] || 'working';
  if (status === 'working' && filledQuantity > 0 && filledQuantity < quantity) status = 'partially_filled';
  if (status === 'filled' && filledQuantity === 0) { /* some payloads omit fills; trust status */ }
  return {
    brokerOrderId: String(o.id),
    externalId: o['external-identifier'] || null,
    status,
    quantity,
    filledQuantity: status === 'filled' && filledQuantity === 0 ? quantity : filledQuantity,
    avgFillPrice: avgFillPrice ?? (status === 'filled' ? Math.abs(num(o.price)) : null),
    legs: legs.map(l => ({ occSymbol: l.occSymbol, action: l.action, quantity: l.quantity })),
    rejectReason: o['reject-reason'] || null,
    updatedAt: o['updated-at'] || null,
    raw: o,
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

module.exports = { TastytradePaperBroker, fromTastyOrder, PAPER_HOST };
