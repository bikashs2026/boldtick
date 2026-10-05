// Paper Desk website — vanilla JS, talks to /paper/api (same handlers as Muse's /api/paper)
(() => {
  'use strict';
  const API = '/paper/api';
  const S = { tab: 'dashboard', status: null, settings: null, meta: null, cursor: null, ideaFilter: '', orderFilter: '', reprice: {}, pending: new Set() };
  const $ = sel => document.querySelector(sel);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v, signed = false) => v == null || Number.isNaN(v) ? '—' : `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const px = v => v == null ? '—' : Number(v).toFixed(2);
  const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const time = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const label = s => String(s || '').replace(/_/g, ' ');

  // ── client-side tick rounding, mirrors src/paper/pricing.js roundToTick ──
  // A structure's live "Value/natural" (mark()'s raw net of each leg's own
  // mid/bid/ask) is a sum of several independently-quoted legs, so it almost
  // never lands on an exchange-valid tick even though every leg it's built
  // from does — SPX/SPXW/XSP trade in $0.05 increments under $3 and $0.10
  // at/above, everything else in $0.01. Showing that raw figure (e.g.
  // "1.37" for SPX) is misleading since no order can actually be placed at
  // it; the server already rounds whatever price an order is submitted at
  // (desk.js's closeRequest), so rounding it here too just makes the
  // display match what a Close actually does, and gives the Limit input a
  // sane, already-valid starting point instead of an uneditable-looking one.
  function roundToTick(symbol, price) {
    const s = String(symbol).toUpperCase().replace(/^\$/, '');
    const tick = (s === 'SPX' || s === 'SPXW' || s === 'XSP') ? (Math.abs(price) >= 3 ? 0.10 : 0.05) : 0.01;
    const steps = Math.round(Number((price / tick).toFixed(6)));
    return Math.max(tick, Math.round(steps * tick * 100) / 100);
  }

  // ── API ──
  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'paper-desk' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) { const e = new Error(data?.error?.message || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, err ? 9000 : 4000);
  }
  function errText(e) {
    const d = e.data?.error?.details;
    const name = f => S.meta?.fields?.find(x => x.key === f)?.label || f;
    return e.message + (Array.isArray(d) && d.length ? '\n• ' + d.map(x => x.field ? `${name(x.field)}: ${x.issue}` : x.issue).join('\n• ') : '');
  }

  // ── Tabs ──
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  function show(tab) {
    S.tab = tab;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('[data-view]').forEach(v => { v.hidden = v.dataset.view !== tab; });
    refresh(tab);
  }
  function refresh(tab = S.tab) {
    const fn = { dashboard: loadDashboard, ideas: loadIdeas, orders: loadOrders, feed: loadFeed, closed: loadClosed, settings: loadSettings }[tab];
    if (fn) fn().catch(e => toast(errText(e), true));
  }

  // ── Status bar ──
  async function loadStatus() {
    const s = await api('GET', '/status');
    S.status = s;
    $('#appVersion').textContent = s.version ? `v${s.version}` : '';
    $('#pillBroker').textContent = `fills: live ${s.fill_model}`;
    $('#pillBroker').title = 'Scorecard fills orders when the live market reaches the limit';
    const m = s.mirror || {};
    const mp = $('#pillMirror');
    mp.textContent = m.name ? `paper acct ${m.account || ''}${m.ok === false ? ' · error' : ''}` : 'paper acct: off';
    mp.className = 'pill ' + (m.name ? (m.ok === false ? 'err' : 'ok') : '');
    mp.title = m.error || (m.name ? 'Orders are mirrored to the tastytrade paper account' : 'Add TT_PAPER_* to .env to mirror orders to the tastytrade paper account');
    $('#pillData').textContent = `data: ${s.market_data} live`;
    $('#pillClock').textContent = `${s.clock.et} ET${s.clock.simulated ? ' · sim' : ''}${s.clock.market_open ? '' : ' · closed'}`;
    const sync = $('#pillSync');
    sync.textContent = s.last_sync_error ? 'sync error' : s.last_sync ? `sync ${time(s.last_sync).split(', ')[1]}` : 'sync …';
    sync.className = 'pill ' + (s.last_sync_error ? 'err' : s.last_sync ? 'ok' : '');
    sync.title = s.last_sync_error || 'Last order sync';
    const k = $('#btnKill');
    k.setAttribute('aria-pressed', String(!!s.kill_switch.on));
    k.textContent = s.kill_switch.on ? 'Kill switch: ON' : 'Kill switch: off';
    const kb = $('#killBanner');
    kb.hidden = !s.kill_switch.on;
    kb.textContent = s.kill_switch.on ? `Kill switch is on — no new orders${s.kill_switch.reason ? ` (${s.kill_switch.reason})` : ''}${s.kill_switch.forced_by_env ? ' · set by PAPER_KILL=1' : ''}. Closes and cancels still work.` : '';
    const c = $('#ideaCount');
    c.hidden = !s.counts.pending_ideas;
    c.textContent = s.counts.pending_ideas;
    return s;
  }

  $('#btnSync').addEventListener('click', async () => {
    try { await api('POST', '/sync'); await api('POST', '/engine/run'); await loadStatus(); refresh(); toast('Synced with the paper account.'); }
    catch (e) { toast(errText(e), true); }
  });
  $('#btnKill').addEventListener('click', async () => {
    const on = !(S.status && S.status.kill_switch.on);
    if (on && !confirm('Turn the kill switch ON? New orders are blocked; closes still work.')) return;
    try { await api('POST', '/kill-switch', { on, reason: on ? 'manual' : null }); await loadStatus(); }
    catch (e) { toast(errText(e), true); }
  });

  // ── Dashboard ──
  async function loadDashboard() {
    const [s, positions] = await Promise.all([loadStatus(), api('GET', '/positions')]);
    $('#kpis').innerHTML = [
      ['Open positions', s.counts.open_positions],
      ['Open risk', money(s.open_risk)],
      ['Unrealized P&L', `<span class="${cls(s.unrealized_pnl)}">${money(s.unrealized_pnl, true)}</span>`],
      ['Realized today', `<span class="${cls(s.realized_today)}">${money(s.realized_today, true)}</span>`],
      ['Trades today', s.trades_today],
      ['Paper acct net liq', s.mirror?.balance ? money(s.mirror.balance.netLiq) : '—'],
    ].map(([k, v]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    const t = $('#posTable');
    $('#posEmpty').hidden = positions.length > 0;
    t.hidden = !positions.length;
    $('#posUpdated').textContent = positions[0]?.mark?.at ? `marked ${time(positions[0].mark.at)} ET` : '';
    const crossAfter = S.settings?.values?.['exit.cross_after_min'] ?? 2;
    t.innerHTML = `<thead><tr><th>Symbol</th><th>Structure</th><th>Legs</th><th class="num">Entry</th><th class="num">Value / natural</th><th class="num">P&amp;L</th><th class="num">% max</th><th class="num">DTE</th><th>Action</th><th>Close</th></tr></thead><tbody>${positions.map(p => {
      const m = p.mark || {};
      const urgent = ['STOP', 'CLOSE_EXPIRY'].includes(p.badge.action);
      const flags = [
        p.earnings_warning ? `<span class="flag warn">earnings ${esc(p.earnings_date)}</span>` : '',
        p.reconcile ? `<span class="flag err" title="${esc(JSON.stringify(p.reconcile.legs))}">broker mismatch</span>` : '',
        m.stale ? `<span class="flag warn" title="${esc(m.error || '')}">stale quotes</span>` : '',
        p.status === 'closing' ? '<span class="flag warn">closing…</span>' : '',
      ].join('');
      const closingOrder = p.status === 'closing';
      const crossOk = closingOrder && p.close_requested_at && (Date.now() - Date.parse(p.close_requested_at)) / 60000 >= crossAfter;
      return `<tr class="${urgent ? 'urgent' : ''}">
        <td class="mono">${esc(p.symbol)}<div class="muted">${esc(p.units)}×</div></td>
        <td>${esc(label(p.structure))}<div>${flags}</div></td>
        <td class="legs">${legsHtml(p.legs)}</td>
        <td class="num">${px(p.entry_price)}<div class="muted">${p.credit_or_debit}</div></td>
        <td class="num" title="${m.value != null ? `exact: ${px(m.value)} / ${px(m.natural)}` : ''}">${m.value != null ? px(roundToTick(p.symbol, m.value)) : '—'} / ${m.natural != null ? px(roundToTick(p.symbol, m.natural)) : '—'}<div class="muted">${m.underlying ? 'und ' + px(m.underlying) : ''}</div></td>
        <td class="num ${cls(m.pnl)}">${money(m.pnl, true)}<div class="muted">max ${money(p.max_profit)} / −${money(p.max_loss)}</div></td>
        <td class="num">${m.pct_max == null ? '—' : m.pct_max.toFixed(0) + '%'}</td>
        <td class="num">${p.dte ?? '—'}</td>
        <td><span class="badge ${esc(p.badge.action)}">${esc(p.badge.action)}</span><span class="src">${esc(p.badge.source)}</span><div class="reason">${esc(p.badge.reason)}</div>
          ${p.badge.source === 'muse' && p.system_signal ? `<div class="reason">system: ${esc(p.system_signal.action)} — ${esc(p.system_signal.reason)}</div>` : ''}</td>
        <td><div class="row-actions">
          ${closingOrder
            ? `<button type="button" class="btn small danger" data-close="${p.id}" data-mode="natural"${crossOk ? '' : ' title="Re-price the working close at the natural price"'}>Cross to natural</button><button type="button" class="btn small" data-cancel-close="${esc(p.close_order_id)}">Cancel close</button>`
            : (() => {
                const s = String(p.symbol).toUpperCase().replace(/^\$/, '');
                const step = (s === 'SPX' || s === 'SPXW' || s === 'XSP') ? (Math.abs(m.natural ?? m.value ?? 0) >= 3 ? '0.10' : '0.05') : '0.01';
                const start = m.natural != null ? roundToTick(p.symbol, m.natural) : '';
                return `<button type="button" class="btn small" data-close="${p.id}" data-mode="mid">Close at mid</button><button type="button" class="btn small" data-close="${p.id}" data-mode="natural">Natural</button>
               <input class="num" type="number" step="${step}" min="${step}" placeholder="limit" aria-label="Close limit price" value="${start}" data-limit-for="${p.id}"><button type="button" class="btn small" data-close="${p.id}" data-mode="limit">Limit</button>`;
              })()}
        </div></td></tr>`;
    }).join('')}</tbody>`;
  }

  function legsHtml(legs) {
    return legs.map(l => `<div><span class="${l.action === 'sell' ? 's' : 'b'}">${l.action === 'sell' ? 'S' : 'B'}</span> ${esc(l.type[0].toUpperCase())} ${esc(l.strike)} <span class="muted">${esc(l.expiry.slice(5))}</span></div>`).join('');
  }

  document.addEventListener('click', async ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.close) {
      const id = b.dataset.close, mode = b.dataset.mode;
      const body = { price_mode: mode };
      if (mode === 'limit') {
        const v = Number(document.querySelector(`[data-limit-for="${id}"]`)?.value);
        if (!(v > 0)) return toast('Enter a limit price first.', true);
        body.limit_price = v;
      }
      if (!confirm(`Send a closing order (${mode}) to the paper account?`)) return;
      await busy(b, async () => {
        const r = await api('POST', `/positions/${id}/close-request`, body);
        toast(`Close order ${r.order.status} at ${px(r.order.limit_price)} (${r.order.price_effect}).`);
        await loadDashboard();
      });
    } else if (b.dataset.cancelClose || b.dataset.cancelOrder) {
      const id = b.dataset.cancelClose || b.dataset.cancelOrder;
      if (!confirm('Cancel this working order?')) return;
      await busy(b, async () => { await api('POST', `/orders/${id}/cancel`); toast('Order cancelled.'); refresh(); });
    } else if (b.dataset.approve) {
      await approve(b, b.dataset.approve, {});
    } else if (b.dataset.approveAt) {
      await approve(b, b.dataset.approveAt, { limit_price: Number(b.dataset.price), confirm: true });
    } else if (b.dataset.reject) {
      const reason = prompt('Reason for rejecting (optional):', '');
      if (reason === null) return;
      await busy(b, async () => { await api('POST', `/trade-ideas/${b.dataset.reject}/reject`, { reason }); toast('Idea rejected.'); loadIdeas(); loadStatus(); });
    } else if (b.dataset.dismissReprice) {
      delete S.reprice[b.dataset.dismissReprice];
      loadIdeas();
    }
  });

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(errText(e), true); } finally { btn.disabled = false; }
  }

  // ── Ideas ──
  $('#ideaFilter').addEventListener('change', e => { S.ideaFilter = e.target.value; loadIdeas(); });
  async function loadIdeas() {
    const ideas = await api('GET', '/trade-ideas' + (S.ideaFilter ? `?status=${S.ideaFilter}` : ''));
    $('#ideaEmpty').hidden = ideas.length > 0;
    $('#ideaList').innerHTML = ideas.map(ideaCard).join('');
  }

  function ideaCard(i) {
    const c = i.validation?.computed || {};
    const credit = i.credit_or_debit === 'credit';
    const left = Date.parse(i.expires_at) - Date.parse(S.status?.clock?.now || new Date().toISOString());
    const expiresIn = i.status === 'pending' ? (left > 0 ? `expires in ${Math.ceil(left / 60000)} min` : 'expired') : '';
    const rp = S.reprice[i.id];
    const facts = [
      ['Limit', `${px(i.limit_price)} ${credit ? 'cr' : 'db'}`],
      ['Live mid / natural', c.priced ? `${px(c.live_mid)} / ${px(c.live_natural)}` : 'unpriced'],
      ['Underlying', px(c.underlying)],
      ['Max profit', c.max_profit != null ? money(c.max_profit) : (c.priced ? 'open-ended' : '—')],
      ['Max loss', c.max_loss != null ? money(c.max_loss)
        : c.assignment_risk ? `assignment ${money(c.assignment_risk)}`
        : (c.priced && /^covered_/.test(i.structure || '')) ? 'stock risk' : '—'],
      ['Breakevens', c.breakevens ? c.breakevens.map(px).join(' / ') : '—'],
      ['Short Δ', c.short_deltas ? Object.entries(c.short_deltas).map(([k, v]) => `${k[0].toUpperCase()} ${Number(v).toFixed(2)}`).join(' ') : '—'],
      ["Muse's max loss", i.muse_max_loss == null ? '—' : money(i.muse_max_loss)],
      ['Take profit / stop', `${i.suggested_take_profit == null ? 'default' : px(i.suggested_take_profit)} / ${i.suggested_stop == null ? 'default' : px(i.suggested_stop)}`],
    ];
    return `<article class="card ${i.status}">
      <div class="card-head">
        <div><div class="t"><span class="sym">${esc(i.symbol)}</span> ${esc(label(i.structure))}</div>
          <div class="muted">${esc(i.expiry)}${c.zero_dte ? ' · 0DTE' : ''} · ${esc(i.client_idea_id)} · received ${time(i.received_at)} ET${expiresIn ? ' · ' + expiresIn : ''}</div></div>
        <span class="status-tag ${esc(i.status)}">${esc(i.status)}</span>
      </div>
      <div class="legs">${legsHtml(i.legs)}</div>
      <div class="facts">${facts.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>
      <p class="thesis">${esc(i.thesis)}</p>
      ${i.earnings_date ? `<span class="flag warn">earnings ${esc(i.earnings_date)}</span>` : ''}
      ${i.validation?.errors?.length ? `<ul class="issues err">${i.validation.errors.map(e => `<li>${esc(e.issue)}</li>`).join('')}</ul>` : ''}
      ${i.validation?.warnings?.length ? `<ul class="issues warn">${i.validation.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${i.status === 'pending' && !i.expired ? (rp ? `<div class="reprice">
          <div>${esc(rp.message)}</div>
          <div class="row-actions">
            <button type="button" class="btn small good" data-approve-at="${i.id}" data-price="${rp.live_mid}">Approve at mid ${px(rp.live_mid)}</button>
            <button type="button" class="btn small" data-approve-at="${i.id}" data-price="${rp.limit_price}">Approve at ${px(rp.limit_price)}</button>
            <button type="button" class="btn small" data-dismiss-reprice="${i.id}">Back</button>
          </div></div>` : `<div class="approve-row">
          <label>Quantity<input class="num" type="number" min="1" step="1" value="${esc(i.legs[0]?.qty || 1)}" data-qty-for="${i.id}"></label>
          <label>Limit<input class="num" type="number" min="0.01" step="0.05" value="${esc(i.limit_price)}" data-price-for="${i.id}"></label>
          <button type="button" class="btn good" data-approve="${i.id}">Approve</button>
          <button type="button" class="btn danger" data-reject="${i.id}">Reject</button>
        </div>`) : ''}
      ${i.status === 'approved' && i.order_id ? `<div class="muted">Order ${esc(i.order_id)} · approved ${time(i.approval?.at)} ET by ${esc(i.approval?.by)}</div>` : ''}
    </article>`;
  }

  async function approve(btn, id, extra) {
    const qty = Number(document.querySelector(`[data-qty-for="${id}"]`)?.value);
    const price = Number(document.querySelector(`[data-price-for="${id}"]`)?.value);
    const body = { ...extra };
    if (qty > 0 && body.quantity === undefined) body.quantity = qty;
    if (price > 0 && body.limit_price === undefined) body.limit_price = price;
    if (!extra.confirm && !confirm(`Approve and send this order to the paper account?\n${body.quantity}× at ${px(body.limit_price)}`)) return;
    btn.disabled = true;
    try {
      const r = await api('POST', `/trade-ideas/${id}/approve`, body);
      delete S.reprice[id];
      toast(r.order.status === 'rejected' ? `Order rejected: ${r.order.reject_reason}` : `Order ${r.order.status} at ${px(r.order.limit_price)}.`, r.order.status === 'rejected');
      await loadStatus();
      loadIdeas();
    } catch (e) {
      if (e.data?.error?.code === 'reprice_required') {
        S.reprice[id] = { message: e.data.error.message, live_mid: e.data.live_mid, limit_price: e.data.limit_price, quantity: body.quantity };
        loadIdeas();
      } else {
        toast(errText(e), true);
      }
    } finally { btn.disabled = false; }
  }

  // ── Orders ──
  $('#orderFilter').addEventListener('change', e => { S.orderFilter = e.target.value; loadOrders(); });
  async function loadOrders() {
    const orders = await api('GET', '/orders' + (S.orderFilter ? `?status=${S.orderFilter}` : ''));
    $('#orderTable').innerHTML = `<thead><tr><th>Created (ET)</th><th>Kind</th><th>Symbol</th><th>Legs</th><th class="num">Qty</th><th class="num">Limit</th><th class="num">Fill</th><th>Status</th><th>tastytrade paper acct</th><th></th></tr></thead><tbody>${orders.map(o => `<tr>
      <td class="mono">${time(o.created_at)}</td><td>${esc(o.kind)}</td><td class="mono">${esc(o.symbol)}<div class="muted">${esc(label(o.structure))}</div></td>
      <td class="legs">${legsHtml(o.legs)}</td><td class="num">${o.filled_quantity}/${o.units}</td>
      <td class="num">${px(o.limit_price)} <span class="muted">${esc(o.price_effect)}</span></td><td class="num">${px(o.avg_fill_price)}${o.fill_context ? `<div class="muted" title="Live prices when the scorecard filled">mid ${px(o.fill_context.mid)} · nat ${px(o.fill_context.natural)}</div>` : ''}</td>
      <td><span class="status-tag ${o.status === 'filled' ? 'approved' : o.status === 'rejected' ? 'rejected' : ''}">${esc(label(o.status))}</span>${o.reject_reason ? `<div class="reason">${esc(o.reject_reason)}</div>` : ''}</td>
      <td>${mirrorCell(o.mirror)}</td>
      <td>${['working', 'partially_filled', 'received'].includes(o.status) ? `<button type="button" class="btn small" data-cancel-order="${o.id}">Cancel</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="muted">No orders yet.</td></tr>'}</tbody>`;
  }

  function mirrorCell(m) {
    if (!m) return '<span class="muted">—</span>';
    const tag = m.status === 'filled' ? 'approved' : ['rejected', 'skipped'].includes(m.status) ? 'rejected' : '';
    return `<span class="status-tag ${tag}">${esc(label(m.status))}</span>${m.fill_price != null ? ` <span class="mono">${px(m.fill_price)}</span>` : ''}<div class="muted mono">${esc(m.broker_order_id || '')}</div>${m.error ? `<div class="reason">${esc(m.error)}</div>` : ''}`;
  }

  // ── Feed ──
  async function loadFeed() {
    const sigs = await api('GET', '/signals?limit=300');
    $('#feedList').innerHTML = sigs.map(s => `<div class="item ${s.source}">
      <span class="time">${time(s.at)}</span>
      <span><span class="badge ${esc(s.action)}">${esc(s.action)}</span><span class="src">${esc(s.source)}</span></span>
      <span>${esc(s.reason)}<div class="muted mono">${esc(s.position_id)}${s.pnl_dollars != null ? ' · P&L ' + money(s.pnl_dollars, true) : ''}${s.current_value != null ? ' · value ' + px(s.current_value) : ''}</div></span>
    </div>`).join('') || '<p class="empty">No signals yet.</p>';
  }

  // ── Closed ──
  async function loadClosed() {
    const list = await api('GET', '/positions?status=closed');
    const total = list.reduce((s, p) => s + (p.realized_pnl || 0), 0);
    const wins = list.filter(p => p.realized_pnl > 0).length;
    $('#closedKpis').innerHTML = [
      ['Closed trades', list.length],
      ['Realized P&L', `<span class="${cls(total)}">${money(total, true)}</span>`],
      ['Win rate', list.length ? `${Math.round(wins / list.length * 100)}%` : '—'],
      ['Average', list.length ? money(total / list.length, true) : '—'],
    ].map(([k, v]) => `<div class="kpi"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    $('#closedTable').innerHTML = `<thead><tr><th>Closed (ET)</th><th>Symbol</th><th>Structure</th><th>Legs</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">Realized</th><th>How</th></tr></thead><tbody>${list.map(p => `<tr>
      <td class="mono">${time(p.closed_at)}</td><td class="mono">${esc(p.symbol)}</td><td>${esc(label(p.structure))}</td><td class="legs">${legsHtml(p.legs)}</td>
      <td class="num">${p.units}</td><td class="num">${px(p.entry_price)} <span class="muted">${esc(p.credit_or_debit)}</span></td><td class="num">${px(p.exit_price)}</td>
      <td class="num ${cls(p.realized_pnl)}">${money(p.realized_pnl, true)}</td><td>${esc(p.close_reason)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No closed trades yet.</td></tr>'}</tbody>`;
  }

  // ── Settings ──
  async function loadSettings() {
    const s = await api('GET', '/settings?meta=1');
    S.settings = s; S.meta = s.meta; S.alerts = s.values;
    $('#settingsVersion').textContent = `version ${s.version}${s.updated_at ? ' · saved ' + time(s.updated_at) + ' ET' : ''}`;
    const form = $('#settingsForm');
    form.innerHTML = s.meta.groups.map(g => `<fieldset><legend>${esc(g.label)}</legend>${s.meta.fields.filter(f => f.group === g.id).map(f => fieldRow(f, s)).join('')}</fieldset>`).join('');
    form.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => el.closest('.setting')?.classList.add('changed')));
    const per = s.meta.fields.filter(f => f.perStructure);
    $('#perStructure').innerHTML = `<thead><tr><th>Structure</th>${per.map(f => `<th title="${esc(f.label)}">${esc(f.key.replace('exit.', '').replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${s.meta.structures.map(st => `<tr><td>${esc(label(st))}</td>${per.map(f => {
      const v = s.exit_per_structure?.[st]?.[f.key];
      return `<td><input class="num" data-ps="${st}" data-key="${f.key}" ${f.type === 'hm' ? 'placeholder="HH:MM"' : 'type="number" step="any"'} value="${esc(v ?? '')}" aria-label="${esc(label(st))} ${esc(f.label)}"></td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
    const hist = await api('GET', '/settings/history');
    $('#settingsHistory').innerHTML = hist.map(h => `<div class="item"><span class="time">${time(h.at)}</span><span class="muted">v${h.version} · ${esc(h.by)}</span><span>${h.changes.map(c => `${esc(c.key)}: ${esc(JSON.stringify(c.old))} → ${esc(JSON.stringify(c.new))}`).join('<br>')}</span></div>`).join('') || '<p class="empty">No changes yet.</p>';
  }

  function fieldRow(f, s) {
    const v = s.values[f.key];
    let ctrl = '';
    const id = 'f_' + f.key.replace(/\W/g, '_');
    switch (f.type) {
      case 'number': case 'int':
        ctrl = `<input id="${id}" class="num" type="number" step="${f.type === 'int' ? 1 : 'any'}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} data-key="${f.key}" value="${esc(v)}">`; break;
      case 'bool':
        ctrl = `<select id="${id}" data-key="${f.key}" data-type="bool"><option value="true"${v ? ' selected' : ''}>On</option><option value="false"${!v ? ' selected' : ''}>Off</option></select>`; break;
      case 'hm':
        ctrl = `<input id="${id}" class="num hm" data-key="${f.key}" value="${esc(v)}" placeholder="HH:MM">`; break;
      case 'hm_range': case 'range':
        ctrl = `<input id="${id}" class="num hm" data-key="${f.key}" data-part="0" value="${esc(v[0])}" aria-label="${esc(f.label)} from"><input class="num hm" data-key="${f.key}" data-part="1" value="${esc(v[1])}" aria-label="${esc(f.label)} to">`; break;
      case 'list':
        ctrl = `<input id="${id}" class="list" data-key="${f.key}" value="${esc(v.join(', '))}" placeholder="SPX, AMD">`; break;
      case 'structures':
        ctrl = `<div class="checks">${s.meta.structures.map(st => `<label><input type="checkbox" data-key="${f.key}" data-struct="${st}"${v.includes(st) ? ' checked' : ''}>${esc(label(st))}</label>`).join('')}</div>`; break;
      case 'enum':
        ctrl = `<select id="${id}" data-key="${f.key}">${f.options.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`; break;
      case 'none':
        ctrl = '<span class="muted">mode only</span>'; break;
    }
    const mode = f.mode ? `<select data-mode="${f.key}" aria-label="${esc(f.label)} mode">${s.meta.modes.map(m => `<option${s.modes[f.key] === m ? ' selected' : ''}>${m}</option>`).join('')}</select>` : '';
    return `<div class="setting" data-row="${f.key}"><label class="lbl" for="${id}">${esc(f.label)}${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ''}</label><div class="ctrl">${ctrl}</div><div>${mode}</div></div>`;
  }

  function collectSettings() {
    const s = S.settings, values = {}, modes = {}, per = {};
    for (const f of S.meta.fields) {
      let v;
      const els = [...document.querySelectorAll(`#settingsForm [data-key="${f.key}"]`)];
      if (!els.length) continue;
      if (f.type === 'number' || f.type === 'int') v = els[0].value === '' ? null : Number(els[0].value);
      else if (f.type === 'bool') v = els[0].value === 'true';
      else if (f.type === 'hm' || f.type === 'enum') v = els[0].value.trim();
      else if (f.type === 'hm_range') v = els.map(e => e.value.trim());
      else if (f.type === 'range') v = els.map(e => Number(e.value));
      else if (f.type === 'list') v = els[0].value.split(',').map(x => x.trim()).filter(Boolean);
      else if (f.type === 'structures') v = els.filter(e => e.checked).map(e => e.dataset.struct);
      else continue;
      if (JSON.stringify(v) !== JSON.stringify(s.values[f.key])) values[f.key] = v;
    }
    document.querySelectorAll('#settingsForm [data-mode]').forEach(el => { if (s.modes[el.dataset.mode] !== el.value) modes[el.dataset.mode] = el.value; });
    document.querySelectorAll('#perStructure [data-ps]').forEach(el => {
      const st = el.dataset.ps, key = el.dataset.key, cur = s.exit_per_structure?.[st]?.[key];
      const raw = el.value.trim();
      const f = S.meta.fields.find(x => x.key === key);
      const v = raw === '' ? null : (f.type === 'hm' ? raw : Number(raw));
      if ((cur ?? null) !== v) { per[st] = per[st] || {}; per[st][key] = v; }
    });
    return { version: s.version, values, modes, exit_per_structure: per };
  }

  $('#btnSaveSettings').addEventListener('click', async e => {
    const patch = collectSettings();
    if (!Object.keys(patch.values).length && !Object.keys(patch.modes).length && !Object.keys(patch.exit_per_structure).length) return toast('Nothing changed.');
    document.querySelectorAll('.setting .err').forEach(x => x.remove());
    await busy(e.target, async () => {
      try {
        const r = await api('PUT', '/settings', patch);
        toast(`Saved ${r.changes.length} change${r.changes.length === 1 ? '' : 's'} (version ${r.version}).`);
        await loadSettings();
      } catch (err) {
        for (const d of err.data?.error?.details || []) {
          const row = [...document.querySelectorAll('.setting[data-row]')].find(x => x.dataset.row === d.field);
          if (row) row.insertAdjacentHTML('beforeend', `<div class="err">${esc(d.issue)}</div>`);
        }
        throw err;
      }
    });
  });
  $('#btnResetSettings').addEventListener('click', async e => {
    if (!confirm('Reset every setting to its default?')) return;
    await busy(e.target, async () => { await api('POST', '/settings/reset'); toast('Settings reset to defaults.'); await loadSettings(); });
  });
  $('#btnApplyOpen').addEventListener('click', async e => {
    if (!confirm("Apply the current exit rules to every open position? Muse's take-profit and stop prices are kept.")) return;
    await busy(e.target, async () => { const r = await api('POST', '/positions/apply-settings'); toast(`Updated ${r.updated} open position${r.updated === 1 ? '' : 's'}.`); });
  });

  // ── Alerts ──
  const canNotify = 'Notification' in window;
  if (canNotify && Notification.permission === 'default') $('#btnNotify').hidden = false;
  $('#btnNotify').addEventListener('click', async () => {
    await Notification.requestPermission();
    $('#btnNotify').hidden = Notification.permission !== 'default';
    beep();
  });
  let audioCtx;
  function beep(urgent = false) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = urgent ? 880 : 660;
      g.gain.setValueAtTime(0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (urgent ? 0.6 : 0.25));
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (urgent ? 0.6 : 0.25));
    } catch { /* audio blocked until the first click */ }
  }
  function notify(title, body, urgent) {
    beep(urgent);
    if (canNotify && Notification.permission === 'granted') { try { new Notification(title, { body, tag: title + body }); } catch { /* ignore */ } }
  }

  // ── Event polling: drives refreshes and alerts ──
  async function pollEvents(initial = false) {
    try {
      const r = await api('GET', '/events' + (S.cursor ? `?after=${S.cursor}&limit=200` : '?limit=500'));
      if (initial) {
        // Start from the latest event without alerting on history.
        let page = r;
        while (page.more) page = await api('GET', `/events?after=${page.next}&limit=500`);
        S.cursor = page.next;
        return;
      }
      if (!r.events.length) return;
      S.cursor = r.next;
      const alerts = S.alerts || {};
      let views = new Set();
      let settingsChanged = false;
      for (const e of r.events) {
        if (e.type === 'idea.created') {
          views.add('ideas');
          if (alerts['alerts.new_idea'] !== false) notify('New trade idea', `${e.data?.symbol || ''} ${label(e.data?.structure)}`, false);
        } else if (e.type === 'signal.raised') {
          views.add('dashboard'); views.add('feed');
          if (['STOP', 'CLOSE_EXPIRY', 'ADJUST'].includes(e.data?.action) && alerts['alerts.urgent_signals'] !== false) notify(`${e.data.action} (${e.data.source})`, e.data.reason || '', true);
        } else if (e.type.startsWith('order.') || e.type.startsWith('position.')) {
          views.add('dashboard'); views.add('orders'); views.add('closed'); views.add('ideas');
        } else if (e.type === 'settings.changed') {
          settingsChanged = true;
        } else {
          views.add('dashboard');
        }
      }
      await loadStatus();
      if (settingsChanged) {
        // Keep alert preferences current; redraw the form only if it shows an older
        // version and has no unsaved edits or errors on it.
        const live = await api('GET', '/settings');
        S.alerts = live.values;
        const dirty = document.querySelector('.setting.changed, .setting .err');
        if (S.tab === 'settings' && !dirty && S.settings && live.version !== S.settings.version) loadSettings();
      }
      if (views.has(S.tab)) refresh();
    } catch (e) {
      if (e.status === 401) location.reload();
    }
  }

  // ── Boot ──
  (async () => {
    try {
      S.settings = await api('GET', '/settings?meta=1');
      S.meta = S.settings.meta;
      S.alerts = S.settings.values;
      await pollEvents(true);
      show('dashboard');
    } catch (e) { toast(errText(e), true); }
    setInterval(() => pollEvents(), 5000);
    setInterval(() => { if (S.tab === 'dashboard') refresh('dashboard'); }, 15000);
    setInterval(() => { if (S.tab === 'ideas') refresh('ideas'); }, 60000);
  })();
})();
