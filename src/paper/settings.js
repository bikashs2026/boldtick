// src/paper/settings.js — every limit and rule default, editable on the website
//
// Stored as flat keys ("risk.max_loss_per_trade") so the website can build its
// form from FIELDS and the API can patch single values. Limits that can block
// or merely warn carry a mode in `modes` ("block" | "warn" | "off").
// Credentials, the broker host and account number are deliberately NOT here.

const STRUCTURES = ['iron_condor', 'bull_put_spread', 'diagonal', 'calendar', 'covered_strangle', 'covered_call'];
const MODES = ['block', 'warn', 'off'];

// type: number | int | bool | hm | hm_range | range | list | structures | enum | none
const FIELDS = [
  // ── Risk limits ──
  { key: 'risk.max_loss_per_trade', group: 'risk', label: 'Max loss per trade', unit: '$', type: 'number', min: 0, default: 1000, mode: 'block' },
  { key: 'risk.max_contracts', group: 'risk', label: 'Max contracts per order', type: 'int', min: 1, max: 500, default: 10, mode: 'block' },
  { key: 'risk.max_open_positions', group: 'risk', label: 'Max open positions', type: 'int', min: 1, max: 200, default: 5, mode: 'block' },
  { key: 'risk.max_total_open_risk', group: 'risk', label: 'Max total open risk (sum of max loss)', unit: '$', type: 'number', min: 0, default: 3000, mode: 'block' },
  { key: 'risk.daily_loss_limit', group: 'risk', label: 'Daily realized loss limit (block = kill switch for the day)', unit: '$', type: 'number', min: 0, default: 1500, mode: 'block' },
  { key: 'risk.max_trades_per_day', group: 'risk', label: 'Max new trades per day', type: 'int', min: 1, max: 500, default: 6, mode: 'block' },
  { key: 'risk.max_positions_per_underlying', group: 'risk', label: 'Max open positions per underlying', type: 'int', min: 1, max: 100, default: 2, mode: 'warn' },
  { key: 'risk.allowed_symbols', group: 'risk', label: 'Allowed symbols (empty = any)', type: 'list', default: ['SPX', 'AMD', 'SPCX'], mode: 'block' },
  { key: 'risk.allowed_structures', group: 'risk', label: 'Allowed structures', type: 'structures', default: STRUCTURES.slice(), mode: 'block' },
  { key: 'risk.allow_undefined_risk', group: 'risk', label: 'Allow undefined-risk structures (covered strangle)', type: 'bool', default: true },
  { key: 'risk.earnings_in_window', group: 'risk', label: 'Earnings inside the holding window', type: 'none', default: null, mode: 'warn' },

  // ── Entry rules ──
  { key: 'entry.window', group: 'entry', label: 'Entry window (ET)', type: 'hm_range', default: ['09:35', '15:30'], mode: 'block' },
  { key: 'entry.no_0dte_after', group: 'entry', label: 'No new 0DTE entries after (ET)', type: 'hm', default: '14:00', mode: 'block' },
  { key: 'entry.ttl_0dte_min', group: 'entry', label: 'Idea time-to-live, 0DTE', unit: 'min', type: 'int', min: 1, max: 390, default: 15 },
  { key: 'entry.ttl_other_until', group: 'entry', label: 'Idea time-to-live, other: until (ET)', type: 'hm', default: '15:45' },
  { key: 'entry.limit_vs_mid_pct', group: 'entry', label: 'Limit vs live mid, max difference', unit: '%', type: 'number', min: 0, max: 100, default: 15, mode: 'warn' },
  { key: 'entry.reconfirm_move_pct', group: 'entry', label: 'Re-confirm at Approve if mid moved more than', unit: '%', type: 'number', min: 0, max: 100, default: 10 },
  { key: 'entry.min_credit_pct_width', group: 'entry', label: 'Minimum credit, % of spread width', unit: '%', type: 'number', min: 0, max: 100, default: 15, mode: 'warn' },
  { key: 'entry.delta_ic_0dte', group: 'entry', label: 'Short-strike |delta| range, 0DTE iron condor', type: 'range', min: 0, max: 1, default: [0.08, 0.20], mode: 'warn' },
  { key: 'entry.delta_strangle', group: 'entry', label: 'Short-strike |delta| range, strangle', type: 'range', min: 0, max: 1, default: [0.15, 0.30], mode: 'warn' },
  { key: 'entry.muse_mismatch_pct', group: 'entry', label: "Max mismatch with Muse's max loss / breakevens", unit: '%', type: 'number', min: 0, max: 100, default: 5, mode: 'warn' },
  { key: 'entry.cancel_unfilled_0dte_min', group: 'entry', label: 'Cancel unfilled 0DTE entry after', unit: 'min', type: 'int', min: 1, max: 390, default: 10 },
  { key: 'entry.cancel_unfilled_other_at', group: 'entry', label: 'Cancel unfilled other entries at (ET)', type: 'hm', default: '15:45' },

  // ── Exit rules (overridable per structure) ──
  { key: 'exit.tp_credit_pct', group: 'exit', label: 'Take profit, credit trades: % of max profit', unit: '%', type: 'number', min: 1, max: 99, default: 50, perStructure: true },
  { key: 'exit.stop_credit_mult', group: 'exit', label: 'Stop, credit trades: loss as a multiple of credit', unit: '×', type: 'number', min: 0.1, max: 20, default: 1.5, perStructure: true },
  { key: 'exit.tp_debit_pct', group: 'exit', label: 'Take profit, debit trades: % gain on debit', unit: '%', type: 'number', min: 1, max: 1000, default: 25, perStructure: true },
  { key: 'exit.stop_debit_pct', group: 'exit', label: 'Stop, debit trades: % loss of debit', unit: '%', type: 'number', min: 1, max: 100, default: 50, perStructure: true },
  { key: 'exit.gamma_from', group: 'exit', label: 'Gamma warning from (ET, expiry day)', type: 'hm', default: '14:00', perStructure: true },
  { key: 'exit.gamma_within_pct', group: 'exit', label: 'Gamma warning: underlying within % of a short strike', unit: '%', type: 'number', min: 0, max: 20, default: 1, perStructure: true },
  { key: 'exit.close_expiry_at', group: 'exit', label: 'Expiry close signal at (ET)', type: 'hm', default: '15:30', perStructure: true },
  { key: 'exit.clear_margin_pct', group: 'exit', label: 'Signal clear margin past threshold', unit: '%', type: 'number', min: 0, max: 50, default: 10 },
  { key: 'exit.muse_overrides', group: 'exit', label: "Muse's suggested take profit / stop override these", type: 'bool', default: true },
  { key: 'exit.close_price_mode', group: 'exit', label: 'Default closing price', type: 'enum', options: ['mid', 'natural'], default: 'mid' },
  { key: 'exit.cross_after_min', group: 'exit', label: 'Offer "cross to natural" after', unit: 'min', type: 'int', min: 0, max: 60, default: 2 },

  // ── Fills (live-market scorecard) ──
  { key: 'fills.model', group: 'fills', label: 'Scorecard fills when the live price reaches the limit at', type: 'enum', options: ['mid', 'natural'], default: 'mid' },

  // ── Alerts ──
  { key: 'alerts.new_idea', group: 'alerts', label: 'Notification and sound for a new idea', type: 'bool', default: true },
  { key: 'alerts.urgent_signals', group: 'alerts', label: 'Notification and sound for STOP, CLOSE_EXPIRY, ADJUST', type: 'bool', default: true },

  // ── Timing ──
  { key: 'timing.engine_interval_s', group: 'timing', label: 'Mark and engine interval, market hours', unit: 's', type: 'int', min: 5, max: 600, default: 30 },
  { key: 'timing.sync_interval_s', group: 'timing', label: 'Fill check and order sync interval, market hours', unit: 's', type: 'int', min: 5, max: 600, default: 10 },
  { key: 'timing.offhours_interval_s', group: 'timing', label: 'Interval outside market hours', unit: 's', type: 'int', min: 30, max: 3600, default: 300 },

  // ── Muse ──
  { key: 'muse.accept_ideas', group: 'muse', label: 'Accept ideas from Muse', type: 'bool', default: true },
  { key: 'muse.accept_signals', group: 'muse', label: 'Accept signals from Muse', type: 'bool', default: true },
  { key: 'muse.rate_post_per_min', group: 'muse', label: 'Muse posts per minute', type: 'int', min: 1, max: 600, default: 30 },
  { key: 'muse.rate_get_per_min', group: 'muse', label: 'Muse reads per minute', type: 'int', min: 1, max: 6000, default: 120 },
];

