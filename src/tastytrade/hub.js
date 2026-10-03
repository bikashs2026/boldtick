// src/tastytrade/hub.js — tastytrade market-data hub
//
// One long-lived DXLink connection per server process, plus a live in-memory
// store of the latest Quote / Trade / Greeks / Summary for every subscribed
// symbol. Public methods return responses in **Schwab's JSON shape** so the
// rest of TradeForge (index.html, src/gex.js, the Muse endpoints) works
// unchanged regardless of which provider is active:
//
//   getQuotes(symbols)        → like Schwab GET /marketdata/v1/quotes
//   getExpirationChain(sym)   → like Schwab GET /marketdata/v1/expirationchain
//   getOptionsChain(sym, opt) → like Schwab GET /marketdata/v1/chains
//
// Why a live store instead of REST polling: tastytrade's chain endpoint only
// returns contract symbols. Greeks and open interest arrive over DXLink
// (Greeks + Summary events). The first request for an expiry subscribes its
// strikes and waits briefly for them to fill; every request after that is
// served instantly from memory with values that are at most ~0.25s old.
// Contracts nobody has asked for in TT_SUB_IDLE_MIN minutes are unsubscribed.

const EventEmitter = require('events');
const { TastyClient, todayET } = require('./client');
const { DXLinkClient } = require('./dxlink');

const INDEXES = new Set(['SPX', 'XSP', 'VIX', 'NDX', 'RUT', 'DJX', 'OEX']);
const OPTION_EVENTS = ['Quote', 'Greeks', 'Summary', 'Trade'];
const UNDERLYING_EVENTS = ['Quote', 'Trade', 'Summary'];

const num = (v, d = 0) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

