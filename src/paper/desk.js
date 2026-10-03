// src/paper/desk.js — Paper Desk service: ideas → orders → positions → closes
//
// All state changes go through run(), which runs one operation at a time, so
// an HTTP call, the sync loop and the engine loop can never interleave halfway
// through an update.

const { newId } = require('./events');
const { validateIdea } = require('./validate');
const { normLegs, units: unitsOf, riskProfile, openingPrice, mark, closingPrice, roundToTick, legKey, MULT, r2 } = require('./pricing');
const { evaluate, URGENCY } = require('./engine');
const { hmToMinutes } = require('./clock');
const { VERSION } = require('../version');

const SIGNAL_ACTIONS = ['HOLD', 'TAKE_PROFIT', 'STOP', 'ADJUST', 'CLOSE_EXPIRY'];
const ORDER_FINAL = new Set(['filled', 'cancelled', 'rejected', 'expired']);
const ORDER_EVENT = { filled: 'order.filled', partially_filled: 'order.partially_filled', cancelled: 'order.cancelled', expired: 'order.cancelled', rejected: 'order.rejected' };

class DeskError extends Error {
  constructor(status, code, message, details = null, extra = null) {
    super(message);
    this.status = status; this.code = code; this.details = details; this.extra = extra;
  }
}

class PaperDesk {
  constructor({ store, clock, settings, events, market, broker, env = process.env }) {
    Object.assign(this, { store, clock, settings, events, market, broker });
    this.ideas = store.load('ideas.json', []);
    this.orders = store.load('orders.json', []);
    this.positions = store.load('positions.json', []);
    this.state = store.load('state.json', { kill: { on: false } });
    this.signals = store.readLines('signals.jsonl');
    this.killEnv = env.PAPER_KILL === '1';
    this.status_ = { last_sync: null, last_sync_error: null, last_engine: null, last_engine_error: null, balance: null, orphans: [] };
    this._lock = Promise.resolve();
  }

  run(fn) {
    const p = this._lock.then(() => fn());
    this._lock = p.catch(() => {});
    return p;
  }

  save(...names) {
    for (const n of names) {
      if (n === 'ideas') this.store.save('ideas.json', this.ideas);
      if (n === 'orders') this.store.save('orders.json', this.orders);
      if (n === 'positions') this.store.save('positions.json', this.positions);
      if (n === 'state') this.store.save('state.json', this.state);
    }
  }

  nowIso() { return this.clock.iso(); }
  killOn() { return this.killEnv || !!this.state.kill?.on; }

  // ── Ideas ─────────────────────────────────────────────────────────────────
  createIdea(body, caller) {
    return this.run(async () => {
      if (caller === 'muse' && !this.settings.value('muse.accept_ideas')) {
        throw new DeskError(503, 'ideas_paused', 'Accepting ideas from Muse is turned off in Settings.');
      }
      const cid = body && typeof body.client_idea_id === 'string' ? body.client_idea_id : null;
      if (cid) {
        const existing = this.ideas.find(i => i.client_idea_id === cid);
        if (existing) return { status: 200, idea: this.viewIdea(existing) };
      }
      const v = await validateIdea(body, { settings: this.settings, clock: this.clock, market: this.market, stage: 'create', portfolio: await this.portfolio() });
      if (!v.legs.length || !cid || !/^[\w.:-]{1,64}$/.test(cid)) {
        throw new DeskError(422, 'validation_failed', 'Idea failed validation.', v.errors);
      }
      const now = this.clock.now();
      const at = new Date(now).toISOString();
      const invalid = v.errors.length > 0;
      const idea = {
        id: newId('idea', now),
        client_idea_id: cid,
        source: caller,
        status: invalid ? 'invalid' : 'pending',
        received_at: at,
        expires_at: invalid ? at : new Date(this._ideaExpiry(body, v, now)).toISOString(),
        symbol: body.symbol.toUpperCase().replace(/^\$/, ''),
        structure: body.structure,
        expiry: body.expiry,
        legs: v.legs,
        limit_price: Number(body.limit_price),
        credit_or_debit: body.credit_or_debit,
        thesis: body.thesis,
        earnings_flag: !!body.earnings_flag,
        earnings_date: body.earnings_date || null,
        suggested_stop: numOrNull(body.suggested_stop),
        suggested_take_profit: numOrNull(body.suggested_take_profit),
        underlying_price: numOrNull(body.underlying_price),
        confidence: numOrNull(body.confidence),
        muse_max_loss: numOrNull(body.max_loss),
        muse_breakevens: Array.isArray(body.breakevens) ? body.breakevens.map(Number) : null,
        validation: { ok: !invalid, errors: v.errors, warnings: v.warnings, computed: v.computed },
        request: sanitize(body),
        history: [{ at, status: invalid ? 'invalid' : 'pending', by: caller }],
        order_id: null,
        position_id: null,
      };
      this.ideas.push(idea);
      this.save('ideas');
      this.events.emit(invalid ? 'idea.invalid' : 'idea.created', { idea_id: idea.id, data: { client_idea_id: cid, symbol: idea.symbol, structure: idea.structure, errors: v.errors.length ? v.errors : undefined } });
      return { status: invalid ? 422 : 201, idea: this.viewIdea(idea) };
    });
  }