const GROUPS = [
  { id: 'risk', label: 'Risk limits' },
  { id: 'entry', label: 'Entry rules' },
  { id: 'exit', label: 'Exit rules' },
  { id: 'fills', label: 'Fills' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'timing', label: 'Timing' },
  { id: 'muse', label: 'Muse' },
];

const BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function defaults() {
  const values = {}, modes = {};
  for (const f of FIELDS) {
    values[f.key] = clone(f.default);
    if (f.mode) modes[f.key] = f.mode;
  }
  return { version: 1, updated_at: null, values, modes, exit_per_structure: {} };
}

class SettingsError extends Error {
  constructor(details) { super('Invalid settings'); this.details = details; }
}

class Settings {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    const saved = store.load('settings.json', null);
    const base = defaults();
    if (saved) {
      // Keep saved values for known keys; new keys added in later versions get defaults.
      for (const k of Object.keys(base.values)) if (saved.values && k in saved.values) base.values[k] = saved.values[k];
      for (const k of Object.keys(base.modes)) if (saved.modes && MODES.includes(saved.modes[k])) base.modes[k] = saved.modes[k];
      base.exit_per_structure = saved.exit_per_structure || {};
      base.version = saved.version || 1;
      base.updated_at = saved.updated_at || null;
    }
    this.state = base;
    if (!saved) store.save('settings.json', this.state);
  }

  get() { return clone(this.state); }
  meta() { return { groups: GROUPS, fields: FIELDS, structures: STRUCTURES, modes: MODES }; }
  value(key) { if (!BY_KEY.has(key)) throw new Error(`unknown setting ${key}`); return this.state.values[key]; }
  mode(key) { return this.state.modes[key] || 'block'; }

  // Effective exit rules for a structure (per-structure overrides on top of defaults).
  exitRules(structure) {
    const out = {};
    for (const f of FIELDS) if (f.group === 'exit') out[f.key.slice(5)] = this.state.values[f.key];
    const over = this.state.exit_per_structure[structure] || {};
    for (const [k, v] of Object.entries(over)) out[k.replace(/^exit\./, '')] = v;
    return out;
  }

  // patch = { version, values?: {key: value}, modes?: {key: mode}, exit_per_structure?: {structure: {key: value|null}} }
  update(patch, by = 'owner') {
    if (!patch || typeof patch !== 'object') throw new SettingsError([{ field: '', issue: 'body must be an object' }]);
    if (patch.version !== this.state.version) {
      const e = new Error('Settings changed since you loaded them; reload and try again.');
      e.code = 'version_conflict'; e.current = this.state.version;
      throw e;
    }
    const next = clone(this.state);
    const errors = [];
    const changes = [];

    for (const [key, raw] of Object.entries(patch.values || {})) {
      const f = BY_KEY.get(key);
      if (!f) { errors.push({ field: key, issue: 'unknown setting' }); continue; }
      if (f.type === 'none') { errors.push({ field: key, issue: 'this setting has only a mode' }); continue; }
      const r = coerce(f, raw);
      if (r.error) { errors.push({ field: key, issue: r.error }); continue; }
      if (JSON.stringify(next.values[key]) !== JSON.stringify(r.value)) changes.push({ key, old: next.values[key], new: r.value });
      next.values[key] = r.value;
    }
    for (const [key, mode] of Object.entries(patch.modes || {})) {
      const f = BY_KEY.get(key);
      if (!f || !f.mode) { errors.push({ field: key, issue: 'this setting has no mode' }); continue; }
      if (!MODES.includes(mode)) { errors.push({ field: key, issue: `mode must be one of ${MODES.join(', ')}` }); continue; }
      if (next.modes[key] !== mode) changes.push({ key: `${key}#mode`, old: next.modes[key], new: mode });
      next.modes[key] = mode;
    }
    for (const [structure, over] of Object.entries(patch.exit_per_structure || {})) {
      if (!STRUCTURES.includes(structure)) { errors.push({ field: `exit_per_structure.${structure}`, issue: 'unknown structure' }); continue; }
      const cur = { ...(next.exit_per_structure[structure] || {}) };
      for (const [key, raw] of Object.entries(over || {})) {
        const f = BY_KEY.get(key);
        if (!f || !f.perStructure) { errors.push({ field: `exit_per_structure.${structure}.${key}`, issue: 'not overridable per structure' }); continue; }
        if (raw === null) { if (key in cur) changes.push({ key: `${structure}:${key}`, old: cur[key], new: null }); delete cur[key]; continue; }
        const r = coerce(f, raw);
        if (r.error) { errors.push({ field: `exit_per_structure.${structure}.${key}`, issue: r.error }); continue; }
        if (cur[key] !== r.value) changes.push({ key: `${structure}:${key}`, old: cur[key] ?? null, new: r.value });
        cur[key] = r.value;
      }
      if (Object.keys(cur).length) next.exit_per_structure[structure] = cur;
      else delete next.exit_per_structure[structure];
    }

    // Cross-field checks
    const [ws, we] = next.values['entry.window'];
    if (hmMin(ws) >= hmMin(we)) errors.push({ field: 'entry.window', issue: 'start must be before end' });
    if (hmMin(ws) < 570 || hmMin(we) > 960) errors.push({ field: 'entry.window', issue: 'must be within 09:30–16:00 ET' });

    if (errors.length) throw new SettingsError(errors);
    if (!changes.length) return { settings: this.get(), changes };

    next.version = this.state.version + 1;
    next.updated_at = this.clock.iso();
    this.state = next;
    this.store.save('settings.json', this.state);
    this.store.append('settings-history.jsonl', { at: next.updated_at, by, version: next.version, changes });
    return { settings: this.get(), changes };
  }

  reset(by = 'owner') {
    const fresh = defaults();
    fresh.version = this.state.version + 1;
    fresh.updated_at = this.clock.iso();
    this.state = fresh;
    this.store.save('settings.json', this.state);
    this.store.append('settings-history.jsonl', { at: fresh.updated_at, by, version: fresh.version, changes: [{ key: '*', old: 'custom', new: 'defaults' }] });
    return this.get();
  }

  history(limit = 200) { return this.store.readLines('settings-history.jsonl', { limit }).reverse(); }
}

