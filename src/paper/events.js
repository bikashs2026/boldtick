// src/paper/events.js — ids and the event feed Muse reads to learn outcomes

const crypto = require('crypto');

// Sortable ids: prefix + 10-char base36 time + 4-char counter + 4 random chars.
let lastMs = 0, counter = 0;
function newId(prefix, nowMs = Date.now()) {
  if (nowMs === lastMs) counter++; else { lastMs = nowMs; counter = 0; }
  const t = nowMs.toString(36).padStart(10, '0');
  const c = counter.toString(36).padStart(4, '0');
  const r = crypto.randomBytes(3).toString('hex').slice(0, 4);
  return `${prefix}_${t}${c}${r}`.toUpperCase().replace(/^([A-Z]+)_/, (_, p) => p.toLowerCase() + '_');
}

const EVENT_TYPES = new Set([
  'idea.created', 'idea.invalid', 'idea.approved', 'idea.rejected', 'idea.expired',
  'order.submitted', 'order.filled', 'order.partially_filled', 'order.cancelled', 'order.rejected',
  'position.opened', 'signal.raised', 'position.closed', 'reconcile.mismatch',
  'settings.changed', 'kill_switch.changed',
]);

class Events {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    this.items = store.readLines('events.jsonl');
    this.listeners = new Set();
  }

  emit(type, fields = {}) {
    if (!EVENT_TYPES.has(type)) throw new Error(`unknown event type ${type}`);
    const now = this.clock.now();
    const ev = { id: newId('evt', now), at: new Date(now).toISOString(), type, ...fields };
    this.items.push(ev);
    this.store.append('events.jsonl', ev);
    for (const fn of this.listeners) { try { fn(ev); } catch { /* listener errors never break the flow */ } }
    return ev;
  }

  // Events after the given id (exclusive), oldest first. Unknown cursor → from the start.
  list({ after = null, limit = 100, types = null } = {}) {
    let start = 0;
    if (after) {
      const i = this.items.findIndex(e => e.id === after);
      start = i >= 0 ? i + 1 : this.items.findIndex(e => e.id > after);
      if (start < 0) start = this.items.length;
    }
    let out = this.items.slice(start);
    if (types) out = out.filter(e => types.includes(e.type));
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const page = out.slice(0, lim);
    return { events: page, next: page.length ? page[page.length - 1].id : after, more: out.length > lim };
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

module.exports = { Events, newId, EVENT_TYPES };