  _ideaExpiry(body, v, now) {
    if (body.ttl_minutes) return now + body.ttl_minutes * 60_000;
    if (v.computed.zero_dte) return now + this.settings.value('entry.ttl_0dte_min') * 60_000;
    const until = this.clock.atET(this.clock.today(), this.settings.value('entry.ttl_other_until'));
    return Math.max(until, now + 5 * 60_000);
  }

  listIdeas({ status } = {}) {
    const want = status ? String(status).split(',') : null;
    // Default: what still needs attention — pending, or approved with the entry order still working.
    const keep = i => want
      ? (want.includes('all') || want.includes(i.status))
      : (i.status === 'pending' || (i.status === 'approved' && !this._orderFinal(i.order_id)));
    return this.ideas.filter(keep).slice().reverse().map(i => this.viewIdea(i));
  }

  getIdea(id) {
    const i = this.ideas.find(x => x.id === id);
    if (!i) throw new DeskError(404, 'not_found', `No idea ${id}`);
    const v = this.viewIdea(i);
    v.order = i.order_id ? this.viewOrder(this.orders.find(o => o.id === i.order_id)) : null;
    v.position = i.position_id ? this.viewPosition(this.positions.find(p => p.id === i.position_id)) : null;
    return v;
  }

  reject(id, body = {}, by = 'owner') {
    return this.run(async () => {
      const idea = this._idea(id);
      if (idea.status !== 'pending') throw new DeskError(409, 'invalid_state', `Idea is ${idea.status}, not pending.`);
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      this._setIdeaStatus(idea, 'rejected', by, reason);
      this.save('ideas');
      this.events.emit('idea.rejected', { idea_id: idea.id, data: { reason } });
      return this.viewIdea(idea);
    });
  }

  approve(id, body = {}, by = 'owner') {
    return this.run(async () => {
      const idea = this._idea(id);
      if (idea.status !== 'pending') throw new DeskError(409, 'invalid_state', `Idea is ${idea.status}, not pending.`);
      if (this.clock.now() > Date.parse(idea.expires_at)) {
        this._setIdeaStatus(idea, 'expired', 'system', 'time-to-live passed');
        this.save('ideas');
        this.events.emit('idea.expired', { idea_id: idea.id });
        throw new DeskError(410, 'idea_expired', `Idea expired at ${idea.expires_at}.`);
      }
      if (this.killOn()) throw new DeskError(423, 'kill_switch_on', 'The kill switch is on; no new orders.');

      let units, limitPrice;
      if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '') {
        units = Number(body.quantity);
        if (!Number.isInteger(units) || units < 1) throw new DeskError(400, 'bad_request', 'quantity must be a whole number ≥ 1');
      }
      if (body.limit_price !== undefined && body.limit_price !== null && body.limit_price !== '') {
        limitPrice = Number(body.limit_price);
        if (!(limitPrice > 0)) throw new DeskError(400, 'bad_request', 'limit_price must be a positive number');
      }

      const v = await validateIdea(idea.request, {
        settings: this.settings, clock: this.clock, market: this.market, stage: 'approve',
        portfolio: await this.portfolio(), overridePrice: limitPrice, overrideUnits: units,
      });
      if (v.errors.length) throw new DeskError(422, 'validation_failed', 'Idea fails a limit or rule now.', v.errors, { warnings: v.warnings });
      if (!v.computed.priced) throw new DeskError(503, 'market_data_unavailable', `No live price for this structure: ${v.computed.market_error || 'quotes missing'}`);

      let price = limitPrice ?? idea.limit_price;
      const movePct = Math.abs(v.computed.live_mid - price) / price * 100;
      if (movePct > this.settings.value('entry.reconfirm_move_pct') && !body.confirm) {
        throw new DeskError(409, 'reprice_required', `Live mid is ${v.computed.live_mid.toFixed(2)}, ${movePct.toFixed(0)}% away from the limit ${price.toFixed(2)}. Confirm or set a new limit.`, null,
          { live_mid: v.computed.live_mid, live_natural: v.computed.live_natural, limit_price: price, move_pct: r2(movePct) });
      }
      price = roundToTick(idea.symbol, price);

      const legs = v.legs.map(l => ({ ...l, occ: v.contracts.get(legKey(l)).occ }));
      const u = unitsOf(legs);
      const orderReq = {
        externalId: idea.id,
        legs: legs.map(l => ({ occSymbol: l.occ, side: l.action === 'sell' ? 'STO' : 'BTO', quantity: l.qty, meta: { symbol: idea.symbol, expiry: l.expiry, type: l.type, strike: l.strike } })),
        limitPrice: price,
        priceEffect: idea.credit_or_debit,
        timeInForce: 'Day',
      };
      const order = this._newOrder({ kind: 'entry', idea, legs, units: u, price, priceEffect: idea.credit_or_debit });
      idea.order_id = order.id;
      idea.approval = { at: this.nowIso(), by, limit_price: price, units: u, warnings: v.warnings, computed: v.computed };
      this._setIdeaStatus(idea, 'approved', by);
      this.events.emit('idea.approved', { idea_id: idea.id, order_id: order.id, data: { limit_price: price, quantity: u } });

      try {
        const dry = await this.broker.dryRun(orderReq);
        order.dry_run = dry;
        if (!dry.ok) {
          this._finishRejected(order, `dry-run rejected: ${dry.warnings.join('; ') || 'no reason given'}`);
        } else {
          const b = await this.broker.submitOrder(orderReq);
          order.broker_order_id = b.brokerOrderId;
          this.events.emit('order.submitted', { idea_id: idea.id, order_id: order.id, data: { broker_order_id: b.brokerOrderId, limit_price: price, quantity: u } });
          this._applyBroker(order, b);
        }
      } catch (e) {
        this._finishRejected(order, `broker error: ${e.message}`);
      }
      this.save('ideas', 'orders', 'positions');
      return { status: 202, idea: this.viewIdea(idea), order: this.viewOrder(order) };
    });
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  _newOrder({ kind, idea, position = null, legs, units, price, priceEffect, priceMode = null }) {
    const at = this.nowIso();
    const id = newId('ord', this.clock.now());
    const order = {
      id,
      external_id: kind === 'entry' ? idea.id : id,
      kind,
      idea_id: idea ? idea.id : position.idea_id,
      position_id: position ? position.id : null,
      symbol: idea ? idea.symbol : position.symbol,
      structure: idea ? idea.structure : position.structure,
      legs: legs.map(l => ({ action: kind === 'close' ? (l.action === 'sell' ? 'buy' : 'sell') : l.action, type: l.type, strike: l.strike, expiry: l.expiry, occ: l.occ })),
      units,
      limit_price: price,
      price_effect: priceEffect,
      price_mode: priceMode,
      status: 'submitting',
      broker_order_id: null,
      filled_quantity: 0,
      avg_fill_price: null,
      reject_reason: null,
      dry_run: null,
      created_at: at,
      updated_at: at,
      history: [{ at, status: 'submitting' }],
    };
    this.orders.push(order);
    return order;
  }

