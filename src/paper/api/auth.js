// src/paper/api/auth.js — who is calling: Bikash (owner), an approved viewer,
// or Muse.
//
// Owner/viewer, AUTH_COOKIE_SECRET set (shared login hub, login.ishansahoo.com):
//   the signed ishn_sess cookie is checked first — role comes straight from it.
// Owner, legacy fallback (AUTH_COOKIE_SECRET unset, or no valid cookie):
//   PAPER_AUTH_MODE=local — HTTP Basic Auth checked by the app: PAPER_OWNER_USER / PAPER_OWNER_PASSWORD.
//   PAPER_AUTH_MODE=nginx — trusts X-Remote-User only on requests from 127.0.0.1 (nginx strips it on Muse's route).
// Muse: X-API-Key header equal to MUSE_PAPER_KEY.
//
// Owner write requests must also send "X-Requested-With: paper-desk" (unless
// they're logged in via the hub cookie, which browsers can't forge cross-site
// either — SameSite=Lax). Browsers can't add that header cross-site without
// CORS (which is off), so another website can't ride on the remembered login.

const crypto = require('crypto');
const { sessionFromRequest } = require('../../sessionAuth');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function makeAuth({ env, settings }) {
  const mode = (env.PAPER_AUTH_MODE || 'local').toLowerCase();
  const museKey = env.MUSE_PAPER_KEY || '';
  const ownerUser = env.PAPER_OWNER_USER || '';
  const ownerPass = env.PAPER_OWNER_PASSWORD || '';
  const cookieSecret = env.AUTH_COOKIE_SECRET || '';
  const hubUrl = (env.AUTH_HUB_URL || 'https://login.ishansahoo.com').replace(/\/$/, '');
  if (!['local', 'nginx'].includes(mode)) throw new Error('PAPER_AUTH_MODE must be local or nginx');
  // Legacy owner credentials are only required when the hub cookie isn't
  // configured — once AUTH_COOKIE_SECRET is set, PAPER_OWNER_USER/PASSWORD
  // just become a dormant fallback.
  if (!cookieSecret && mode === 'local' && (!ownerUser || !ownerPass)) throw new Error('Set PAPER_OWNER_USER and PAPER_OWNER_PASSWORD in .env (the website login)');
  if (mode === 'local' && ownerPass && ownerPass.length < 8) throw new Error('PAPER_OWNER_PASSWORD must be at least 8 characters');
  if (museKey && museKey.length < 24) throw new Error('MUSE_PAPER_KEY must be at least 24 characters (openssl rand -hex 32)');

  const buckets = new Map(); // "post"|"get" -> { windowStart, count }

  // Checked first: the signed cookie the shared login hub issues. Role comes
  // straight from the token — "owner" or "viewer" (anything else, including
  // a cookie that fails to verify, falls through to the legacy identify below).
  function identifyFromCookie(req) {
    if (!cookieSecret) return null;
    const payload = sessionFromRequest(req, cookieSecret);
    if (!payload || (payload.role !== 'owner' && payload.role !== 'viewer')) return null;
    return { role: payload.role, user: payload.username };
  }

  function identifyLegacy(req) {
    if (mode === 'nginx') {
      const u = req.headers['x-remote-user'];
      if (u && isLoopback(req)) return { role: 'owner', user: String(u) };
    } else if (ownerUser && ownerPass) {
      const h = req.headers.authorization || '';
      if (h.startsWith('Basic ')) {
        const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
        if (safeEqual(u, ownerUser) && safeEqual(p.join(':'), ownerPass)) return { role: 'owner', user: u };
      }
    }
    return null;
  }

  function identify(req) {
    const who = identifyFromCookie(req) || identifyLegacy(req);
    if (who) return who;
    const key = req.headers['x-api-key'];
    if (museKey && key && safeEqual(key, museKey)) return { role: 'muse', user: 'muse' };
    return null;
  }

  function deny(res, status, code, message, browser = false) {
    if (status === 401 && browser) {
      if (cookieSecret) {
        res.redirect(`${hubUrl}/login?return=${encodeURIComponent(`${res.req.protocol}://${res.req.get('host')}${res.req.originalUrl}`)}`);
        return;
      }
      if (mode === 'local') res.set('WWW-Authenticate', 'Basic realm="BoldTick Paper Desk", charset="UTF-8"');
    }
    res.status(status).json({ error: { code, message } });
  }

  // Any known caller; Muse calls are rate-limited.
  function anyCaller(req, res, next) {
    const who = identify(req);
    if (!who) return deny(res, 401, 'unauthorized', 'Missing or wrong credentials.', req.baseUrl.startsWith('/paper'));
    req.caller = who;
    if (who.role === 'muse') {
      const kind = req.method === 'GET' ? 'get' : 'post';
      const limit = settings.value(kind === 'get' ? 'muse.rate_get_per_min' : 'muse.rate_post_per_min');
      const now = Date.now();
      const b = buckets.get(kind) || { start: now, count: 0 };
      if (now - b.start >= 60_000) { b.start = now; b.count = 0; }
      b.count++;
      buckets.set(kind, b);
      if (b.count > limit) {
        res.set('Retry-After', String(Math.ceil((b.start + 60_000 - now) / 1000)));
        return deny(res, 429, 'rate_limited', `More than ${limit} ${kind === 'get' ? 'reads' : 'posts'} per minute.`);
      }
    }
    // A hub-cookie login is already same-site-only (SameSite=Lax) so it can't
    // be ridden cross-site the way a remembered Basic Auth prompt could —
    // only the legacy owner path needs the extra header.
    const viaCookie = !!identifyFromCookie(req);
    if ((who.role === 'owner' || who.role === 'viewer') && !viaCookie && req.method !== 'GET' && req.headers['x-requested-with'] !== 'paper-desk') {
      return deny(res, 403, 'csrf', 'Owner write requests need the header X-Requested-With: paper-desk.');
    }
    next();
  }

  function ownerOnly(req, res, next) {
    if (req.caller?.role === 'viewer') return deny(res, 403, 'owner_only', 'Viewer accounts are read-only — only Bikash can do this.');
    if (req.caller?.role !== 'owner') return deny(res, 403, 'owner_only', 'Only Bikash, logged in on the website, can do this.');
    next();
  }

  // Website pages: owner or viewer login (any non-muse identity).
  function ownerPage(req, res, next) {
    const who = identify(req);
    if (who?.role !== 'owner' && who?.role !== 'viewer') return deny(res, 401, 'unauthorized', 'Log in to Paper Desk.', true);
    req.caller = who;
    next();
  }

  return { identify, anyCaller, ownerOnly, ownerPage, mode };
}

module.exports = { makeAuth, safeEqual };