class TastyMarketData extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.client = opts.client || new TastyClient();
    this.dx = opts.dxlink || new DXLinkClient(async (force) => {
      const q = await this.client.getQuoteToken(force);
      return { token: q.token, url: q.url };
    });

    this.defaultExpirations = intEnv('TT_DEFAULT_EXPIRATIONS', 1);     // when caller gives no dates
    this.maxExpirations     = intEnv('TT_MAX_CHAIN_EXPIRATIONS', 8);   // hard cap per request
    this.maxContracts       = intEnv('TT_MAX_OPTION_CONTRACTS', 4000); // LRU cap on live option subs
    this.idleMs             = intEnv('TT_SUB_IDLE_MIN', 10) * 60_000;
    this.fillTimeoutMs      = intEnv('TT_FILL_TIMEOUT_MS', 3000);

    this.live = new Map();        // streamer symbol -> { quote, trade, greeks, summary, at }
    this.optionUsed = new Map();  // option streamer symbol -> last requested (ms)
    this.underlyings = new Set(); // DXLink symbols we keep subscribed for good

    this.dx.on('event', ev => this._ingest(ev));
    this.dx.on('state', s => this.emit('state', s));
    this.dx.on('error', err => this.emit('streamError', err));

    this._gc = setInterval(() => this._collectIdle(), 60_000);
    if (this._gc.unref) this._gc.unref();
  }

  get configured() { return this.client.configured; }

  status() {
    return {
      provider: 'tastytrade',
      configured: this.configured,
      stream: this.dx.state,
      liveSymbols: this.live.size,
      optionContracts: this.optionUsed.size,
      underlyings: [...this.underlyings],
      events: this.dx.stats.events,
      lastEventAt: this.dx.stats.lastEventAt ? new Date(this.dx.stats.lastEventAt).toISOString() : null,
      lastError: this.dx.stats.lastError,
      reconnects: Math.max(0, this.dx.stats.connects - 1),
    };
  }

  stop() { clearInterval(this._gc); this.dx.stop(); }

  // ── Quotes ──────────────────────────────────────────────────────────────
  async getQuotes(symbols) {
    const list = (Array.isArray(symbols) ? symbols : String(symbols).split(','))
      .map(s => s.trim()).filter(Boolean);
    const parsed = list.map(parseSymbol);

    // Keep equities/indexes streaming so the next request is served from memory.
    this._ensureUnderlyings(parsed.filter(p => p.kind === 'index' || p.kind === 'equity').map(p => p.dx));

    const out = {};
    const needRest = [];
    for (const p of parsed) {
      const fromLive = this._quoteFromLive(p);
      if (fromLive) out[p.input] = fromLive;
      else needRest.push(p);
    }

    for (let i = 0; i < needRest.length; i += 100) {
      const batch = needRest.slice(i, i + 100);
      const byType = {};
      batch.forEach(p => { (byType[p.restType] = byType[p.restType] || []).push(p.rest); });
      const items = await this.client.getMarketData(byType);
      const bySym = new Map(items.map(it => [String(it.symbol).toUpperCase(), it]));
      for (const p of batch) {
        const it = bySym.get(p.rest.toUpperCase());
        if (it) out[p.input] = schwabQuoteFromRest(p, it);
      }
    }
    return out;
  }

  // ── Expirations ─────────────────────────────────────────────────────────
  async getExpirationChain(symbol) {
    const p = parseSymbol(symbol);
    const chain = await this.client.getNestedChain(p.root);
    const today = todayET();
    const byDate = new Map();
    for (const e of chain) {
      if (!e.date || e.date < today) continue;
      const cur = byDate.get(e.date) || { roots: new Set(), types: new Set(), settle: new Set() };
      cur.roots.add(e.root); if (e.expirationType) cur.types.add(e.expirationType); if (e.settlementType) cur.settle.add(e.settlementType);
      byDate.set(e.date, cur);
    }
    const expirationList = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({
      expirationDate: date,
      daysToExpiration: daysBetween(today, date),
      expirationType: [...v.types].join(',') || null,
      settlementType: v.settle.has('PM') ? 'P' : (v.settle.has('AM') ? 'A' : null),
      optionRoots: [...v.roots].join(','),
      standard: true,
    }));
    return { status: 'SUCCESS', expirationList, source: 'tastytrade' };
  }

  // ── Option chain ────────────────────────────────────────────────────────
  // opts (Schwab names): strikeCount, contractType (ALL|CALL|PUT), fromDate,
  // toDate, fromStrike, toStrike. Dates are YYYY-MM-DD.
  async getOptionsChain(symbol, opts = {}) {
    const p = parseSymbol(symbol);
    const t0 = Date.now();
    const today = todayET();
    const chain = await this.client.getNestedChain(p.root);

    let dates = [...new Set(chain.map(e => e.date))].filter(d => d && d >= today).sort();
    const from = opts.fromDate ? String(opts.fromDate).slice(0, 10) : null;
    const to   = opts.toDate   ? String(opts.toDate).slice(0, 10)   : null;
    if (from || to) dates = dates.filter(d => (!from || d >= from) && (!to || d <= to));
    else dates = dates.slice(0, this.defaultExpirations);
    dates = dates.slice(0, this.maxExpirations);

    const underlying = await this._underlyingSnapshot(p);
    const price = underlying.last;

    const contractType = String(opts.contractType || 'ALL').toUpperCase();
    const wantCalls = contractType !== 'PUT';
    const wantPuts  = contractType !== 'CALL';
    const strikeCount = Math.max(1, parseInt(opts.strikeCount, 10) || 30);
    const fromStrike = opts.fromStrike != null && opts.fromStrike !== '' ? Number(opts.fromStrike) : null;
    const toStrike   = opts.toStrike   != null && opts.toStrike   !== '' ? Number(opts.toStrike)   : null;

    // Pick contracts per expiry. When SPX and SPXW share a date (monthly
    // expiration), PM-settled SPXW goes first in each strike's array because
    // the frontend reads arr[0] and the AM contract is already settled.
    const plan = []; // { date, strike, side, occ, streamer, root, settle }
    for (const date of dates) {
      const rows = chain.filter(e => e.date === date)
        .sort((a, b) => settleRank(a.settlementType) - settleRank(b.settlementType));
      let strikes = [...new Set(rows.flatMap(r => r.strikes.map(s => s.strike)))].sort((a, b) => a - b);
      if (fromStrike != null || toStrike != null) {
        strikes = strikes.filter(s => (fromStrike == null || s >= fromStrike) && (toStrike == null || s <= toStrike));
      } else if (price > 0) {
        strikes = strikes.slice().sort((a, b) => Math.abs(a - price) - Math.abs(b - price)).slice(0, strikeCount).sort((a, b) => a - b);
      } else {
        strikes = strikes.slice(Math.max(0, Math.floor(strikes.length / 2 - strikeCount / 2)), Math.floor(strikes.length / 2 + strikeCount / 2));
      }
      const keep = new Set(strikes);
      for (const r of rows) {
        for (const s of r.strikes) {
          if (!keep.has(s.strike)) continue;
          if (wantCalls && s.callStreamer) plan.push({ date, strike: s.strike, side: 'CALL', occ: s.call, streamer: s.callStreamer, root: r.root, settle: r.settlementType, expType: r.expirationType });
          if (wantPuts  && s.putStreamer)  plan.push({ date, strike: s.strike, side: 'PUT',  occ: s.put,  streamer: s.putStreamer,  root: r.root, settle: r.settlementType, expType: r.expirationType });
        }
      }
    }

    // Subscribe + wait for first fill of anything new.
    const now = Date.now();
    const streamers = plan.map(c => c.streamer);
    streamers.forEach(s => this.optionUsed.set(s, now));
    await this.dx.whenReady().catch(() => {}); // still return a structured chain if the stream is down
    this.dx.subscribe(streamers.flatMap(symbol => OPTION_EVENTS.map(type => ({ type, symbol }))));
    this._enforceCap();
    const filled = await this._waitForFill(streamers, this.fillTimeoutMs);

    // Assemble Schwab-shaped maps.
    const callExpDateMap = {}, putExpDateMap = {};
    const quality = { contracts: plan.length, withQuote: 0, withGreeks: 0, withOI: 0 };
    for (const c of plan) {
      const L = this.live.get(c.streamer) || {};
      if (L.quote) quality.withQuote++;
      if (L.greeks && L.greeks.gamma != null) quality.withGreeks++;
      if (L.summary && L.summary.openInterest != null) quality.withOI++;
      const dte = daysBetween(today, c.date);
      const expKey = `${c.date}:${dte}`;
      const strikeKey = c.strike.toFixed(1);
      const map = c.side === 'CALL' ? callExpDateMap : putExpDateMap;
      map[expKey] = map[expKey] || {};
      (map[expKey][strikeKey] = map[expKey][strikeKey] || []).push(schwabOption(c, L, price, dte));
    }

    // Sort strike keys numerically within each expiry (Schwab returns them ordered).
    for (const m of [callExpDateMap, putExpDateMap]) {
      for (const k of Object.keys(m)) {
        m[k] = Object.fromEntries(Object.entries(m[k]).sort((a, b) => Number(a[0]) - Number(b[0])));
      }
    }

    return {
      symbol: p.input,
      status: 'SUCCESS',
      underlying: underlying.schwab,
      strategy: 'SINGLE',
      interval: 0,
      isDelayed: false,
      isIndex: p.kind === 'index',
      interestRate: 0,
      underlyingPrice: price,
      volatility: atmIv(callExpDateMap, price),
      daysToExpiration: dates.length ? daysBetween(today, dates[0]) : 0,
      numberOfContracts: plan.length,
      callExpDateMap,
      putExpDateMap,
      source: 'tastytrade',
      dataQuality: { ...quality, filled, waitedMs: Date.now() - t0, stream: this.dx.state },
    };
  }

  // ── internals ───────────────────────────────────────────────────────────
  _ingest(ev) {
    const sym = ev.eventSymbol;
    if (!sym) return;
    const rec = this.live.get(sym) || {};
    const t = ev.eventType;
    if (t === 'Quote') rec.quote = { bidPrice: ev.bidPrice, askPrice: ev.askPrice, bidSize: ev.bidSize, askSize: ev.askSize };
    else if (t === 'Trade') rec.trade = { price: ev.price, dayVolume: ev.dayVolume, size: ev.size, change: ev.change };
    else if (t === 'Greeks') rec.greeks = { price: ev.price, volatility: ev.volatility, delta: ev.delta, gamma: ev.gamma, theta: ev.theta, rho: ev.rho, vega: ev.vega };
    else if (t === 'Summary') rec.summary = { openInterest: ev.openInterest, dayOpenPrice: ev.dayOpenPrice, dayHighPrice: ev.dayHighPrice, dayLowPrice: ev.dayLowPrice, prevDayClosePrice: ev.prevDayClosePrice };
    else return;
    rec.at = Date.now();
    this.live.set(sym, rec);
    if (this.underlyings.has(sym)) this.emit('quote', sym, rec);
  }

  _ensureUnderlyings(dxSymbols) {
    const fresh = dxSymbols.filter(s => s && !this.underlyings.has(s));
    if (!fresh.length) return;
    fresh.forEach(s => this.underlyings.add(s));
    this.dx.start();
    this.dx.subscribe(fresh.flatMap(symbol => UNDERLYING_EVENTS.map(type => ({ type, symbol }))));
  }

  _quoteFromLive(p) {
    if (p.kind !== 'index' && p.kind !== 'equity') return null;
    const L = this.live.get(p.dx);
    if (!L || !this.dx.ready || Date.now() - (L.at || 0) > 15_000) return null;
    const last = num(L.trade?.price, null) ?? mid(L.quote);
    if (!last || !L.summary) return null; // need prev close for netChange
    return schwabQuote(p, {
      last,
      bid: num(L.quote?.bidPrice), ask: num(L.quote?.askPrice),
      prevClose: num(L.summary.prevDayClosePrice, null),
      open: num(L.summary.dayOpenPrice), high: num(L.summary.dayHighPrice), low: num(L.summary.dayLowPrice),
      volume: num(L.trade?.dayVolume), source: 'tastytrade-stream',
    });
  }

  async _underlyingSnapshot(p) {
    this._ensureUnderlyings([p.dx]);
    let q = this._quoteFromLive(p);
    if (!q) {
      try { q = (await this.getQuotes([p.input]))[p.input]; } catch { q = null; }
    }
    const last = num(q?.quote?.lastPrice) || num(q?.quote?.mark);
    return {
      last,
      schwab: q ? {
        symbol: p.input,
        description: q.reference?.description || p.root,
        last, mark: num(q.quote.mark), bid: num(q.quote.bidPrice), ask: num(q.quote.askPrice),
        close: num(q.quote.closePrice), change: num(q.quote.netChange), percentChange: num(q.quote.netPercentChange),
        openPrice: num(q.quote.openPrice), highPrice: num(q.quote.highPrice), lowPrice: num(q.quote.lowPrice),
        totalVolume: num(q.quote.totalVolume), quoteTime: Date.now(), tradeTime: Date.now(), delayed: false,
      } : null,
    };
  }

  async _waitForFill(streamers, timeoutMs) {
    const ready = s => { const L = this.live.get(s); return L && L.greeks && L.summary; };
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.dx.ready) return false;
      const done = streamers.filter(ready).length;
      if (done >= streamers.length * 0.97) return true; // a few illiquid wings may never tick
      await sleep(100);
    }
    return false;
  }

  _enforceCap() {
    if (this.optionUsed.size <= this.maxContracts) return;
    const victims = [...this.optionUsed.entries()].sort((a, b) => a[1] - b[1])
      .slice(0, this.optionUsed.size - this.maxContracts).map(([s]) => s);
    this._dropOptions(victims);
  }

  _collectIdle() {
    const cutoff = Date.now() - this.idleMs;
    const victims = [...this.optionUsed.entries()].filter(([, t]) => t < cutoff).map(([s]) => s);
    if (victims.length) this._dropOptions(victims);
  }

  _dropOptions(syms) {
    syms.forEach(s => { this.optionUsed.delete(s); this.live.delete(s); });
    this.dx.unsubscribe(syms.flatMap(symbol => OPTION_EVENTS.map(type => ({ type, symbol }))));
  }
}

