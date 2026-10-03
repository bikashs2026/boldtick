// src/tastytrade/dxlink.js — DXLink market-data WebSocket client
//
// Protocol (channel 0 = control, channel 1 = our FEED channel):
//   → SETUP                     ← AUTH_STATE UNAUTHORIZED
//   → AUTH {token}              ← AUTH_STATE AUTHORIZED
//   → CHANNEL_REQUEST FEED      ← CHANNEL_OPENED
//   → FEED_SETUP (COMPACT)      ← FEED_CONFIG (echoes the field order it will use)
//   → FEED_SUBSCRIPTION add/remove
//   ← FEED_DATA ["Greeks", [ "Greeks", ".SPXW…", v1, v2, …, "Greeks", ".SPXW…", … ]]
//   → KEEPALIVE every 30s (server drops us after 60s of silence)
//
// Emits:
//   'event'   ({ eventType, eventSymbol, ...fields })  — one per row
//   'state'   ('connecting' | 'ready' | 'closed')
//   'error'   (Error)                                  — only if someone listens
//
// Subscriptions are remembered and replayed after every reconnect, and a fresh
// quote token is fetched for each (re)connect so the 24h token expiry is a
// non-event.

const WebSocket = require('ws');
const EventEmitter = require('events');

const FEED_CHANNEL = 1;
const KEEPALIVE_MS = 30_000;
const SUB_BATCH = 500; // keep individual frames a sane size

