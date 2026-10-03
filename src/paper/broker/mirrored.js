// src/paper/broker/mirrored.js — scorecard first, tastytrade paper account as a mirror
//
// Every order goes to the live-market scorecard (the source of truth for fills,
// positions and P&L) AND, when configured, to the tastytrade paper (sandbox)
// account. The sandbox's own fill rules are artificial (limits under $3 fill at
// once, $3+ never fill) and it resets every 24 hours, so its results are kept
// for comparison only. A sandbox failure never blocks or changes the scorecard.

class MirroredBroker {
  constructor({ primary, mirror = null, store, clock }) {
    this.primary = primary;
    this.mirror = mirror;
    this.store = store;
    this.clock = clock;
    this.name = primary.name;
    this.mirrorState = { ok: null, error: null, account: mirror ? mirror.account : null, checked_at: null, balance: null };
  }

  async init() {
    await this.primary.init();
    this.map = this.store.load('mirror.json', {}); // externalId -> mirror order info
    if (this.mirror) {
      // Paper-only guards live in the adapter's constructor and init(): a wrong host,
      // wrong credentials or an account the paper login can't see stop startup.
      // A network hiccup doesn't — the scorecard runs and the mirror reports the error.
      try {
        await this.mirror.init();
        this._mirrorOk();
      } catch (e) {
        if (e.code !== 'network') throw e;
        this._mirrorFailed(e);
      }
    }
  }

  mirrorStatus() {
    return this.mirror ? { name: this.mirror.name, ...this.mirrorState } : { name: null, ok: null, error: 'no paper account configured (TT_PAPER_* in .env)' };
  }

  mirrorInfo(externalId) { return externalId && this.map ? this.map[externalId] || null : null; }

  _setMirror(externalId, info) {
    this.map[externalId] = { ...(this.map[externalId] || {}), ...info, updated_at: this.clock.iso() };
    this.store.save('mirror.json', this.map);
  }

  _mirrorFailed(e) {
    this.mirrorState.ok = false;
    this.mirrorState.error = e.message;
    this.mirrorState.checked_at = this.clock.iso();
  }

  _mirrorOk() {
    this.mirrorState.ok = true;
    this.mirrorState.error = null;
    this.mirrorState.checked_at = this.clock.iso();
  }

  async dryRun(order) {
    const res = await this.primary.dryRun(order);
    if (this.mirror) {
      try {
        const m = await this.mirror.dryRun(order);
        this._mirrorOk();
        res.mirror = m;
        if (!m.ok) res.warnings = [...(res.warnings || []), `paper account dry-run: ${m.warnings.join('; ')}`];
      } catch (e) {
        this._mirrorFailed(e);
        res.warnings = [...(res.warnings || []), `paper account unreachable: ${e.message}`];
      }
    }
    return res;
  }

  async submitOrder(order) {
    const res = await this.primary.submitOrder(order);
    if (this.mirror && order.mirrorAfter) {
      // Closing order: mirror it only if the paper account actually holds the position.
      const entry = this.map[order.mirrorAfter];
      if (!entry || entry.status !== 'filled') {
        this._setMirror(order.externalId, { broker_order_id: null, status: 'skipped', error: entry ? `entry is ${entry.status} in the paper account` : 'entry was never sent to the paper account' });
        return res;
      }
    }
    if (this.mirror) {
      try {
        const m = await this.mirror.submitOrder(order);
        this._mirrorOk();
        this._setMirror(order.externalId, { broker_order_id: m.brokerOrderId, status: m.status, filled: m.filledQuantity, fill_price: m.avgFillPrice, error: null });
      } catch (e) {
        this._mirrorFailed(e);
        this._setMirror(order.externalId, { broker_order_id: null, status: 'rejected', error: e.message });
      }
    }
    return res;
  }

  async cancelOrder(brokerOrderId) {
    const res = await this.primary.cancelOrder(brokerOrderId);
    const info = this.mirrorInfo(res.externalId);
    if (this.mirror && info?.broker_order_id && !['filled', 'cancelled', 'rejected', 'expired'].includes(info.status)) {
      try {
        const m = await this.mirror.cancelOrder(info.broker_order_id);
        this._setMirror(res.externalId, { status: m.status });
      } catch (e) {
        this._setMirror(res.externalId, { error: `cancel: ${e.message}` });
      }
    }
    return res;
  }

  async getOrders() {
    const list = await this.primary.getOrders();
    if (this.mirror) await this._refreshMirror().catch(e => this._mirrorFailed(e));
    return list;
  }

  async getOrder(id) { return this.primary.getOrder(id); }
  async getPositions() { return this.primary.getPositions(); }
  async sharesHeld(symbol) { return this.primary.sharesHeld(symbol); }

  async getBalance() {
    const b = await this.primary.getBalance();
    if (this.mirror) {
      try { this.mirrorState.balance = await this.mirror.getBalance(); this._mirrorOk(); }
      catch (e) { this._mirrorFailed(e); }
    }
    return b;
  }

  async _refreshMirror() {
    const open = Object.entries(this.map).filter(([, m]) => m.broker_order_id && !['filled', 'cancelled', 'rejected', 'expired'].includes(m.status));
    if (!open.length) return;
    const live = await this.mirror.getOrders();
    const byId = new Map(live.map(o => [String(o.brokerOrderId), o]));
    for (const [ext, m] of open) {
      let o = byId.get(String(m.broker_order_id));
      if (!o && this.mirror.getOrder) o = await this.mirror.getOrder(m.broker_order_id).catch(() => null);
      // The sandbox resets every 24 h; an order it no longer knows about is reported as gone.
      if (!o) { this._setMirror(ext, { status: 'expired', error: 'no longer in the paper account (sandbox reset)' }); continue; }
      this._setMirror(ext, { status: o.status, filled: o.filledQuantity, fill_price: o.avgFillPrice });
    }
    this._mirrorOk();
  }
}

module.exports = { MirroredBroker };