// ── symbol handling ─────────────────────────────────────────────────────────
// Accepts Schwab-style input ("$SPX", "SPX", "SPY", "/ESZ26") and returns how
// to ask tastytrade for it.
function parseSymbol(input) {
  const raw = String(input).trim();
  const up = raw.toUpperCase();
  if (up.startsWith('/')) {
    // Futures: tastytrade REST takes "/ESZ6"-style symbols; Schwab uses "/ESZ26".
    const m = up.match(/^\/([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{2})$/);
    const rest = m ? `/${m[1]}${m[2]}${m[3].slice(-1)}` : up;
    return { input: raw, root: up, kind: 'future', rest, restType: 'future', dx: null };
  }
  if (/\s\d{6}[CP]\d{8}$/.test(up)) {
    return { input: raw, root: up.split(/\s+/)[0], kind: 'option', rest: up, restType: 'equity-option', dx: null };
  }
  const root = up.replace(/^\$/, '').replace(/\.X$/, '');
  const isIndex = up.startsWith('$') || INDEXES.has(root);
  return { input: raw, root, kind: isIndex ? 'index' : 'equity', rest: root, restType: isIndex ? 'index' : 'equity', dx: root };
}

// ── Schwab-shape builders ───────────────────────────────────────────────────
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    const dashed = k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (obj[dashed] !== undefined && obj[dashed] !== null && obj[dashed] !== '') return obj[dashed];
  }
  return null;
}

