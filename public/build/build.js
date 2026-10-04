// public/build/build.js — the Build tab: construct a structure, see it priced
// live and its P&L curve, then send it to Trade Ideas or straight to the
// broker. Talks to /paper/api/build/* (src/paper/api/routes.js) — the same
// validateIdea()/riskProfile() math the rest of Paper Desk runs on, so
// nothing shown here can disagree with what Submit actually enforces.

(() => {
  // ── tiny API helper (owner session — Basic Auth already cached by the browser
  // for this origin, same as analyze.js's own calls into /paper/api) ──
  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-Requested-With'] = 'paper-desk';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch('/paper/api' + path, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error?.message || `request failed (${r.status})`);
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  }

  // ── client-side tick rounding, mirrors src/paper/pricing.js roundToTick ──
  function roundToTick(symbol, price) {
    const s = String(symbol).toUpperCase().replace(/^\$/, '');
    const tick = (s === 'SPX' || s === 'SPXW' || s === 'XSP') ? (price >= 3 ? 0.10 : 0.05) : 0.01;
    const steps = Math.round(Number((price / tick).toFixed(6)));
    return Math.max(tick, Math.round(steps * tick * 100) / 100);
  }

  // ── Black-Scholes, mirrors src/paper/blackscholes.js — only used client-side
  // to draw the T+0 line; every number that actually matters (entry price,
  // risk, what Submit sends) comes from the server's live quotes, never this. ──
  function erf(x) {
    const sign = x < 0 ? -1 : 1; x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  function normCDF(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
  function bsPrice(type, S, K, T, sigma, r = 0.045) {
    if (T <= 0 || !(sigma > 0)) return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    const sd = sigma * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / sd, d2 = d1 - sd;
    return type === 'call' ? S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2) : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
  }
  function payoffAtExpiry(legs, S, u) {
    return legs.reduce((sum, l) => {
      const intrinsic = l.type === 'call' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
      const w = u ? l.qty / u : 1;
      return sum + (l.action === 'buy' ? intrinsic : -intrinsic) * w;
    }, 0);
  }

  function fmtMoney(n, forceSign) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const sign = n < 0 ? '−' : (forceSign && n > 0 ? '+' : '');
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ── structure "slots": required leg count/side/type, matching validate.js's
  // checkShape exactly. "custom" has no fixed slots — legs are freely edited,
  // added and removed (capped at 4, same limit the schema enforces). ──
  const STRUCTURE_SLOTS = {
    iron_condor:      { creditOrDebit: 'credit', legs: [{ action: 'buy', type: 'put' }, { action: 'sell', type: 'put' }, { action: 'sell', type: 'call' }, { action: 'buy', type: 'call' }] },
    bull_put_spread:  { creditOrDebit: 'credit', legs: [{ action: 'sell', type: 'put' }, { action: 'buy', type: 'put' }] },
    butterfly:        { creditOrDebit: 'debit',  legs: [{ action: 'buy', type: 'call' }, { action: 'sell', type: 'call' }, { action: 'buy', type: 'call' }], lockedBodyQty: 1 },
    rsb:              { creditOrDebit: null,     legs: [{ action: 'buy', type: 'call' }, { action: 'sell', type: 'call' }, { action: 'sell', type: 'put' }] },
    diagonal:         { creditOrDebit: 'debit',  legs: [{ action: 'buy', type: 'call' }, { action: 'sell', type: 'call' }], crossExpiry: true, freeType: true },
    calendar:         { creditOrDebit: 'debit',  legs: [{ action: 'buy', type: 'call' }, { action: 'sell', type: 'call' }], crossExpiry: true, freeType: true, syncStrikeAndType: true },
    covered_strangle: { creditOrDebit: 'credit', legs: [{ action: 'sell', type: 'put' }, { action: 'sell', type: 'call' }] },
    covered_call:     { creditOrDebit: 'credit', legs: [{ action: 'sell', type: 'call' }] },
    custom:           { creditOrDebit: null, legs: null, crossExpiry: true },
  };
  const STRUCTURE_LABELS = {
    iron_condor: 'Iron condor', bull_put_spread: 'Bull put spread', butterfly: 'Butterfly', rsb: 'RSB (Ratio Superbull)', diagonal: 'Diagonal',
    calendar: 'Calendar', covered_strangle: 'Covered strangle', covered_call: 'Covered call', custom: 'Custom',
  };
  // Representative "unit" qty for a structure's legs — mirrors
  // src/paper/pricing.js's units(): the wing's qty for a butterfly (its body
  // is always double that), the first leg's qty for everything else.
  function unitsOf(ls, struct) {
    if (!ls.length) return 1;
    if (struct === 'butterfly') { const wing = ls.find(l => l.action === 'buy'); return wing ? wing.qty : ls[0].qty; }
    return ls[0].qty;
  }

  // ── state ──
  let symbol = (localStorage.getItem('build.symbol') || 'SPX').toUpperCase();
  let structure = 'iron_condor';
  let codOverride = 'credit'; // only used by 'custom'
  let expirationsList = [];   // ['2026-10-05', ...]
  let frontExpiry = null;
  const chainCache = new Map(); // expiry -> {underlying, contracts}
  let legs = [];
  let lastPriced = null;      // last /build/price response
  let asOfDays = 0;
  let destination = 'ideas';
  let pendingRepriceConfirm = false;
  let priceSeq = 0;           // guards against an older /build/price response landing after a newer one

  // ── chain loading ──
  async function getChain(expiry) {
    if (chainCache.has(expiry)) return chainCache.get(expiry);
    const r = await api('GET', `/chain/${encodeURIComponent(symbol)}?expiry=${encodeURIComponent(expiry)}`);
    chainCache.set(expiry, r);
    return r;
  }
  function strikesOf(chain, type) {
    return [...new Set(chain.contracts.filter(c => c.type === type).map(c => c.strike))].sort((a, b) => a - b);
  }
  function nearestByDelta(chain, type, targetAbsDelta) {
    const pool = chain.contracts.filter(c => c.type === type && c.delta != null);
    if (!pool.length) return strikesOf(chain, type)[0];
    let best = pool[0], bestDiff = Infinity;
    for (const c of pool) { const d = Math.abs(Math.abs(c.delta) - targetAbsDelta); if (d < bestDiff) { bestDiff = d; best = c; } }
    return best.strike;
  }
  function strikeSteps(chain, type, fromStrike, steps) {
    const arr = strikesOf(chain, type);
    const idx = arr.indexOf(fromStrike);
    if (idx < 0) return fromStrike;
    return arr[Math.max(0, Math.min(arr.length - 1, idx + steps))];
  }
  function nearestStrike(chain, type, target) {
    const arr = strikesOf(chain, type);
    if (!arr.length) return Math.round(target);
    return arr.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best, arr[0]);
  }
  function pickBackExpiry(front) {
    const idx = expirationsList.indexOf(front);
    return expirationsList[idx + 5] || expirationsList[expirationsList.length - 1] || front;
  }

  async function defaultLegsFor(struct) {
    const front = await getChain(frontExpiry);
    switch (struct) {
      case 'iron_condor': {
        const sp = nearestByDelta(front, 'put', 0.16), sc = nearestByDelta(front, 'call', 0.16);
        return [
          { action: 'buy', type: 'put', strike: strikeSteps(front, 'put', sp, -6), expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'put', strike: sp, expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'call', strike: sc, expiry: frontExpiry, qty: 1 },
          { action: 'buy', type: 'call', strike: strikeSteps(front, 'call', sc, 6), expiry: frontExpiry, qty: 1 },
        ];
      }
      case 'bull_put_spread': {
        const sp = nearestByDelta(front, 'put', 0.16);
        return [
          { action: 'sell', type: 'put', strike: sp, expiry: frontExpiry, qty: 1 },
          { action: 'buy', type: 'put', strike: strikeSteps(front, 'put', sp, -6), expiry: frontExpiry, qty: 1 },
        ];
      }
      case 'butterfly': {
        // Symmetric, ATM-centered, 3 legs — two long wings (qty 1 each) and
        // one short body (qty 2) sitting between them.
        const atm = nearestStrike(front, 'call', front.underlying);
        const lowWing = strikeSteps(front, 'call', atm, -5), highWing = strikeSteps(front, 'call', atm, 5);
        return [
          { action: 'buy', type: 'call', strike: lowWing, expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'call', strike: atm, expiry: frontExpiry, qty: 2 },
          { action: 'buy', type: 'call', strike: highWing, expiry: frontExpiry, qty: 1 },
        ];
      }
      case 'rsb': {
        // Debit call spread (buy lower / sell higher) + a short put, all one
        // expiry, qty uniform across the three legs like any other structure.
        let lc = nearestByDelta(front, 'call', 0.35), hc = nearestByDelta(front, 'call', 0.16);
        if (lc >= hc) hc = strikeSteps(front, 'call', lc, 1);
        return [
          { action: 'buy', type: 'call', strike: lc, expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'call', strike: hc, expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'put', strike: nearestByDelta(front, 'put', 0.16), expiry: frontExpiry, qty: 1 },
        ];
      }
      case 'covered_strangle':
        return [
          { action: 'sell', type: 'put', strike: nearestByDelta(front, 'put', 0.16), expiry: frontExpiry, qty: 1 },
          { action: 'sell', type: 'call', strike: nearestByDelta(front, 'call', 0.16), expiry: frontExpiry, qty: 1 },
        ];
      case 'covered_call':
        return [{ action: 'sell', type: 'call', strike: nearestByDelta(front, 'call', 0.2), expiry: frontExpiry, qty: 1 }];
      case 'diagonal':
      case 'calendar': {
        const back = pickBackExpiry(frontExpiry);
        const atm = nearestStrike(front, 'call', front.underlying);
        return [
          { action: 'buy', type: 'call', strike: atm, expiry: back, qty: 1 },
          { action: 'sell', type: 'call', strike: atm, expiry: frontExpiry, qty: 1 },
        ];
      }
      default: // custom
        return legs.length ? legs : [{ action: 'sell', type: 'put', strike: nearestByDelta(front, 'put', 0.16), expiry: frontExpiry, qty: 1 }];
    }
  }

  // ── leg table ──
  function renderLegs() {
    const body = document.getElementById('legsBody');
    const slot = STRUCTURE_SLOTS[structure];
    const editable = structure === 'custom';
    document.getElementById('btnAddLeg').hidden = !editable;
    document.getElementById('legCapNote').textContent = editable ? `${legs.length}/4 legs` : '';
    document.getElementById('legsNote').textContent = editable
      ? 'Pick side, type and strike freely — up to 4 legs.'
      : slot.freeType
        ? `${STRUCTURE_LABELS[structure]}: side is fixed by the structure; pick the type and strikes.`
        : `${STRUCTURE_LABELS[structure]}: side and type are fixed by the structure; pick the strikes.`;

    body.innerHTML = legs.map((leg, i) => {
      const q = lastPriced && lastPriced.legs[i] && lastPriced.legs[i].strike === leg.strike && lastPriced.legs[i].type === leg.type ? lastPriced.legs[i] : null;
      const chain = chainCache.get(leg.expiry);
      let strikeOpts = chain ? strikesOf(chain, leg.type) : (leg.strike ? [leg.strike] : []);
      // A loaded draft/template can carry a strike or expiry that isn't in
      // the live list anymore (its chain hasn't loaded yet, or its expiry
      // has since passed) — inject it as an extra option so the dropdown
      // actually shows what's stored, instead of a <select> with no
      // matching option silently falling back to its first option while the
      // real (different) value stays selected underneath.
      if (leg.strike != null && !strikeOpts.includes(leg.strike)) strikeOpts = [leg.strike, ...strikeOpts];
      const expOpts = (leg.expiry && !expirationsList.includes(leg.expiry)) ? [leg.expiry, ...expirationsList] : expirationsList;
      const typeEditable = editable || slot.freeType;
      const lockedQty = structure === 'butterfly' && i === 1; // the body — always 2x a wing's qty
      return `
        <tr data-i="${i}">
          <td><div class="seg${editable ? '' : ' readonly'}">
            <button type="button" class="side ${leg.action === 'buy' ? 'active buy' : ''}" data-side="buy"${editable ? '' : ' disabled'}>Buy</button>
            <button type="button" class="side ${leg.action === 'sell' ? 'active sell' : ''}" data-side="sell"${editable ? '' : ' disabled'}>Sell</button>
          </div></td>
          <td><div class="seg${typeEditable ? '' : ' readonly'}">
            <button type="button" class="type ${leg.type === 'call' ? 'active call' : ''}" data-type="call"${typeEditable ? '' : ' disabled'}>Call</button>
            <button type="button" class="type ${leg.type === 'put' ? 'active put' : ''}" data-type="put"${typeEditable ? '' : ' disabled'}>Put</button>
          </div></td>
          <td><select class="strikeSel">${strikeOpts.map(s => `<option value="${s}" ${s === leg.strike ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
          <td><select class="expSel">${expOpts.map(e => `<option value="${e}" ${e === leg.expiry ? 'selected' : ''}>${e}${expirationsList.includes(e) ? '' : ' (expired)'}</option>`).join('')}</select></td>
          <td>${lockedQty
            ? `<span class="mono" title="Always double a wing's qty">${leg.qty ?? '—'}</span>`
            : `<input type="number" class="qtyIn" min="1" step="1" value="${leg.qty ?? 1}">`}</td>
          <td class="quote ${q ? '' : 'stale'}">${q ? q.bid.toFixed(2) : '…'}</td>
          <td class="quote ${q ? '' : 'stale'}">${q ? q.ask.toFixed(2) : '…'}</td>
          <td class="quote ${q ? '' : 'stale'}">${q ? q.mid.toFixed(2) : '…'}</td>
          <td class="quote ${q ? '' : 'stale'}">${q && q.delta != null ? q.delta.toFixed(2) : '…'}</td>
          <td>${editable && legs.length > 1 ? '<button type="button" class="rmbtn" title="Remove leg">×</button>' : ''}</td>
        </tr>`;
    }).join('');

    renderNetGreeks();

    body.querySelectorAll('tr').forEach(tr => {
      const i = Number(tr.dataset.i);
      tr.querySelectorAll('.side').forEach(b => b.onclick = () => { legs[i].action = b.dataset.side; renderLegs(); schedulePrice(); });
      tr.querySelectorAll('.type').forEach(b => b.onclick = () => {
        legs[i].type = b.dataset.type;
        if (STRUCTURE_SLOTS[structure].syncStrikeAndType) legs[i === 0 ? 1 : 0].type = legs[i].type;
        renderLegs(); schedulePrice();
      });
      const strikeSel = tr.querySelector('.strikeSel');
      if (strikeSel) strikeSel.onchange = e => {
        legs[i].strike = Number(e.target.value);
        if (STRUCTURE_SLOTS[structure].syncStrikeAndType) legs[i === 0 ? 1 : 0].strike = legs[i].strike;
        renderLegs(); schedulePrice();
      };
      const expSel = tr.querySelector('.expSel');
      if (expSel) expSel.onchange = async e => {
        const newExpiry = e.target.value;
        const crossExpiry = STRUCTURE_SLOTS[structure].crossExpiry;
        await getChain(newExpiry);
        const targets = crossExpiry ? [i] : legs.map((_, idx) => idx);
        for (const idx of targets) {
          legs[idx].expiry = newExpiry;
          legs[idx].strike = nearestStrike(chainCache.get(newExpiry), legs[idx].type, legs[idx].strike || chainCache.get(newExpiry).underlying);
        }
        renderLegs(); schedulePrice();
      };
      const qtyIn = tr.querySelector('.qtyIn');
      if (qtyIn) qtyIn.onchange = e => {
        const v = Math.max(1, Math.round(Number(e.target.value)) || 1);
        if (structure === 'butterfly') {
          // wings (0, 2) stay matched; the body is always double a wing's qty.
          legs[0].qty = v; legs[2].qty = v; legs[1].qty = v * 2;
        } else {
          legs.forEach(l => { l.qty = v; });
        }
        renderLegs(); schedulePrice();
      };
      const rm = tr.querySelector('.rmbtn');
      if (rm) rm.onclick = () => { legs.splice(i, 1); renderLegs(); schedulePrice(); };
    });
  }

  function renderNetGreeks() {
    const dEl = document.getElementById('netDelta'), tEl = document.getElementById('netTheta');
    if (!lastPriced) { dEl.textContent = '—'; tEl.textContent = '—'; return; }
    let delta = 0, theta = 0, any = false;
    legs.forEach((l, i) => {
      const q = lastPriced.legs[i];
      if (!q || q.strike !== l.strike || q.type !== l.type) return;
      const sign = l.action === 'buy' ? 1 : -1;
      if (q.delta != null) { delta += sign * q.delta * l.qty; any = true; }
      if (q.theta != null) { theta += sign * q.theta * l.qty; any = true; }
    });
    dEl.textContent = any ? delta.toFixed(2) : '—';
    tEl.textContent = any ? theta.toFixed(2) : '—';
  }

  document.getElementById('btnAddLeg').onclick = async () => {
    if (legs.length >= 4) return;
    const front = await getChain(frontExpiry);
    legs.push({ action: 'sell', type: 'put', strike: nearestByDelta(front, 'put', 0.16), expiry: frontExpiry, qty: 1 });
    renderLegs(); schedulePrice();
  };

  // ── pricing: fetch from the server, then draw stats + chart from it ──
  let priceTimer = null;
  function schedulePrice() { clearTimeout(priceTimer); priceTimer = setTimeout(fetchPrice, 180); }

  function creditOrDebitFor() { const cod = STRUCTURE_SLOTS[structure].creditOrDebit; return cod === null ? codOverride : cod; }

  // The "Price is" field above the Legs table never needs to be shown or
  // hand-picked, for any structure: a fixed-direction structure's direction
  // comes from STRUCTURE_SLOTS, and custom/rsb's comes from the server
  // (naturalCreditOrDebit in pricing.js), which is resynced into codOverride
  // on every fetchPrice() regardless of whether this field is visible — the
  // Net credit/Net debit stat tile already shows whichever one it is. #codSel
  // itself stays in the DOM (fetchPrice still writes codOverride into it) so
  // nothing else has to change, it's just never displayed or editable.
  function updateCodField() {
    document.getElementById('codField').hidden = true;
    document.getElementById('codSel').disabled = true;
  }

  async function fetchPrice() {
    if (!legs.length) return;
    const seq = ++priceSeq;
    const errEl = document.getElementById('loadErr');
    try {
      const r = await api('POST', '/build/price', {
        symbol, structure, expiry: frontExpiry, credit_or_debit: creditOrDebitFor(),
        legs: legs.map(l => ({ action: l.action, type: l.type, strike: l.strike, expiry: l.expiry, qty: l.qty })),
      });
      if (seq !== priceSeq) return; // a newer request already landed
      lastPriced = r;
      // custom/rsb have no fixed direction — which way the legs actually net
      // is computed server-side from live quotes (never guessed client-side;
      // guessing wrong would silently flip max profit/loss), so sync the
      // display to whatever the server just computed.
      if (STRUCTURE_SLOTS[structure].creditOrDebit === null && r.credit_or_debit) {
        codOverride = r.credit_or_debit;
        document.getElementById('codSel').value = codOverride;
      }
      errEl.hidden = true;
      document.getElementById('spotVal').textContent = r.underlying != null ? r.underlying.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—';
      document.getElementById('asofSlider').max = Math.max(0.1, r.dte);
      if (asOfDays > r.dte) asOfDays = 0;
      renderAsofLabel(r.dte);
      renderLegs();
      renderStats();
      drawChart();
    } catch (e) {
      if (seq !== priceSeq) return;
      lastPriced = null;
      errEl.textContent = e.message;
      errEl.hidden = false;
      renderStats();
    }
  }

  function renderStats() {
    const row = document.getElementById('statsRow');
    if (!lastPriced) { row.innerHTML = `<div class="stat"><span class="l">Status</span><span class="v">pricing…</span></div>`; return; }
    const { entry, risk } = lastPriced;
    const cod = creditOrDebitFor();
    const u = unitsOf(legs, structure);
    row.innerHTML = `
      <div class="stat"><span class="l">${cod === 'credit' ? 'Net credit' : 'Net debit'}</span><span class="v ${cod === 'credit' ? 'good' : ''}">${fmtMoney(Math.abs(entry.mid * u * 100))}</span></div>
      <div class="stat"><span class="l">Max profit</span><span class="v good">${risk.max_profit == null ? 'Unlimited' : fmtMoney(risk.max_profit)}</span></div>
      <div class="stat"><span class="l">Max loss</span><span class="v bad">${risk.max_loss == null ? 'Undefined' : fmtMoney(Math.abs(risk.max_loss))}</span></div>
      <div class="stat"><span class="l">Breakeven${(risk.breakevens || []).length > 1 ? 's' : ''}</span><span class="v">${risk.breakevens ? risk.breakevens.map(b => b.toFixed(2)).join(' / ') : '—'}</span></div>
    `;
  }

  function renderAsofLabel(dte) {
    document.getElementById('asofLabel').innerHTML = `As of today + <b>${asOfDays.toFixed(1).replace(/\.0$/, '')}d</b> · <b>${Math.max(0, dte - asOfDays).toFixed(1).replace(/\.0$/, '')} DTE</b> remaining`;
  }

  // ── chart ──
  const canvas = document.getElementById('pnlchart');
  const ctx = canvas.getContext('2d');
  let plotCache = null;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function priceRange(spot) {
    const lo = Math.max(1, spot - spot * 0.06), hi = spot + spot * 0.06, n = 169;
    return Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
  }

  function entryCashPerShare() {
    const cod = creditOrDebitFor();
    const mid = lastPriced.entry.mid;
    return cod === 'debit' ? -Math.abs(mid) : Math.abs(mid);
  }

  function expirationCurve(prices, u) {
    const entry = entryCashPerShare();
    return prices.map(S => (payoffAtExpiry(legs, S, u) + entry) * 100 * u);
  }

  function t0Curve(prices, u, Tremaining) {
    const entry = entryCashPerShare();
    const quoteByLeg = lastPriced.legs;
    return prices.map(S => {
      let theo = 0;
      legs.forEach((l, i) => {
        const q = quoteByLeg[i];
        const sigma = q && q.iv > 0 ? q.iv : 0.18;
        const price = bsPrice(l.type, S, l.strike, Tremaining, sigma);
        const w = u ? l.qty / u : 1;
        theo += (l.action === 'buy' ? price : -price) * w;
      });
      return (theo + entry) * 100 * u;
    });
  }

  function findBreakevens(prices, curve) {
    const be = [];
    for (let i = 1; i < prices.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
        const t = a === b ? 0 : (0 - a) / (b - a);
        be.push(prices[i - 1] + (prices[i] - prices[i - 1]) * t);
      }
    }
    return be;
  }

  function drawChart() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h || !lastPriced) { ctx.clearRect(0, 0, w, h); plotCache = null; return; }
    ctx.clearRect(0, 0, w, h);

    const u = unitsOf(legs, structure);
    const spot = lastPriced.underlying;
    const prices = priceRange(spot);
    const exp = expirationCurve(prices, u);
    const dte = lastPriced.dte;
    const Tremaining = Math.max(0, (dte - asOfDays) / 365);
    const t0 = t0Curve(prices, u, Tremaining);
    const be = findBreakevens(prices, exp);

    const padL = 60, padR = 14, padT = 14, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const allY = exp.concat(t0);
    let yMin = Math.min(...allY), yMax = Math.max(...allY);
    const pad = (yMax - yMin) * 0.12 || 100;
    yMin -= pad; yMax += pad;
    const xMin = prices[0], xMax = prices[prices.length - 1];
    const xToPx = S => padL + (S - xMin) / (xMax - xMin) * plotW;
    const yToPx = v => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
    plotCache = { prices, exp, t0, xToPx, padL, plotW, xMin, xMax };

    ctx.strokeStyle = '#1D1F23'; ctx.lineWidth = 1; ctx.font = '11px JetBrains Mono, monospace';
    for (let i = 0; i <= 5; i++) {
      const v = yMin + (yMax - yMin) * i / 5, py = yToPx(v);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.fillStyle = '#8E8B84'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtMoney(v), padL - 8, py);
    }
    for (let i = 0; i <= 6; i++) {
      const S = xMin + (xMax - xMin) * i / 6, px = xToPx(S);
      ctx.fillStyle = '#8E8B84'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(S.toFixed(0), px, h - padB + 8);
    }
    ctx.strokeStyle = '#3A3C42'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, yToPx(0)); ctx.lineTo(w - padR, yToPx(0)); ctx.stroke();

    ctx.strokeStyle = '#4A4C52'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xToPx(spot), padT); ctx.lineTo(xToPx(spot), padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#A19E96'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('spot', xToPx(spot), padT + 11);

    function drawLine(curve, color, dashed) {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      prices.forEach((S, i) => { const px = xToPx(S), py = yToPx(curve[i]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    drawLine(t0, '#5AA9FF', true);
    drawLine(exp, '#E9B949', false);

    be.forEach(S => { const px = xToPx(S), py = yToPx(0); ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#E9B949'; ctx.fill(); });
  }

  const tooltip = document.getElementById('tooltip');
  canvas.addEventListener('mousemove', e => {
    if (!plotCache) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const { prices, exp, t0, xToPx, padL, plotW, xMin, xMax } = plotCache;
    if (mx < padL || mx > padL + plotW) { tooltip.style.opacity = 0; return; }
    const frac = (mx - padL) / plotW, S = xMin + (xMax - xMin) * frac;
    let idx = 0, best = Infinity;
    prices.forEach((p, i) => { const d = Math.abs(p - S); if (d < best) { best = d; idx = i; } });
    tooltip.innerHTML = `
      <div class="tp">Underlying @ ${prices[idx].toFixed(2)}</div>
      <div class="row exp"><span>At expiration</span><span class="vv">${fmtMoney(exp[idx], true)}</span></div>
      <div class="row t0"><span>T+0 today</span><span class="vv">${fmtMoney(t0[idx], true)}</span></div>
    `;
    const px = xToPx(prices[idx]);
    tooltip.style.left = Math.min(canvas.clientWidth - 150, Math.max(4, px + 12)) + 'px';
    tooltip.style.top = '10px';
    tooltip.style.opacity = 1;
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
  window.addEventListener('resize', () => { if (canvas.clientWidth) resizeCanvas(); });

  document.getElementById('asofSlider').oninput = e => {
    asOfDays = Number(e.target.value);
    if (lastPriced) renderAsofLabel(lastPriced.dte);
    drawChart();
  };

  // ── toast ──
  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.toggle('error', !!isError); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ── destination + submit ──
  function renderDestination() {
    document.getElementById('destSwitch').classList.toggle('on', destination === 'broker');
    document.getElementById('lblIdeas').classList.toggle('active', destination === 'ideas');
    document.getElementById('lblBroker').classList.toggle('active', destination === 'broker');
    document.getElementById('btnSubmit').textContent = destination === 'ideas' ? 'Add to Trade Ideas' : 'Review & send to broker';
  }
  document.getElementById('destSwitch').onclick = () => { destination = destination === 'ideas' ? 'broker' : 'ideas'; document.getElementById('confirmPanel').hidden = true; renderDestination(); };
  document.getElementById('lblIdeas').onclick = () => { destination = 'ideas'; document.getElementById('confirmPanel').hidden = true; renderDestination(); };
  document.getElementById('lblBroker').onclick = () => { destination = 'broker'; renderDestination(); };

  function structSummary() { return legs.map(l => `${l.action === 'sell' ? '−' : '+'}${l.qty}x${l.strike}${l.type[0].toUpperCase()}`).join('  '); }

  function buildSubmitBody(dest, confirm) {
    const limit = roundToTick(symbol, Math.abs(lastPriced.entry.mid));
    return {
      symbol, structure, expiry: frontExpiry, credit_or_debit: creditOrDebitFor(),
      legs: legs.map(l => ({ action: l.action, type: l.type, strike: l.strike, expiry: l.expiry, qty: l.qty })),
      limit_price: limit, quantity: unitsOf(legs, structure), thesis: document.getElementById('thesisIn').value, destination: dest, confirm: !!confirm,
    };
  }

  async function doSubmit(dest, confirm) {
    if (!lastPriced) return toast('Still pricing — try again in a second.', true);
    try {
      const body = buildSubmitBody(dest, confirm);
      const r = await api('POST', '/build/submit', body);
      if (dest === 'ideas') {
        toast('Added to Trade Ideas — review it on the Execute tab.');
      } else {
        document.getElementById('confirmPanel').hidden = true;
        pendingRepriceConfirm = false;
        toast(`Sent to broker — order ${r.order.status}.`);
      }
      document.getElementById('thesisIn').value = '';
    } catch (e) {
      if (e.status === 409 && e.data?.error?.code === 'reprice_required') {
        const extra = e.data;
        const note = document.getElementById('cfRepriceNote');
        note.hidden = false;
        note.textContent = `Price moved to ${extra.live_mid?.toFixed(2)} (${extra.move_pct}% away from ${extra.limit_price?.toFixed(2)}). Click Confirm again to send at the new price.`;
        pendingRepriceConfirm = true;
        return;
      }
      if (e.status === 422) {
        const details = (e.data?.error?.details || []).map(d => d.issue).join('; ');
        toast(details || e.message, true);
        return;
      }
      toast(e.message, true);
    }
  }

  document.getElementById('btnSubmit').onclick = () => {
    if (destination === 'ideas') return doSubmit('ideas', false);
    if (!lastPriced) return toast('Still pricing — try again in a second.', true);
    document.getElementById('cfStruct').textContent = structSummary();
    document.getElementById('cfPrice').textContent = fmtMoney(Math.abs(lastPriced.entry.mid) * 100, false).replace('$', (creditOrDebitFor() === 'credit' ? '+$' : '−$'));
    document.getElementById('cfQty').textContent = legs.map(l => l.qty).join(' / ');
    document.getElementById('cfMaxLoss').textContent = lastPriced.risk.max_loss == null ? 'Undefined' : fmtMoney(Math.abs(lastPriced.risk.max_loss));
    document.getElementById('cfRepriceNote').hidden = true;
    pendingRepriceConfirm = false;
    document.getElementById('confirmPanel').hidden = false;
    document.getElementById('confirmPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  document.getElementById('btnConfirmCancel').onclick = () => { document.getElementById('confirmPanel').hidden = true; };
  document.getElementById('btnConfirmSend').onclick = () => doSubmit('broker', pendingRepriceConfirm);

  // ── templates & drafts ──
  async function loadSaved() {
    try {
      const [templates, drafts] = await Promise.all([api('GET', '/build/templates'), api('GET', '/build/drafts')]);
      renderTemplates(templates); renderDrafts(drafts);
    } catch { /* non-fatal — the builder still works without the saved lists */ }
  }

  function renderTemplates(list) {
    const el = document.getElementById('templatesList');
    document.getElementById('templatesEmpty').hidden = list.length > 0;
    el.innerHTML = (list.length ? '' : '<p class="empty" id="templatesEmpty">No templates saved yet.</p>') + list.map(t => `
      <div class="saved-row" data-id="${t.id}">
        <span class="name">${esc(t.name)}</span>
        <span class="meta">${t.symbol} · ${STRUCTURE_LABELS[t.structure] || t.structure}</span>
        <span class="spacer"></span>
        <button type="button" class="btn small load">Load</button>
        <button type="button" class="btn small ghost del">Delete</button>
      </div>`).join('');
    el.querySelectorAll('.saved-row').forEach(row => {
      const t = list.find(x => x.id === row.dataset.id);
      row.querySelector('.load').onclick = () => loadTemplate(t);
      row.querySelector('.del').onclick = async () => { await api('DELETE', `/build/templates/${t.id}`); loadSaved(); };
    });
  }

  function renderDrafts(list) {
    const el = document.getElementById('draftsList');
    document.getElementById('draftsEmpty').hidden = list.length > 0;
    el.innerHTML = (list.length ? '' : '<p class="empty" id="draftsEmpty">No drafts saved yet.</p>') + list.map(d => `
      <div class="saved-row" data-id="${d.id}">
        <span class="name">${esc(d.name || d.symbol)}</span>
        <span class="meta">${d.symbol} · ${STRUCTURE_LABELS[d.structure] || d.structure} · ${d.expiry}</span>
        <span class="spacer"></span>
        <button type="button" class="btn small load">Load</button>
        <button type="button" class="btn small ghost del">Delete</button>
      </div>`).join('');
    el.querySelectorAll('.saved-row').forEach(row => {
      const d = list.find(x => x.id === row.dataset.id);
      row.querySelector('.load').onclick = () => loadDraft(d);
      row.querySelector('.del').onclick = async () => { await api('DELETE', `/build/drafts/${d.id}`); loadSaved(); };
    });
  }

  async function loadTemplate(t) {
    symbol = t.symbol; document.getElementById('symIn').value = symbol;
    await loadExpirations();
    structure = t.structure; document.getElementById('tplSel').value = structure;
    codOverride = t.credit_or_debit || 'credit'; document.getElementById('codSel').value = codOverride;
    updateCodField();
    const front = await getChain(frontExpiry);
    legs = t.legs.map(l => ({ action: l.action, type: l.type, expiry: frontExpiry, strike: nearestStrike(front, l.type, front.underlying + l.strike_offset), qty: l.qty ?? 1 }));
    renderLegs(); schedulePrice();
    toast(`Loaded template "${t.name}" — strikes re-picked from today's chain.`);
  }

  async function loadDraft(d) {
    symbol = d.symbol; document.getElementById('symIn').value = symbol;
    await loadExpirations();
    if (expirationsList.includes(d.expiry)) frontExpiry = d.expiry;
    structure = d.structure; document.getElementById('tplSel').value = structure;
    codOverride = d.credit_or_debit; document.getElementById('codSel').value = codOverride;
    updateCodField();
    legs = d.legs.map(l => ({ action: l.action, type: l.type, strike: l.strike, expiry: l.expiry, qty: l.qty ?? d.quantity ?? 1 }));
    // Fetch every distinct expiry this draft's legs actually use (not just
    // the front one) so their strike dropdowns populate immediately, rather
    // than showing only the single stored strike until each one is touched.
    // A leg whose expiry has since passed won't have a chain to fetch —
    // getChain() rejects, which is expected; that leg's expiry is flagged
    // "(expired)" in the dropdown and pricing will report it can't be found.
    const expired = [];
    await Promise.all([...new Set(legs.map(l => l.expiry))].map(exp =>
      getChain(exp).catch(() => { expired.push(exp); })));
    document.getElementById('thesisIn').value = d.thesis || '';
    renderLegs(); schedulePrice();
    toast(expired.length
      ? `Loaded draft "${d.name || d.symbol}" — ${expired.join(', ')} has already passed; pick a new expiry for those legs.`
      : `Loaded draft "${d.name || d.symbol}".`, expired.length > 0);
  }

  document.getElementById('btnSaveTemplate').onclick = async () => {
    if (!lastPriced) return toast('Price the structure first.', true);
    const name = prompt('Name this template:', `${symbol} ${STRUCTURE_LABELS[structure]}`);
    if (!name) return;
    try {
      await api('POST', '/build/templates', { name, symbol, structure, credit_or_debit: creditOrDebitFor(), underlying: lastPriced.underlying, legs });
      toast('Template saved.'); loadSaved();
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('btnSaveDraft').onclick = async () => {
    if (!lastPriced) return toast('Price the structure first.', true);
    const name = prompt('Name this draft (optional):', '');
    try {
      await api('POST', '/build/drafts', {
        name, symbol, structure, expiry: frontExpiry, credit_or_debit: creditOrDebitFor(),
        legs, limit_price: roundToTick(symbol, Math.abs(lastPriced.entry.mid)), quantity: unitsOf(legs, structure), thesis: document.getElementById('thesisIn').value,
      });
      toast('Draft saved — find it under Saved below.'); loadSaved();
    } catch (e) { toast(e.message, true); }
  };

  // ── top controls: symbol / structure (expiry now lives per-leg, in the Legs table) ──
  async function loadExpirations() {
    const r = await api('GET', `/expirations/${encodeURIComponent(symbol)}`);
    expirationsList = r.expirations || [];
    frontExpiry = expirationsList[0] || null;
    chainCache.clear();
  }

  async function onStructureChange(initial) {
    structure = document.getElementById('tplSel').value;
    updateCodField();
    if (!initial) legs = await defaultLegsFor(structure);
    renderLegs();
    schedulePrice();
  }

  document.getElementById('symIn').addEventListener('change', async e => {
    const v = e.target.value.trim().toUpperCase();
    if (!v) { e.target.value = symbol; return; }
    symbol = v; localStorage.setItem('build.symbol', symbol);
    await loadExpirations();
    legs = await defaultLegsFor(structure);
    renderLegs(); schedulePrice();
  });
  document.getElementById('tplSel').addEventListener('change', () => onStructureChange(false));
  document.getElementById('codSel').addEventListener('change', e => { codOverride = e.target.value; renderStats(); schedulePrice(); });

  // ── boot ──
  (async () => {
    if (window.Analyze && Analyze.initHeader) Analyze.initHeader();
    document.getElementById('symIn').value = symbol;
    try {
      await loadExpirations();
      legs = await defaultLegsFor(structure);
      renderLegs();
      resizeCanvas();
      await fetchPrice();
    } catch (e) {
      document.getElementById('loadErr').textContent = e.message;
      document.getElementById('loadErr').hidden = false;
    }
    loadSaved();
  })();
})();
