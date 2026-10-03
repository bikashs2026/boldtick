// src/tastytrade/client.js — tastytrade REST client (market data only)
//
// Auth: OAuth2 personal grant. The refresh token never rotates and several
// processes (AWS + local) can each mint their own 15-minute access tokens from
// it at the same time without revoking each other — so, unlike Schwab, there
// is no authority/follower dance needed here. Each process just refreshes on
// its own.
//
// Credentials come only from the environment (.env), never from code:
//   TASTYTRADE_CLIENT_SECRET   (required)
//   TASTYTRADE_REFRESH_TOKEN   (required)
//   TASTYTRADE_CLIENT_ID       (optional — inferred from the refresh token)
//   TASTYTRADE_SCOPE           (optional — defaults to "read"; this module never
//                               needs "trade", so keep the grant read-only)
//   TASTYTRADE_API_URL         (optional — defaults to production)

const axios = require('axios');

const DEFAULT_BASE = 'https://api.tastyworks.com';
const USER_AGENT = 'tradeforge/1.0'; // tastytrade rejects requests without product/version UA
const CHAIN_CACHE_MS = 5 * 60 * 1000;  // nested chain structure changes rarely intraday

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TastyClient {
  // opts.useEnv === false → never fall back to the TASTYTRADE_* variables
  // (the paper broker uses this so production settings can't leak in).
  constructor(opts = {}) {
    const env = opts.useEnv === false ? {} : process.env;
    this.baseURL      = opts.baseURL      || env.TASTYTRADE_API_URL || DEFAULT_BASE;
    this.clientId     = opts.clientId     || env.TASTYTRADE_CLIENT_ID || undefined;
    this.clientSecret = opts.clientSecret || env.TASTYTRADE_CLIENT_SECRET;
    this.refreshToken = opts.refreshToken || env.TASTYTRADE_REFRESH_TOKEN;
    this.scope        = opts.scope        || env.TASTYTRADE_SCOPE || 'read';

    this._access = null;          // { token, expiresAt }
    this._pendingAccess = null;   // de-dupes concurrent refreshes
    this._quoteToken = null;      // { token, url, level, expiresAt }
    this._chainCache = new Map(); // symbol -> { at, dateKey, data }

    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      // tastytrade takes multi-symbol params as repeated keys: equity=SPY&equity=QQQ
      paramsSerializer: { serialize: serializeParams },
    });
  }

  get configured() {
    return Boolean(this.clientSecret && this.refreshToken);
  }

  // ── OAuth ────────────────────────────────────────────────────────────────
  async getAccessToken(force = false) {
    if (!this.configured) {
      throw new Error('tastytrade not configured — set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN in .env');
    }
    if (!force && this._access && this._access.expiresAt - Date.now() > 60_000) {
      return this._access.token;
    }
    if (this._pendingAccess) return this._pendingAccess;

    this._pendingAccess = (async () => {
      const body = {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_secret: this.clientSecret,
      };
      if (this.clientId) body.client_id = this.clientId;
      if (this.scope) body.scope = this.scope;
      const r = await this.http.post('/oauth/token', body, {
        headers: { 'Content-Type': 'application/json' },
      });
      const expiresIn = Number(r.data.expires_in) || 900;
      this._access = { token: r.data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return this._access.token;
    })();

    try { return await this._pendingAccess; }
    finally { this._pendingAccess = null; }
  }

  // Authenticated request with one forced re-auth on 401 and bounded
  // exponential backoff (+ jitter) on 429 / 5xx / network errors.
  async request(method, url, { params, data } = {}) {
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      try {
        const r = await this.http.request({
          method, url, params, data,
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.data;
      } catch (err) {
        const status = err.response?.status;
        if (status === 401 && !reauthed) {
          reauthed = true;
          await this.getAccessToken(true);
          continue;
        }
        const retryable = status === 429 || (status >= 500 && status < 600) || !status;
        if (retryable && attempt < 3) {
          await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250);
          continue;
        }
        const detail = err.response?.data?.error?.message || err.response?.data?.error || err.message;
        const e = new Error(`tastytrade ${method.toUpperCase()} ${url} failed${status ? ` (${status})` : ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        e.status = status;
        throw e;
      }
    }
  }

  // ── Instruments ─────────────────────────────────────────────────────────
  // Returns every root's expirations merged (SPX → SPX + SPXW, NDX → NDX + NDXP).
  // Shape: [{ root, date, dte, expirationType, settlementType,
  //           strikes: [{ strike, call, callStreamer, put, putStreamer }] }]
  async getNestedChain(symbol) {
    const sym = symbol.toUpperCase();
    const dateKey = todayET();
    const hit = this._chainCache.get(sym);
    if (hit && hit.dateKey === dateKey && Date.now() - hit.at < CHAIN_CACHE_MS) return hit.data;

    const raw = await this.request('get', `/option-chains/${encodeURIComponent(sym)}/nested`);
    const data = normalizeNestedChain(raw);
    this._chainCache.set(sym, { at: Date.now(), dateKey, data });
    return data;
  }

  // ── Market data (REST snapshot) ─────────────────────────────────────────
  // byType: { index: [...], equity: [...], future: [...], 'equity-option': [...] }
  // Max 100 symbols per request across all types.
  async getMarketData(byType) {
    const r = await this.request('get', '/market-data/by-type', { params: byType });
    return r?.data?.items || [];
  }

  // ── DXLink quote token (valid 24h) ──────────────────────────────────────
  async getQuoteToken(force = false) {
    const q = this._quoteToken;
    if (!force && q && q.expiresAt - Date.now() > 60 * 60 * 1000) return q;
    const r = await this.request('get', '/api-quote-tokens');
    const d = r?.data || {};
    this._quoteToken = {
      token: d.token,
      url: d['dxlink-url'] || d.dxlinkUrl || d['websocket-url'],
      level: d.level,
      expiresAt: d['expires-at'] ? Date.parse(d['expires-at']) : Date.now() + 23 * 3600 * 1000,
    };
    if (!this._quoteToken.token || !this._quoteToken.url) {
      throw new Error('tastytrade /api-quote-tokens returned no token/url');
    }
    return this._quoteToken;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
function serializeParams(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => usp.append(k, x));
    else usp.append(k, v);
  }
  return usp.toString();
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// The nested-chain payload has appeared in two layouts; handle both:
//   data.items[]            (each item = one root with expirations)
//   data[] -> items[]       (documented example)
// and per-strike either flat strings ("call", "call-streamer-symbol") or
// objects ({ call: { "call-streamer-symbol": ... } }).
function normalizeNestedChain(raw) {
  const d = raw?.data;
  let roots = [];
  if (Array.isArray(d?.items)) roots = d.items;
  else if (Array.isArray(d)) d.forEach(x => {
    if (Array.isArray(x.items)) x.items.forEach(i => roots.push({ 'root-symbol': x['root-symbol'], ...i }));
    else roots.push(x);
  });

  const out = [];
  for (const root of roots) {
    const rootSym = root['root-symbol'] || root['underlying-symbol'];
    for (const exp of root.expirations || []) {
      const strikes = (exp.strikes || []).map(s => {
        const callObj = typeof s.call === 'object' && s.call ? s.call : null;
        const putObj  = typeof s.put  === 'object' && s.put  ? s.put  : null;
        return {
          strike: Number(s['strike-price']),
          call: callObj ? (callObj.symbol || callObj.call || null) : (s.call || null),
          callStreamer: s['call-streamer-symbol'] || callObj?.['call-streamer-symbol'] || callObj?.['streamer-symbol'] || null,
          put: putObj ? (putObj.symbol || putObj.put || null) : (s.put || null),
          putStreamer: s['put-streamer-symbol'] || putObj?.['put-streamer-symbol'] || putObj?.['streamer-symbol'] || null,
        };
      }).filter(s => Number.isFinite(s.strike));
      out.push({
        root: rootSym,
        date: exp['expiration-date'],
        dte: Number(exp['days-to-expiration']),
        expirationType: exp['expiration-type'] || null,
        settlementType: exp['settlement-type'] || null,
        strikes,
      });
    }
  }
  return out;
}

module.exports = { TastyClient, normalizeNestedChain, todayET, USER_AGENT };