function schwabQuoteFromRest(p, it) {
  const bid = num(pick(it, 'bid')), ask = num(pick(it, 'ask'));
  const last = num(pick(it, 'last', 'lastMkt', 'mark', 'mid'));
  return schwabQuote(p, {
    last, bid, ask,
    mark: num(pick(it, 'mark', 'mid'), null),
    prevClose: num(pick(it, 'prevClose', 'close'), null),
    open: num(pick(it, 'open')), high: num(pick(it, 'dayHighPrice')), low: num(pick(it, 'dayLowPrice')),
    volume: num(pick(it, 'volume')),
    high52: num(pick(it, 'yearHighPrice')), low52: num(pick(it, 'yearLowPrice')),
    description: it.instrument?.description || it.description || null,
    source: 'tastytrade-rest',
  });
}

function schwabQuote(p, d) {
  const mark = d.mark ?? (d.bid && d.ask ? (d.bid + d.ask) / 2 : d.last);
  const change = d.prevClose ? d.last - d.prevClose : 0;
  const assetMainType = p.kind === 'index' ? 'INDEX' : p.kind === 'future' ? 'FUTURE' : p.kind === 'option' ? 'OPTION' : 'EQUITY';
  return {
    assetMainType,
    symbol: p.input,
    realtime: true,
    quote: {
      lastPrice: d.last, bidPrice: d.bid || 0, askPrice: d.ask || 0, mark,
      closePrice: d.prevClose ?? 0,
      netChange: round(change, 4),
      netPercentChange: d.prevClose ? round((change / d.prevClose) * 100, 4) : 0,
      openPrice: d.open || 0, highPrice: d.high || 0, lowPrice: d.low || 0,
      totalVolume: d.volume || 0,
      '52WeekHigh': d.high52 || 0, '52WeekLow': d.low52 || 0,
      quoteTime: Date.now(), tradeTime: Date.now(),
    },
    reference: { description: d.description || p.root, exchangeName: '' },
    source: d.source,
  };
}