function coerce(f, raw) {
  switch (f.type) {
    case 'number':
    case 'int': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'must be a number' };
      if (f.type === 'int' && !Number.isInteger(n)) return { error: 'must be a whole number' };
      if (f.min !== undefined && n < f.min) return { error: `must be at least ${f.min}` };
      if (f.max !== undefined && n > f.max) return { error: `must be at most ${f.max}` };
      return { value: n };
    }
    case 'bool':
      if (typeof raw !== 'boolean') return { error: 'must be true or false' };
      return { value: raw };
    case 'hm':
      if (typeof raw !== 'string' || !HM.test(raw)) return { error: 'must be HH:MM (24h, ET)' };
      return { value: raw };
    case 'hm_range':
      if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(x => typeof x === 'string' && HM.test(x))) return { error: 'must be ["HH:MM", "HH:MM"]' };
      return { value: raw.slice() };
    case 'range': {
      if (!Array.isArray(raw) || raw.length !== 2) return { error: 'must be [low, high]' };
      const [lo, hi] = raw.map(Number);
      if (![lo, hi].every(Number.isFinite)) return { error: 'must be numbers' };
      if (lo > hi) return { error: 'low must not exceed high' };
      if ((f.min !== undefined && lo < f.min) || (f.max !== undefined && hi > f.max)) return { error: `must be within ${f.min}–${f.max}` };
      return { value: [lo, hi] };
    }
    case 'list': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(',');
      const list = [...new Set(arr.map(s => String(s).trim().toUpperCase().replace(/^\$/, '')).filter(Boolean))];
      if (list.some(s => !/^[A-Z0-9./]{1,10}$/.test(s))) return { error: 'symbols must be letters/digits' };
      return { value: list };
    }
    case 'structures': {
      if (!Array.isArray(raw)) return { error: 'must be a list of structures' };
      const bad = raw.filter(s => !STRUCTURES.includes(s));
      if (bad.length) return { error: `unknown structure: ${bad.join(', ')}` };
      return { value: [...new Set(raw)] };
    }
    case 'enum':
      if (!f.options.includes(raw)) return { error: `must be one of ${f.options.join(', ')}` };
      return { value: raw };
    default:
      return { error: 'not editable' };
  }
}

function hmMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

module.exports = { Settings, SettingsError, FIELDS, GROUPS, STRUCTURES, MODES, defaults };