// Field order we ask for. eventType + eventSymbol must stay first.
const EVENT_FIELDS = {
  Quote:   ['eventType', 'eventSymbol', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
  Trade:   ['eventType', 'eventSymbol', 'price', 'dayVolume', 'size', 'change'],
  Greeks:  ['eventType', 'eventSymbol', 'price', 'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega'],
  Summary: ['eventType', 'eventSymbol', 'openInterest', 'dayOpenPrice', 'dayHighPrice', 'dayLowPrice', 'prevDayClosePrice'],
};

class DXLinkClient extends EventEmitter {
  // getToken: async () => ({ token, url })  — called on every (re)connect
  constructor(getToken, opts = {}) {
    super();
    this.getToken = getToken;
    this.aggregationPeriod = opts.aggregationPeriod ?? 0.25; // seconds; plenty for a chain
    this.ws = null;
    this.state = 'closed';
    this.fields = { ...EVENT_FIELDS };
    this.subs = new Map(); // key "Type|symbol" -> { type, symbol }
    this._keepalive = null;
    this._reconnectTimer = null;
    this._attempts = 0;
    this._stopped = true;
    this._readyWaiters = [];
    this.stats = { connects: 0, events: 0, lastEventAt: null, lastError: null };
  }

  get ready() { return this.state === 'ready'; }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._teardown();
    this._setState('closed');
  }

  // Resolves once the feed channel is configured (or rejects after timeoutMs).
  whenReady(timeoutMs = 10_000) {
    if (this.ready) return Promise.resolve();
    this.start();
    return new Promise((resolve, reject) => {
      const waiter = {};
      const t = setTimeout(() => {
        this._readyWaiters = this._readyWaiters.filter(w => w !== waiter);
        reject(new Error(`DXLink not ready after ${timeoutMs}ms${this.stats.lastError ? ` (last error: ${this.stats.lastError})` : ''}`));
      }, timeoutMs);
      waiter.resolve = () => { clearTimeout(t); resolve(); };
      this._readyWaiters.push(waiter);
    });
  }

  subscribe(list) {
    const add = [];
    for (const { type, symbol } of list) {
      if (!symbol || !this.fields[type]) continue;
      const key = `${type}|${symbol}`;
      if (this.subs.has(key)) continue;
      this.subs.set(key, { type, symbol });
      add.push({ type, symbol });
    }
    if (add.length && this.ready) this._sendSubs({ add });
    return add.length;
  }

  unsubscribe(list) {
    const remove = [];
    for (const { type, symbol } of list) {
      const key = `${type}|${symbol}`;
      if (!this.subs.delete(key)) continue;
      remove.push({ type, symbol });
    }
    if (remove.length && this.ready) this._sendSubs({ remove });
    return remove.length;
  }

  // ── internals ───────────────────────────────────────────────────────────
  async _connect() {
    if (this._stopped) return;
    this._setState('connecting');
    let creds;
    try {
      creds = await this.getToken(this._attempts > 0); // force a fresh token after a failure
    } catch (e) {
      this._fail(e);
      return;
    }

    const ws = new WebSocket(creds.url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      this._send({ type: 'SETUP', channel: 0, version: '0.1-DXF-JS/0.3.0', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
      this._keepalive = setInterval(() => this._send({ type: 'KEEPALIVE', channel: 0 }), KEEPALIVE_MS);
    });

    ws.on('message', buf => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      this._onMessage(msg, creds.token);
    });

    ws.on('close', (code) => {
      this._teardown();
      if (this._stopped) return;
      this._setState('closed');
      this._scheduleReconnect(`closed (${code})`);
    });

    ws.on('error', err => this._fail(err));
  }

  _onMessage(msg, token) {
    switch (msg.type) {
      case 'SETUP':
        break;
      case 'AUTH_STATE':
        if (msg.state === 'UNAUTHORIZED') {
          this._send({ type: 'AUTH', channel: 0, token });
        } else if (msg.state === 'AUTHORIZED') {
          this._send({ type: 'CHANNEL_REQUEST', channel: FEED_CHANNEL, service: 'FEED', parameters: { contract: 'AUTO' } });
        }
        break;
      case 'CHANNEL_OPENED':
        if (msg.channel === FEED_CHANNEL) {
          this._send({
            type: 'FEED_SETUP', channel: FEED_CHANNEL,
            acceptAggregationPeriod: this.aggregationPeriod,
            acceptDataFormat: 'COMPACT',
            acceptEventFields: EVENT_FIELDS,
          });
        }
        break;
      case 'FEED_CONFIG':
        if (msg.channel === FEED_CHANNEL) {
          // The server tells us the exact field order it will send — trust it.
          if (msg.eventFields) this.fields = { ...this.fields, ...msg.eventFields };
          if (this.state !== 'ready') {
            this._attempts = 0;
            this.stats.connects++;
            this._setState('ready');
            if (this.subs.size) this._sendSubs({ add: [...this.subs.values()], reset: true });
            this._readyWaiters.splice(0).forEach(w => w.resolve());
          }
        }
        break;
      case 'FEED_DATA':
        if (msg.channel === FEED_CHANNEL) this._onFeedData(msg.data);
        break;
      case 'ERROR':
        this.stats.lastError = `${msg.error || 'ERROR'}: ${msg.message || ''}`.trim();
        if (this.listenerCount('error')) this.emit('error', new Error(`DXLink ${this.stats.lastError}`));
        break;
      default:
        break; // KEEPALIVE, CHANNEL_CLOSED, etc.
    }
  }

  // COMPACT: data = [type, flat] or [type, flat, type, flat, …]
  _onFeedData(data) {
    if (!Array.isArray(data)) return;
    for (let i = 0; i + 1 < data.length; i += 2) {
      const type = data[i];
      const flat = data[i + 1];
      const fields = this.fields[type];
      if (!fields || !Array.isArray(flat)) continue;
      const n = fields.length;
      for (let j = 0; j + n <= flat.length; j += n) {
        const ev = {};
        for (let f = 0; f < n; f++) ev[fields[f]] = cleanValue(flat[j + f]);
        ev.eventType = ev.eventType || type;
        this.stats.events++;
        this.stats.lastEventAt = Date.now();
        this.emit('event', ev);
      }
    }
  }

  _sendSubs({ add, remove, reset }) {
    if (reset) {
      const first = (add || []).slice(0, SUB_BATCH);
      this._send({ type: 'FEED_SUBSCRIPTION', channel: FEED_CHANNEL, reset: true, add: first });
      add = (add || []).slice(SUB_BATCH);
    }
    for (let i = 0; add && i < add.length; i += SUB_BATCH) {
      this._send({ type: 'FEED_SUBSCRIPTION', channel: FEED_CHANNEL, add: add.slice(i, i + SUB_BATCH) });
    }
    for (let i = 0; remove && i < remove.length; i += SUB_BATCH) {
      this._send({ type: 'FEED_SUBSCRIPTION', channel: FEED_CHANNEL, remove: remove.slice(i, i + SUB_BATCH) });
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _fail(err) {
    this.stats.lastError = err?.message || String(err);
    if (this.listenerCount('error')) this.emit('error', err instanceof Error ? err : new Error(String(err)));
    if (this.ws) { try { this.ws.terminate(); } catch {} } // 'close' handler schedules the reconnect
    else this._scheduleReconnect(this.stats.lastError);
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this._attempts) + Math.random() * 500;
    this._attempts++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _teardown() {
    clearInterval(this._keepalive);
    this._keepalive = null;
    if (this.ws) {
      this.ws.removeAllListeners('message');
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
    if (this.state === 'ready') this.state = 'closed';
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }
}

// DXLink sends "NaN" / "Infinity" as strings in COMPACT mode.
function cleanValue(v) {
  if (v === 'NaN' || v === 'Infinity' || v === '-Infinity') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

module.exports = { DXLinkClient, EVENT_FIELDS };