  _finishRejected(order, reason) {
    order.status = 'rejected';
    order.reject_reason = reason;
    order.updated_at = this.nowIso();
    order.history.push({ at: order.updated_at, status: 'rejected', note: reason });
    this.events.emit('order.rejected', { idea_id: order.idea_id, order_id: order.id, position_id: order.position_id, data: { reason } });
    if (order.kind === 'close') this._revertClosing(order);
  }

  _applyBroker(order, b) {
    const prevStatus = order.status, prevFilled = order.filled_quantity;
    let status = b.status === 'received' ? 'working' : b.status;
    order.filled_quantity = Math.max(prevFilled, Number(b.filledQuantity) || 0);
    if (b.avgFillPrice != null) order.avg_fill_price = Number(b.avgFillPrice);
    if (b.fillContext) order.fill_context = b.fillContext;
    if (b.rejectReason) order.reject_reason = b.rejectReason;
    if (status === 'filled' && order.filled_quantity === 0) order.filled_quantity = order.units;
    order.status = status;
    order.updated_at = this.nowIso();
    if (status !== prevStatus) {
      order.history.push({ at: order.updated_at, status, filled: order.filled_quantity });
      const ev = ORDER_EVENT[status];
      if (ev) this.events.emit(ev, { idea_id: order.idea_id, order_id: order.id, position_id: order.position_id, data: { fill_price: order.avg_fill_price, quantity: order.filled_quantity, reason: order.reject_reason || undefined } });
    }
    if (order.filled_quantity > prevFilled) this._onFill(order);
    if (ORDER_FINAL.has(status) && order.kind === 'close' && order.filled_quantity < order.units) this._revertClosing(order);
  }

  _onFill(order) {
    if (order.kind === 'entry') {
      const idea = this.ideas.find(i => i.id === order.idea_id);
      let pos = order.position_id && this.positions.find(p => p.id === order.position_id);
      const legs = order.legs.map(l => ({ ...l, qty: order.filled_quantity }));
      const risk = riskProfile(order.structure, legs, order.avg_fill_price ?? order.limit_price);
      if (!pos) {
        const at = this.nowIso();
        pos = {
          id: newId('pos', this.clock.now()),
          idea_id: order.idea_id,
          order_id: order.id,
          symbol: order.symbol,
          structure: order.structure,
          credit_or_debit: order.price_effect,
          legs,
          units: order.filled_quantity,
          entry_price: order.avg_fill_price ?? order.limit_price,
          opened_at: at,
          status: 'open',
          exit: this._exitSnapshot(idea, order.structure),
          earnings_date: idea ? idea.earnings_date : null,
          thesis: idea ? idea.thesis : null,
          defined: risk.defined,
          max_profit: risk.max_profit,
          max_loss: risk.max_loss,
          breakevens: risk.breakevens,
          mark: null,
          system_signal: { action: 'HOLD', reason: 'just opened', at, changed_at: at },
          muse_signal: null,
          reconcile: null,
          close_order_id: null,
          closed_at: null,
          exit_price: null,
          realized_pnl: null,
          close_reason: null,
        };
        this.positions.push(pos);
        order.position_id = pos.id;
        if (idea) idea.position_id = pos.id;
        this.events.emit('position.opened', { idea_id: order.idea_id, order_id: order.id, position_id: pos.id, data: { units: pos.units, entry_price: pos.entry_price, max_loss: pos.max_loss, max_profit: pos.max_profit } });
      } else {
        pos.units = order.filled_quantity;
        pos.legs = legs;
        pos.entry_price = order.avg_fill_price ?? pos.entry_price;
        Object.assign(pos, { max_profit: risk.max_profit, max_loss: risk.max_loss, breakevens: risk.breakevens });
      }
    } else if (order.kind === 'close' && order.filled_quantity >= order.units) {
      const pos = this.positions.find(p => p.id === order.position_id);
      if (pos && pos.status !== 'closed') {
        const exit = order.avg_fill_price ?? order.limit_price;
        this._close(pos, exit, 'closed');
      }
    }
  }

