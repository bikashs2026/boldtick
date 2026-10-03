// src/paper/api/routes.js — the Paper Desk REST API
//
// Mounted twice: /api/paper (Muse's way in) and /paper/api (the website).
// Same handlers; who may call what is decided by auth, not by the path.

const express = require('express');
const { DeskError } = require('../desk');
const { SettingsError } = require('../settings');

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
