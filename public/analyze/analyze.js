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