  _close(pos, exitPrice, reason) {
    const credit = pos.credit_or_debit === 'credit';
    pos.exit_price = r2(exitPrice);
    pos.realized_pnl = r2((credit ? pos.entry_price - exitPrice : exitPrice - pos.entry_price) * MULT * pos.units);
    pos.status = 'closed';
    pos.closed_at = this.nowIso();
    pos.close_reason = reason;
    this.events.emit('position.closed', { idea_id: pos.idea_id, position_id: pos.id, order_id: pos.close_order_id, data: { exit_price: pos.exit_price, realized_pnl: pos.realized_pnl, reason } });
  }

  _revertClosing(order) {
    const pos = this.positions.find(p => p.id === order.position_id);
    if (pos && pos.status === 'closing' && pos.close_order_id === order.id) {
      pos.status = 'open';
      pos.close_order_id = null;
    }
  }

  _exitSnapshot(idea, structure) {
    const rules = this.settings.exitRules(structure);
    if (idea && this.settings.value('exit.muse_overrides')) {
      if (idea.suggested_take_profit != null) rules.take_profit_price = idea.suggested_take_profit;
      if (idea.suggested_stop != null) rules.stop_price = idea.suggested_stop;
    }
    return rules;
  }

  _orderFinal(orderId) {
    const o = this.orders.find(x => x.id === orderId);
    return !o || ORDER_FINAL.has(o.status);
  }

  listOrders({ status } = {}) {
    const want = status ? String(status).split(',') : null;
    return this.orders.filter(o => !want || want.includes(o.status)).slice().reverse().map(o => this.viewOrder(o));
  }

  cancelOrder(orderId, by = 'owner') {
    return this.run(async () => {
      const order = this.orders.find(o => o.id === orderId);
      if (!order) throw new DeskError(404, 'not_found', `No order ${orderId}`);
      if (ORDER_FINAL.has(order.status) || !order.broker_order_id) throw new DeskError(409, 'invalid_state', `Order is ${order.status}.`);
      try {
        const b = await this.broker.cancelOrder(order.broker_order_id);
        this._applyBroker(order, b);
      } catch (e) {
        throw new DeskError(502, 'broker_error', e.message);
      }
      order.history.push({ at: this.nowIso(), status: order.status, note: `cancel requested by ${by}` });
      this.save('ideas', 'orders', 'positions');
      return this.viewOrder(order);
    });
  }

  // ── Positions ─────────────────────────────────────────────────────────────
  listPositions({ status = 'open' } = {}) {
    const closed = status === 'closed';
    const list = this.positions.filter(p => closed ? p.status === 'closed' : p.status !== 'closed').map(p => this.viewPosition(p));
    if (closed) return list.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
    return list.sort((a, b) => URGENCY.indexOf(a.badge.action) - URGENCY.indexOf(b.badge.action));
  }

  closeRequest(posId, body = {}, by = 'owner') {
    return this.run(async () => {
      const pos = this.positions.find(p => p.id === posId);
      if (!pos) throw new DeskError(404, 'not_found', `No position ${posId}`);
      if (pos.status === 'closed') throw new DeskError(409, 'invalid_state', 'Position is already closed.');

      // Re-pricing a working close: cancel the old order first.
      if (pos.status === 'closing' && pos.close_order_id) {
        const old = this.orders.find(o => o.id === pos.close_order_id);
        if (old && !ORDER_FINAL.has(old.status) && old.broker_order_id) {
          const b = await this.broker.cancelOrder(old.broker_order_id).catch(e => { throw new DeskError(502, 'broker_error', e.message); });
          this._applyBroker(old, b);
          if (pos.status === 'closed') { this.save('orders', 'positions'); throw new DeskError(409, 'invalid_state', 'The previous closing order filled first.'); }
        }
      }

      const mode = body.price_mode || this.settings.value('exit.close_price_mode');
      if (!['mid', 'natural', 'limit'].includes(mode)) throw new DeskError(400, 'bad_request', 'price_mode must be mid, natural or limit');
      let price;
      if (mode === 'limit') {
        price = Number(body.limit_price);
        if (!(price > 0)) throw new DeskError(400, 'bad_request', 'limit_price must be a positive number');
      } else {
        await this._markAll([pos]);
        if (!pos.mark || pos.mark.stale) throw new DeskError(503, 'market_data_unavailable', 'No live quotes for every leg; use price_mode "limit".');
        price = closingPrice(pos.mark, mode);
      }
      // Mid/natural prices round toward marketable: up when paying to close, down when collecting.
      const closingEffect = pos.credit_or_debit === 'credit' ? 'debit' : 'credit';
      price = roundToTick(pos.symbol, Math.max(price, 0.01), mode === 'limit' ? 'nearest' : closingEffect === 'debit' ? 'up' : 'down');

      const legs = pos.legs.map(l => ({ ...l, qty: pos.units }));
      const order = this._newOrder({ kind: 'close', position: pos, legs, units: pos.units, price, priceEffect: pos.credit_or_debit === 'credit' ? 'debit' : 'credit', priceMode: mode });
      const entryOrder = this.orders.find(o => o.id === pos.order_id);
      const orderReq = {
        externalId: order.id,
        mirrorAfter: entryOrder ? entryOrder.external_id || entryOrder.idea_id : null,
        legs: pos.legs.map(l => ({ occSymbol: l.occ, side: l.action === 'sell' ? 'BTC' : 'STC', quantity: pos.units, meta: { symbol: pos.symbol, expiry: l.expiry, type: l.type, strike: l.strike } })),
        limitPrice: price,
        priceEffect: order.price_effect,
        timeInForce: 'Day',
      };
      pos.status = 'closing';
      pos.close_order_id = order.id;
      pos.close_requested_at = this.nowIso();
      try {
        const b = await this.broker.submitOrder(orderReq);
        order.broker_order_id = b.brokerOrderId;
        this.events.emit('order.submitted', { idea_id: pos.idea_id, order_id: order.id, position_id: pos.id, data: { kind: 'close', limit_price: price, price_mode: mode, by } });
        this._applyBroker(order, b);
      } catch (e) {
        this._finishRejected(order, `broker error: ${e.message}`);
      }
      this.save('orders', 'positions');
      return { status: 202, order: this.viewOrder(order), position: this.viewPosition(pos) };
    });
  }