function schwabOption(c, L, underlyingPrice, dte) {
  const q = L.quote || {}, t = L.trade || {}, g = L.greeks || {}, s = L.summary || {};
  const bid = num(q.bidPrice), ask = num(q.askPrice);
  const last = num(t.price);
  const mark = bid > 0 && ask > 0 ? (bid + ask) / 2 : (last || num(g.price));
  const itm = c.side === 'CALL' ? underlyingPrice > c.strike : underlyingPrice < c.strike;
  const intrinsic = Math.max(0, c.side === 'CALL' ? underlyingPrice - c.strike : c.strike - underlyingPrice);
  const prevClose = num(s.prevDayClosePrice, null);
  const [y, mo, d] = c.date.split('-');
  return {
    putCall: c.side,
    symbol: c.occ || c.streamer,
    streamerSymbol: c.streamer,
    description: `${c.root} ${mo}/${d}/${y} ${c.strike.toFixed(2)} ${c.side === 'CALL' ? 'C' : 'P'}`,
    exchangeName: 'OPR',
    bid, ask, last, mark: round(mark, 4),
    bidSize: num(q.bidSize), askSize: num(q.askSize),
    highPrice: num(s.dayHighPrice), lowPrice: num(s.dayLowPrice), openPrice: num(s.dayOpenPrice),
    closePrice: prevClose ?? 0,
    totalVolume: num(t.dayVolume),
    netChange: prevClose != null && last ? round(last - prevClose, 4) : 0,
    volatility: g.volatility != null ? round(g.volatility * 100, 3) : 0, // Schwab reports IV in percent
    delta: num(g.delta), gamma: num(g.gamma), theta: num(g.theta), vega: num(g.vega), rho: num(g.rho),
    openInterest: num(s.openInterest),
    theoreticalOptionValue: num(g.price),
    timeValue: round(Math.max(0, mark - intrinsic), 4),
    intrinsicValue: round(intrinsic, 4),
    strikePrice: c.strike,
    expirationDate: `${c.date}T20:00:00.000+00:00`,
    daysToExpiration: dte,
    expirationType: c.expType,
    settlementType: c.settle === 'AM' ? 'A' : 'P',
    optionRoot: c.root,
    multiplier: 100,
    inTheMoney: itm,
    isIndexOption: INDEXES.has(String(c.root).replace(/[WP]$/, '')),
    quoteTimeInLong: Date.now(),
    tradeTimeInLong: Date.now(),
  };
}

function atmIv(callMap, price) {
  const first = Object.values(callMap)[0];
  if (!first || !price) return 0;
  const strikes = Object.keys(first).map(Number).sort((a, b) => Math.abs(a - price) - Math.abs(b - price)).slice(0, 3);
  const ivs = strikes.map(s => first[s.toFixed(1)]?.[0]?.volatility).filter(v => v > 0);
  return ivs.length ? round(ivs.reduce((a, b) => a + b, 0) / ivs.length, 3) : 0;
}

function mid(q) {
  if (!q) return null;
  const b = num(q.bidPrice, null), a = num(q.askPrice, null);
  return b != null && a != null && b > 0 && a > 0 ? (a + b) / 2 : null;
}
function settleRank(s) { return s === 'PM' ? 0 : s === 'AM' ? 2 : 1; }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000); }
function round(v, n) { const f = 10 ** n; return Math.round(v * f) / f; }
function intEnv(name, d) { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : d; }

module.exports = { TastyMarketData, parseSymbol };
