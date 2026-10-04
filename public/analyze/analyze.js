// public/analyze/analyze.js — shared helpers for the Analyze tabs (GEX, Chain)

const Analyze = (() => {
  async function api(path) {
    const r = await fetch('/api/analyze' + path, { headers: { Accept: 'application/json' } });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error?.message || `request failed (${r.status})`);
    return data;
  }

  function fmt(n, d = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtM(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const sign = n < 0 ? '−' : '';
    return `${sign}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function clockTick(el) {
    const tick = () => { el.textContent = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET'; };
    tick(); setInterval(tick, 1000);
  }

  function initHeader() {
    const clockEl = document.getElementById('clock');
    if (clockEl) clockTick(clockEl);
    wireIdeaAlert();
  }

  // Pending-idea badge + alert sound on the "Execute" nav link, for any
  // Analyze page. Execute's own tab already has a badge/alert tied directly
  // to its event stream; this is the lightweight version so a new idea from
  // Muse isn't invisible just because you're on a different tab. Polls
  // GET /paper/api/status (same counts.pending_ideas Execute's own header
  // already uses — no new endpoint) every 20s, and reads alerts.new_idea
  // from Settings once so it respects the same on/off switch Execute does.
  function wireIdeaAlert() {
    const link = document.querySelector('a[href="/paper/"]');
    if (!link) return;
    let lastCount = null, alertOn = true, audioCtx;

    function beep() {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 660;
        g.gain.setValueAtTime(0.08, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
        o.connect(g).connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + 0.25);
      } catch { /* audio blocked until the first click on the page — badge still updates */ }
    }

    function badgeEl() {
      let el = document.getElementById('navIdeaBadge');
      if (el) return el;
      el = document.createElement('span');
      el.id = 'navIdeaBadge';
      el.className = 'nav-idea-badge';
      el.title = 'Pending trade ideas';
      el.hidden = true;
      link.appendChild(el);
      return el;
    }

    async function poll() {
      try {
        const r = await fetch('/paper/api/status', { credentials: 'same-origin' });
        if (!r.ok) return; // not logged in here yet, or desk unreachable — leave badge as last known
        const s = await r.json();
        const n = s.counts?.pending_ideas ?? 0;
        const el = badgeEl();
        el.hidden = n === 0;
        el.textContent = n;
        if (lastCount !== null && n > lastCount && alertOn) beep();
        lastCount = n;
      } catch { /* offline — leave the last known badge as-is */ }
    }

    (async () => {
      try {
        const r = await fetch('/paper/api/settings', { credentials: 'same-origin' });
        if (r.ok) { const s = await r.json(); alertOn = s.values?.['alerts.new_idea'] !== false; }
      } catch { /* default stays on */ }
      poll();
      setInterval(poll, 20000);
    })();
  }

  // Shared symbol/expiry controls: loads expirations, keeps them in sync,
  // calls onChange(symbol, expiry) whenever either settles on a usable value.
  function wireControls({ symbolInput, expirySelect, onChange, defaultSymbol = 'SPX' }) {
    let symbol = (localStorage.getItem('analyze.symbol') || defaultSymbol).toUpperCase();
    symbolInput.value = symbol;

    async function loadExpirations() {
      expirySelect.innerHTML = '<option>Loading…</option>';
      try {
        const r = await api(`/expirations/${encodeURIComponent(symbol)}`);
        const list = r.expirations || [];
        if (!list.length) { expirySelect.innerHTML = '<option value="">No expirations</option>'; return; }
        expirySelect.innerHTML = list.map(e => {
          const dte = e.daysToExpiration;
          const label = `${e.expirationDate} · ${dte === 0 ? '0DTE' : dte + 'DTE'}`;
          return `<option value="${esc(e.expirationDate)}">${esc(label)}</option>`;
        }).join('');
        expirySelect.selectedIndex = 0;
        onChange(symbol, expirySelect.value);
      } catch (e) {
        expirySelect.innerHTML = `<option value="">error</option>`;
        onChange(symbol, null, e);
      }
    }

    symbolInput.addEventListener('change', () => {
      const v = symbolInput.value.trim().toUpperCase();
      if (!v || v === symbol) { symbolInput.value = symbol; return; }
      symbol = v;
      localStorage.setItem('analyze.symbol', symbol);
      loadExpirations();
    });
    expirySelect.addEventListener('change', () => onChange(symbol, expirySelect.value));

    loadExpirations();
    return { get symbol() { return symbol; }, reload: loadExpirations };
  }

  return { api, fmt, fmtM, esc, initHeader, wireControls };
})();