  pushSignal(posId, body, caller = 'muse') {
    return this.run(async () => {
      if (!this.settings.value('muse.accept_signals') && caller === 'muse') throw new DeskError(503, 'signals_paused', 'Accepting signals from Muse is turned off in Settings.');
      const errs = [];
      if (!body || typeof body !== 'object') throw new DeskError(400, 'bad_request', 'body must be a JSON object');
      if (!SIGNAL_ACTIONS.includes(body.action)) errs.push({ field: 'action', issue: SIGNAL_ACTIONS.join(', ') });
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) errs.push({ field: 'reason', issue: 'required, up to 2000 characters' });
      for (const k of ['current_value', 'pnl_dollars']) if (body[k] != null && !Number.isFinite(Number(body[k]))) errs.push({ field: k, issue: 'number' });
      if (body.client_signal_id != null && (typeof body.client_signal_id !== 'string' || !/^[\w.:-]{1,64}$/.test(body.client_signal_id))) errs.push({ field: 'client_signal_id', issue: '1–64 characters' });
      if (errs.length) throw new DeskError(422, 'validation_failed', 'Signal failed validation.', errs);

      const pos = this.positions.find(p => p.id === posId);
      if (!pos) throw new DeskError(404, 'not_found', `No position ${posId}`);
      if (pos.status === 'closed') throw new DeskError(409, 'invalid_state', 'Position is closed.');
      if (body.client_signal_id) {
        const dup = this.signals.find(s => s.client_signal_id === body.client_signal_id);
        if (dup) return { status: 200, signal: dup };
      }
      const now = this.clock.now();
      const sig = {
        id: newId('sig', now), position_id: pos.id, source: 'muse', action: body.action, reason: body.reason.trim(),
        current_value: numOrNull(body.current_value), pnl_dollars: numOrNull(body.pnl_dollars),
        client_signal_id: body.client_signal_id || null, at: new Date(now).toISOString(),
      };
      pos.muse_signal = sig;
      this._recordSignal(sig);
      this.save('positions');
      return { status: 201, signal: sig };
    });
  }

  _recordSignal(sig) {
    this.signals.push(sig);
    this.store.append('signals.jsonl', sig);
    this.events.emit('signal.raised', { position_id: sig.position_id, data: { source: sig.source, action: sig.action, reason: sig.reason } });
  }

  listSignals({ after = null, limit = 200 } = {}) {
    let list = this.signals;
    if (after) { const i = list.findIndex(s => s.id === after); list = i >= 0 ? list.slice(i + 1) : list.filter(s => s.id > after); }
    return list.slice(-Math.min(1000, Number(limit) || 200)).reverse();
  }

  applySettingsToOpen(by = 'owner') {
    return this.run(async () => {
      let n = 0;
      for (const p of this.positions.filter(x => x.status !== 'closed')) {
        const keep = { take_profit_price: p.exit?.take_profit_price, stop_price: p.exit?.stop_price };
        p.exit = this.settings.exitRules(p.structure);
        if (keep.take_profit_price != null) p.exit.take_profit_price = keep.take_profit_price;
        if (keep.stop_price != null) p.exit.stop_price = keep.stop_price;
        n++;
      }
      this.save('positions');
      this.events.emit('settings.changed', { data: { applied_to_open_positions: n, by } });
      return { updated: n };
    });
  }

  // ── Marks and engine ──────────────────────────────────────────────────────
  async _markAll(list) {
    const groups = new Map();
    for (const p of list) for (const l of p.legs) {
      const k = `${p.symbol}|${l.expiry}`;
      const g = groups.get(k) || { symbol: p.symbol, expiry: l.expiry, lo: Infinity, hi: -Infinity };
      g.lo = Math.min(g.lo, l.strike); g.hi = Math.max(g.hi, l.strike);
      groups.set(k, g);
    }
    const quotes = new Map(), underlying = new Map(), errors = new Map();
    for (const g of groups.values()) {
      try {
        const chain = await this.market.getChain(g.symbol, g.expiry, { strikeRange: [g.lo, g.hi] });
        if (chain.underlying) underlying.set(g.symbol, chain.underlying);
        for (const c of chain.contracts) quotes.set(`${g.symbol}|${g.expiry}|${c.type}|${Number(c.strike)}`, c);
      } catch (e) { errors.set(g.symbol, e.message); }
    }
    const at = this.nowIso();
    for (const p of list) {
      const q = new Map(p.legs.map(l => [legKey(l), quotes.get(`${p.symbol}|${legKey(l)}`)]).filter(([, v]) => v));
      const m = mark(p.legs.map(l => ({ ...l, qty: p.units })), q, p.credit_or_debit, p.entry_price);
      m.underlying = underlying.get(p.symbol) ?? p.mark?.underlying ?? null;
      m.at = at;
      if (m.stale) m.error = errors.get(p.symbol) || 'missing quote for a leg';
      else if (p.credit_or_debit === 'credit' && p.max_profit > 0) m.pct_max = r2(m.pnl / p.max_profit * 100);
      p.mark = m;
    }
  }

  engineTick() {
    return this.run(async () => {
      const now = this.clock.now();
      const et = this.clock.et(now);
      let changed = false;

      for (const idea of this.ideas) {
        if (idea.status === 'pending' && now > Date.parse(idea.expires_at)) {
          this._setIdeaStatus(idea, 'expired', 'system', 'time-to-live passed');
          this.events.emit('idea.expired', { idea_id: idea.id });
          changed = true;
        }
      }
      if (changed) this.save('ideas');

      // Daily loss limit → kill switch for the rest of the day (auto-resets next day)
      const k = this.state.kill || {};
      if (k.on && k.auto && k.date !== et.date) this._setKill(false, 'new trading day', 'system');
      const lim = this.settings.value('risk.daily_loss_limit');
      if (this.settings.mode('risk.daily_loss_limit') === 'block' && this.realizedToday() <= -lim && !this.state.kill?.on) {
        this._setKill(true, `daily loss limit $${lim} reached`, 'system', { auto: true, date: et.date });
      }

      const open = this.positions.filter(p => p.status !== 'closed');
      if (open.length) {
        await this._markAll(open);
        for (const p of open) {
          const prev = p.system_signal?.action || 'HOLD';
          const res = evaluate({ position: p, mark: p.mark, et, prev });
          if (p.mark?.stale && res.action !== 'CLOSE_EXPIRY' && res.action !== 'ADJUST') continue; // never signal on bad numbers
          if (res.action !== prev) {
            const at = new Date(now).toISOString();
            p.system_signal = { action: res.action, reason: res.reason, at, changed_at: at };
            this._recordSignal({ id: newId('sig', now), position_id: p.id, source: 'system', action: res.action, reason: res.reason, current_value: p.mark?.value ?? null, pnl_dollars: p.mark?.pnl ?? null, at });
          } else if (p.system_signal) {
            p.system_signal.reason = res.reason;
            p.system_signal.at = new Date(now).toISOString();
          }
        }
        this.save('positions');
      }
      this.status_.last_engine = new Date(now).toISOString();
      this.status_.last_engine_error = null;
    }).catch(e => { this.status_.last_engine_error = e.message; throw e; });
  }

  // ── Sync and reconcile ────────────────────────────────────────────────────
  sync() {
    return this.run(async () => {
      try {
        const list = await this.broker.getOrders();
        const byId = new Map(list.map(b => [String(b.brokerOrderId), b]));
        for (const o of this.orders) {
          if (ORDER_FINAL.has(o.status) || !o.broker_order_id) continue;
          let b = byId.get(String(o.broker_order_id));
          if (!b && this.broker.getOrder) b = await this.broker.getOrder(o.broker_order_id).catch(() => null);
          if (b) this._applyBroker(o, b);
        }
        await this._cancelStaleEntries();
        await this._reconcile();
        this.status_.balance = await this.broker.getBalance().catch(() => this.status_.balance);
        this.status_.last_sync = this.nowIso();
        this.status_.last_sync_error = null;
      } catch (e) {
        this.status_.last_sync_error = e.message;
      }
      this.save('ideas', 'orders', 'positions');
      return this.status();
    });
  }

  async _cancelStaleEntries() {
    const now = this.clock.now();
    const today = this.clock.today();
    for (const o of this.orders) {
      if (o.kind !== 'entry' || !['working', 'partially_filled'].includes(o.status) || !o.broker_order_id) continue;
      const zero = o.legs.some(l => l.expiry === today);
      const deadline = zero
        ? Date.parse(o.created_at) + this.settings.value('entry.cancel_unfilled_0dte_min') * 60_000
        : this.clock.atET(today, this.settings.value('entry.cancel_unfilled_other_at'));
      if (now < deadline) continue;
      try {
        const b = await this.broker.cancelOrder(o.broker_order_id);
        this._applyBroker(o, b);
        o.history.push({ at: this.nowIso(), status: o.status, note: 'cancelled: not filled in time' });
        const idea = this.ideas.find(i => i.id === o.idea_id);
        if (idea && o.filled_quantity === 0 && idea.status === 'approved') {
          this._setIdeaStatus(idea, 'expired', 'system', 'entry order not filled in time');
          this.events.emit('idea.expired', { idea_id: idea.id, order_id: o.id, data: { reason: 'entry order not filled in time' } });
        }
      } catch { /* try again next sync */ }
    }
  }

  async _reconcile() {
    const held = await this.broker.getPositions();
    const broker = new Map();
    for (const h of held) if (h.instrumentType !== 'Equity') broker.set(h.occSymbol, (broker.get(h.occSymbol) || 0) + h.quantity);
    const active = this.positions.filter(p => p.status !== 'closed');
    const expected = new Map();
    for (const p of active) for (const l of p.legs) expected.set(l.occ, (expected.get(l.occ) || 0) + (l.action === 'sell' ? -1 : 1) * p.units);

    const et = this.clock.et();
    const legExpired = exp => exp < et.date || (exp === et.date && et.minutes >= 975);
    for (const p of active) {
      const legs = p.legs.map(l => ({ occ: l.occ, expected: expected.get(l.occ) || 0, broker: broker.get(l.occ) || 0 }));
      const bad = legs.filter(s => s.expected !== s.broker);
      if (!bad.length) { if (p.reconcile) p.reconcile = null; continue; }
      if (p.legs.every(l => legExpired(l.expiry)) && p.legs.every(l => !broker.get(l.occ))) {
        await this._closeAtExpiry(p);
        continue;
      }
      const sig = JSON.stringify(bad);
      if (!p.reconcile || p.reconcile.sig !== sig) {
        p.reconcile = { mismatch: true, legs: bad, at: this.nowIso(), sig };
        this.events.emit('reconcile.mismatch', { position_id: p.id, data: { legs: bad } });
      }
    }
    const orphans = [...broker.entries()].filter(([occ, q]) => q !== 0 && !expected.has(occ)).map(([occ, q]) => ({ occ, quantity: q }));
    const sig = JSON.stringify(orphans);
    if (orphans.length && sig !== this.state.orphan_sig) this.events.emit('reconcile.mismatch', { data: { orphans } });
    if (sig !== this.state.orphan_sig) { this.state.orphan_sig = sig; this.save('state'); }
    this.status_.orphans = orphans;
  }

  async _closeAtExpiry(p) {
    let spot = p.mark?.underlying;
    if (!spot) spot = await this.market.getUnderlying(p.symbol).catch(() => null);
    if (!spot) return; // try again next sync
    const intrinsic = l => Math.max(0, l.type === 'call' ? spot - l.strike : l.strike - spot);
    let net = 0; // value of the structure at expiry, per unit (long legs +, short legs −)
    for (const l of p.legs) net += (l.action === 'buy' ? 1 : -1) * intrinsic(l);
    const exit = p.credit_or_debit === 'credit' ? -net : net;
    this._close(p, exit, 'expired');
  }

  // ── Kill switch, portfolio, status ────────────────────────────────────────
  setKill(on, reason, by) {
    return this.run(async () => { this._setKill(!!on, reason, by); return this.status(); });
  }

  _setKill(on, reason, by, extra = {}) {
    this.state.kill = { on, reason: reason || null, by, at: this.nowIso(), ...extra };
    this.save('state');
    this.events.emit('kill_switch.changed', { data: { on, reason: reason || null, by } });
  }

  realizedToday() {
    const today = this.clock.today();
    return r2(this.positions.filter(p => p.status === 'closed' && p.closed_at && this.clock.et(Date.parse(p.closed_at)).date === today)
      .reduce((s, p) => s + (p.realized_pnl || 0), 0));
  }

  tradesToday() {
    const today = this.clock.today();
    return this.ideas.filter(i => i.approval && this.clock.et(Date.parse(i.approval.at)).date === today).filter(i => {
      const o = this.orders.find(x => x.id === i.order_id);
      return o && !(o.status === 'rejected' || ((o.status === 'cancelled' || o.status === 'expired') && o.filled_quantity === 0));
    }).length;
  }

  async portfolio() {
    const open = this.positions.filter(p => p.status !== 'closed').map(p => ({ symbol: p.symbol, max_loss: p.max_loss, defined: p.defined }));
    // Working entry orders count as exposure too.
    for (const o of this.orders.filter(x => x.kind === 'entry' && ['submitting', 'working', 'received'].includes(x.status) && !x.position_id)) {
      const r = riskProfile(o.structure, o.legs.map(l => ({ ...l, qty: o.units })), o.limit_price);
      open.push({ symbol: o.symbol, max_loss: r.max_loss, defined: r.defined });
    }
    return {
      openPositions: open,
      tradesToday: this.tradesToday(),
      realizedToday: this.realizedToday(),
      sharesHeld: async sym => (this.broker.sharesHeld ? this.broker.sharesHeld(sym).catch(() => null) : null),
    };
  }

  status() {
    const et = this.clock.et();
    const open = this.positions.filter(p => p.status !== 'closed');
    return {
      version: VERSION,
      paper: true,
      broker: this.broker.name,
      fill_model: this.settings.value('fills.model'),
      mirror: this.broker.mirrorStatus ? this.broker.mirrorStatus() : null,
      market_data: this.market.name,
      kill_switch: { on: this.killOn(), forced_by_env: this.killEnv, ...(this.state.kill || {}) },
      clock: { now: this.nowIso(), et: `${et.date} ${et.hm}`, market_open: this.clock.isMarketHours(), simulated: this.clock.simulated },
      last_sync: this.status_.last_sync,
      last_sync_error: this.status_.last_sync_error,
      last_engine: this.status_.last_engine,
      last_engine_error: this.status_.last_engine_error,
      balance: this.status_.balance,
      counts: {
        pending_ideas: this.ideas.filter(i => i.status === 'pending').length,
        open_positions: open.length,
        working_orders: this.orders.filter(o => !ORDER_FINAL.has(o.status)).length,
      },
      open_risk: r2(open.filter(p => p.defined && p.max_loss != null).reduce((s, p) => s + p.max_loss, 0)),
      unrealized_pnl: r2(open.reduce((s, p) => s + (p.mark && !p.mark.stale ? p.mark.pnl : 0), 0)),
      realized_today: this.realizedToday(),
      trades_today: this.tradesToday(),
      orphans: this.status_.orphans,
      settings_version: this.settings.get().version,
    };
  }

  // Live price of a structure without creating anything (Muse and the website).
  async priceCheck(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.legs) || !body.symbol || !body.expiry) {
      throw new DeskError(400, 'bad_request', 'need symbol, expiry, legs and credit_or_debit');
    }
    const legs = normLegs(body);
    const symbol = String(body.symbol).toUpperCase().replace(/^\$/, '');
    const quotes = new Map();
    let underlying = null;
    try {
      for (const exp of [...new Set(legs.map(l => l.expiry))]) {
        const lo = Math.min(...legs.map(l => l.strike)), hi = Math.max(...legs.map(l => l.strike));
        const chain = await this.market.getChain(symbol, exp, { strikeRange: [lo, hi] });
        underlying = chain.underlying || underlying;
        for (const c of chain.contracts) quotes.set(`${exp}|${c.type}|${Number(c.strike)}`, c);
      }
    } catch (e) {
      throw new DeskError(503, 'market_data_unavailable', e.message);
    }
    const missing = legs.filter(l => !quotes.has(legKey(l)));
    if (missing.length) throw new DeskError(422, 'validation_failed', 'Some legs are not listed.', missing.map(l => ({ field: 'legs', issue: `${l.type} ${l.strike} not listed for ${l.expiry}` })));
    const cod = body.credit_or_debit === 'debit' ? 'debit' : 'credit';
    const live = openingPrice(legs, quotes, cod);
    const risk = body.structure ? riskProfile(body.structure, legs, live.mid) : null;
    return {
      symbol, underlying, credit_or_debit: cod, mid: live.mid, natural: live.natural, risk_at_mid: risk,
      legs: legs.map(l => { const q = quotes.get(legKey(l)); return { ...l, occ: q.occ, bid: q.bid, ask: q.ask, mid: q.mid, delta: q.delta, iv: q.iv }; }),
    };
  }

  // ── views ──
  _idea(id) {
    const i = this.ideas.find(x => x.id === id);
    if (!i) throw new DeskError(404, 'not_found', `No idea ${id}`);
    return i;
  }

  _setIdeaStatus(idea, status, by, note) {
    idea.status = status;
    idea.history.push({ at: this.nowIso(), status, by, ...(note ? { note } : {}) });
  }

  viewIdea(i) {
    if (!i) return null;
    const { request, ...rest } = i;
    return { ...rest, expired: i.status === 'pending' && this.clock.now() > Date.parse(i.expires_at) };
  }

  viewOrder(o) {
    if (!o) return null;
    const mirror = this.broker.mirrorInfo ? this.broker.mirrorInfo(o.external_id || (o.kind === 'entry' ? o.idea_id : o.id)) : null;
    return { ...o, mirror };
  }

  viewPosition(p) {
    if (!p) return null;
    const sys = p.system_signal || { action: 'HOLD', reason: '' };
    const muse = p.muse_signal;
    const museFirst = muse && (!sys.changed_at || muse.at >= sys.changed_at);
    const lastExpiry = p.legs.map(l => l.expiry).sort().slice(-1)[0];
    const openedDate = p.opened_at ? this.clock.et(Date.parse(p.opened_at)).date : null;
    const today = this.clock.today();
    const dte = lastExpiry ? Math.round((Date.parse(lastExpiry) - Date.parse(today)) / 86_400_000) : null;
    const { reconcile, ...rest } = p;
    return {
      ...rest,
      reconcile: reconcile ? { mismatch: true, legs: reconcile.legs, at: reconcile.at } : null,
      dte,
      earnings_warning: !!(p.earnings_date && openedDate && p.earnings_date >= openedDate && p.earnings_date <= lastExpiry),
      badge: museFirst
        ? { action: muse.action, reason: muse.reason, source: 'muse', at: muse.at }
        : { action: sys.action, reason: sys.reason, source: 'system', at: sys.changed_at || sys.at },
    };
  }
}

function numOrNull(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function sanitize(b) { return JSON.parse(JSON.stringify(b)); }

module.exports = { PaperDesk, DeskError, SIGNAL_ACTIONS };
