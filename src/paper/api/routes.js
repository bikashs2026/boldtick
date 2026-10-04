// src/paper/api/routes.js — the Paper Desk REST API
//
// Mounted twice: /api/paper (Muse's way in) and /paper/api (the website).
// Same handlers; who may call what is decided by auth, not by the path.

const express = require('express');
const { DeskError } = require('../desk');
const { SettingsError } = require('../settings');
const { riskProfile, openingPrice, normLegs, legKey } = require('../pricing');

function makeRouter({ desk, settings, events, store, auth, market, clock }) {
  const r = express.Router();
  const { anyCaller, ownerOnly } = auth;

  // Audit every call (no headers, no bodies of settings logins — just who did what)
  r.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      try {
        store.append('audit.jsonl', {
          at: clock.iso(), caller: req.caller?.role || 'anonymous', method: req.method,
          path: req.baseUrl + req.path, status: res.statusCode, ms: Date.now() - started,
          body: req.method === 'GET' ? undefined : redact(req.body),
        });
      } catch { /* never fail a request over logging */ }
    });
    next();
  });

  r.use(anyCaller);

  const h = fn => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out && out.__status) return res.status(out.__status).json(out.body);
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  };

  // ── Status & settings ──
  r.get('/status', h(() => desk.status()));

  r.get('/settings', h(req => ({ ...settings.get(), ...(req.query.meta ? { meta: settings.meta() } : {}) })));
  r.put('/settings', ownerOnly, h(req => {
    const { settings: s, changes } = settings.update(req.body, req.caller.user);
    if (changes.length) events.emit('settings.changed', { data: { version: s.version, changes } });
    return { ...s, changes };
  }));
  r.get('/settings/history', ownerOnly, h(() => settings.history()));
  r.post('/settings/reset', ownerOnly, h(req => {
    const s = settings.reset(req.caller.user);
    events.emit('settings.changed', { data: { version: s.version, reset: true } });
    return s;
  }));
  r.post('/positions/apply-settings', ownerOnly, h(req => desk.applySettingsToOpen(req.caller.user)));

  // ── Ideas ──
  r.post('/trade-ideas', h(async req => {
    const { status, idea } = await desk.createIdea(req.body, req.caller.role);
    if (status === 422) return { __status: 422, body: { error: { code: 'validation_failed', message: 'Idea failed validation; stored as invalid.', details: idea.validation.errors }, idea } };
    return { __status: status, body: idea };
  }));
  r.get('/trade-ideas', h(req => desk.listIdeas({ status: req.query.status })));
  r.get('/trade-ideas/:id', h(req => desk.getIdea(req.params.id)));
  r.post('/trade-ideas/:id/approve', ownerOnly, h(async req => {
    const out = await desk.approve(req.params.id, req.body || {}, req.caller.user);
    return { __status: 202, body: { idea_id: out.idea.id, order_id: out.order.id, status: out.order.status, idea: out.idea, order: out.order } };
  }));
  r.post('/trade-ideas/:id/reject', ownerOnly, h(req => desk.reject(req.params.id, req.body || {}, req.caller.user)));

  // ── Orders ──
  r.get('/orders', h(req => desk.listOrders({ status: req.query.status })));
  r.post('/orders/:id/cancel', ownerOnly, h(req => desk.cancelOrder(req.params.id, req.caller.user)));

  // ── Positions ──
  r.get('/positions', h(req => desk.listPositions({ status: req.query.status === 'closed' ? 'closed' : 'open' })));
  r.get('/positions/:id', h(req => {
    const p = desk.positions.find(x => x.id === req.params.id);
    if (!p) throw new DeskError(404, 'not_found', `No position ${req.params.id}`);
    return desk.viewPosition(p);
  }));
  r.post('/positions/:id/action', h(async req => {
    const { status, signal } = await desk.pushSignal(req.params.id, req.body, req.caller.role);
    return { __status: status, body: signal };
  }));
  r.post('/positions/:id/close-request', ownerOnly, h(async req => {
    const out = await desk.closeRequest(req.params.id, req.body || {}, req.caller.user);
    return { __status: 202, body: out };
  }));

  // ── Feeds ──
  r.get('/signals', h(req => desk.listSignals({ after: req.query.after, limit: req.query.limit })));
  r.get('/events', h(req => events.list({ after: req.query.after, limit: req.query.limit, types: req.query.types ? String(req.query.types).split(',') : null })));

  // ── Actions ──
  r.post('/sync', ownerOnly, h(() => desk.sync()));
  r.post('/engine/run', ownerOnly, h(async () => { await desk.engineTick(); return desk.status(); }));
  r.post('/kill-switch', ownerOnly, h(req => {
    if (typeof req.body?.on !== 'boolean') throw new DeskError(400, 'bad_request', 'body must be { "on": true | false, "reason"?: "..." }');
    return desk.setKill(req.body.on, typeof req.body.reason === 'string' ? req.body.reason.slice(0, 200) : null, req.caller.user);
  }));

  // ── Market helpers ──
  r.post('/price-check', h(req => desk.priceCheck(req.body)));
  r.get('/quote/:symbol', h(async req => ({ symbol: req.params.symbol.toUpperCase(), price: await market.getUnderlying(req.params.symbol), source: market.name, at: clock.iso() })));

  r.get('/expirations/:symbol', h(async req => ({ symbol: req.params.symbol.toUpperCase(), expirations: await market.getExpirations(req.params.symbol), source: market.name })));

  // Full option chain for one expiry — same shape every market source already
  // returns internally for price-check and validation: { symbol, expiry,
  // underlying, at, source, contracts: [{ type, strike, occ, bid, ask, mid, delta, iv }] }.
  // ?expiry=YYYY-MM-DD; defaults to the nearest listed expiration if omitted.
  // ?strikeLow= & ?strikeHigh= narrow the strike range; omit both for the full chain.
  r.get('/chain/:symbol', h(async req => {
    const symbol = req.params.symbol.toUpperCase();
    let expiry = req.query.expiry;
    if (!expiry) {
      const exps = await market.getExpirations(symbol);
      expiry = exps[0];
      if (!expiry) throw new DeskError(404, 'not_found', `no expirations listed for ${symbol}`);
    }
    const lo = req.query.strikeLow !== undefined ? Number(req.query.strikeLow) : undefined;
    const hi = req.query.strikeHigh !== undefined ? Number(req.query.strikeHigh) : undefined;
    return await market.getChain(symbol, expiry, lo != null && hi != null ? { strikeRange: [lo, hi] } : {});
  }));

  // ── Build tab ──
  // Live pricing for a structure the owner is constructing — reuses the same
  // openingPrice/riskProfile math as validateIdea/approve so the numbers
  // shown here never disagree with what Submit will actually enforce. Pure
  // preview: nothing here is persisted.
  r.post('/build/price', ownerOnly, h(async req => {
    const b = req.body || {};
    const symbol = String(b.symbol || '').toUpperCase().replace(/^\$/, '');
    if (!symbol) throw new DeskError(400, 'bad_request', 'symbol is required');
    if (!Array.isArray(b.legs) || !b.legs.length || b.legs.length > 4) throw new DeskError(400, 'bad_request', '1–4 legs required');
    // Each leg carries its own qty now (the Legs section, not one global
    // "Contracts" field) — most structures keep every leg equal, but a
    // butterfly's body is legitimately double a wing's. A leg missing its
    // own qty falls back to the top-level "quantity" convenience field, then 1.
    const fallbackQty = Number.isInteger(Number(b.quantity)) && Number(b.quantity) >= 1 ? Number(b.quantity) : 1;
    const legQty = l => Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 ? Number(l.qty) : fallbackQty;
    const legs = normLegs({ legs: b.legs.map(l => ({ ...l, qty: legQty(l) })), expiry: b.expiry });
    const expiries = [...new Set(legs.map(l => l.expiry))].sort();
    const lo = Math.min(...legs.map(l => l.strike)), hi = Math.max(...legs.map(l => l.strike));
    const quotes = new Map();
    let underlying = null;
    for (const exp of expiries) {
      const chain = await market.getChain(symbol, exp, { strikeRange: [lo, hi] });
      underlying = chain.underlying ?? underlying;
      for (const c of chain.contracts) quotes.set(`${exp}|${c.type}|${Number(c.strike)}`, c);
    }
    const missing = legs.filter(l => !quotes.has(legKey(l)));
    if (missing.length) throw new DeskError(422, 'validation_failed', 'Some legs are not listed.', missing.map(l => ({ field: 'legs', issue: `${l.type} ${l.strike} is not listed for ${l.expiry}` })));
    const creditOrDebit = b.credit_or_debit === 'debit' ? 'debit' : 'credit';
    const entry = openingPrice(legs, quotes, creditOrDebit, b.structure);
    const risk = b.structure ? riskProfile(b.structure, legs, entry ? entry.mid : 0, creditOrDebit) : null;
    const lastExpiry = expiries[expiries.length - 1];
    const dte = Math.round((Date.parse(lastExpiry) - Date.parse(clock.today())) / 86_400_000);
    return {
      symbol, underlying, dte,
      legs: legs.map(l => {
        const q = quotes.get(legKey(l));
        return { ...l, occ: q.occ, bid: q.bid, ask: q.ask, mid: q.mid, delta: q.delta, iv: q.iv, gamma: q.gamma, theta: q.theta, vega: q.vega };
      }),
      entry, risk,
    };
  }));

  // Submits a manually built structure either as a pending trade idea (same
  // queue Muse's ideas land in) or straight to the broker (creates the idea,
  // then immediately runs the same desk.approve() path the Execute tab's own
  // Approve button uses — portfolio limits, margin dry-run, broker submit,
  // reprice-required on a stale price, all reused rather than duplicated).
  r.post('/build/submit', ownerOnly, h(async req => {
    const b = req.body || {};
    const destination = b.destination === 'broker' ? 'broker' : 'ideas';
    if (!Array.isArray(b.legs) || !b.legs.length || b.legs.length > 4) throw new DeskError(400, 'bad_request', '1–4 legs required');
    // Each leg carries its own qty (see /build/price's comment) — a leg
    // missing it falls back to the top-level "quantity" field, then 1.
    const fallbackQty = Number.isInteger(Number(b.quantity)) && Number(b.quantity) >= 1 ? Number(b.quantity) : null;
    if (!b.legs.every(l => Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1) && !fallbackQty) {
      throw new DeskError(400, 'bad_request', 'quantity must be a whole number ≥ 1');
    }
    const legQty = l => (Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 ? Number(l.qty) : fallbackQty);
    const ideaBody = {
      client_idea_id: `build-${clock.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: b.symbol, structure: b.structure, expiry: b.expiry,
      legs: b.legs.map(l => ({ action: l.action, type: l.type, strike: Number(l.strike), qty: legQty(l), expiry: l.expiry || b.expiry })),
      limit_price: Number(b.limit_price),
      credit_or_debit: b.credit_or_debit === 'debit' ? 'debit' : 'credit',
      thesis: (typeof b.thesis === 'string' && b.thesis.trim()) ? b.thesis.trim() : 'Built manually on the Build tab.',
    };
    const { status, idea } = await desk.createIdea(ideaBody, req.caller.role);
    if (status === 422) return { __status: 422, body: { error: { code: 'validation_failed', message: 'Order failed validation.', details: idea.validation.errors }, idea } };
    if (destination === 'ideas') return { __status: 201, body: { idea } };
    const out = await desk.approve(idea.id, { confirm: !!b.confirm }, req.caller.user);
    return { __status: 202, body: { idea: out.idea, order: out.order } };
  }));

  // Templates: a reusable shape (structure + each leg's strike offset from
  // spot), re-priced fresh every time it's loaded. Drafts: one specific
  // built order (concrete strikes/price/qty) saved to revisit later.
  r.get('/build/templates', ownerOnly, h(() => desk.listTemplates()));
  r.post('/build/templates', ownerOnly, h(req => ({ __status: 201, body: desk.saveTemplate(req.body || {}) })));
  r.delete('/build/templates/:id', ownerOnly, h(req => desk.deleteTemplate(req.params.id)));

  r.get('/build/drafts', ownerOnly, h(() => desk.listDrafts()));
  r.post('/build/drafts', ownerOnly, h(req => ({ __status: 201, body: desk.saveDraft(req.body || {}) })));
  r.delete('/build/drafts/:id', ownerOnly, h(req => desk.deleteDraft(req.params.id)));

  r.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route ${req.method} ${req.baseUrl}${req.path}` } }));
  return r;
}

function sendError(res, e) {
  if (e instanceof DeskError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, ...(e.extra || {}) });
  }
  if (e instanceof SettingsError) {
    return res.status(422).json({ error: { code: 'validation_failed', message: 'Some settings are invalid.', details: e.details } });
  }
  if (e.code === 'version_conflict') {
    return res.status(409).json({ error: { code: 'version_conflict', message: e.message }, current_version: e.current });
  }
  console.error('Paper Desk error:', e);
  return res.status(500).json({ error: { code: 'internal', message: e.message } });
}

function redact(body) {
  if (!body || typeof body !== 'object') return body;
  const out = JSON.parse(JSON.stringify(body));
  for (const k of Object.keys(out)) if (/key|secret|token|password/i.test(k)) out[k] = '***';
  return out;
}

module.exports = { makeRouter, sendError };
