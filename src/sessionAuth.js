// src/sessionAuth.js — shared signed-cookie session used by authhub, tradeforge,
// and boldtick. HMAC-SHA256 over a base64url JSON payload. No DB, no session
// store — the cookie itself is the session, verified independently by each
// app with the same AUTH_COOKIE_SECRET. Keep this file byte-identical across
// all three repos; if it drifts, nothing crashes, cookies just stop verifying.
'use strict';
const crypto = require('crypto');

const COOKIE_NAME = 'ishn_sess';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(unb64url(body).toString('utf8')); } catch { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionFromRequest(req, secret) {
  return verify(readCookie(req), secret);
}

function cookieHeader(token, { domain = '.ishansahoo.com', maxAgeSeconds = 7 * 24 * 3600, clear = false } = {}) {
  const parts = [`${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`];
  parts.push(`Path=/`);
  parts.push(`Domain=${domain}`);
  parts.push(`HttpOnly`);
  parts.push(`Secure`);
  parts.push(`SameSite=Lax`);
  parts.push(clear ? `Max-Age=0` : `Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

module.exports = { COOKIE_NAME, sign, verify, readCookie, sessionFromRequest, cookieHeader, b64url, unb64url };
