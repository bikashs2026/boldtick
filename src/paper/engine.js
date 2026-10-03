// src/paper/engine.js — action rules for one position (pure function)
//
// evaluate() looks at a position, its latest mark, its exit rules and the time,
// and returns the single most urgent signal. A signal that is already active
// only clears once the number moves back past the threshold by `clear_margin_pct`,
// so a position sitting on the line doesn't flicker.

const { hmToMinutes } = require('./clock');
const { MULT } = require('./pricing');

const URGENCY = ['STOP', 'CLOSE_EXPIRY', 'ADJUST', 'TAKE_PROFIT', 'HOLD'];

function evaluate({ position, mark, et, prev = 'HOLD' }) {
  const rules = position.exit || {};
  const margin = (rules.clear_margin_pct ?? 10) / 100;
  const credit = position.credit_or_debit === 'credit';
  const u = position.units;
  const entry = position.entry_price;
  const basis = entry * MULT * u;                 // credit received or debit paid, in $
  const active = {};
  const was = a => prev === a;

  if (mark && !mark.stale) {
    const pnl = mark.pnl;
    const loss = -pnl;

    // Take profit
    if (rules.take_profit_price != null) {
      const p = rules.take_profit_price;
      const hit = credit ? mark.value <= p : mark.value >= p;
      const hold = credit ? mark.value <= p * (1 + margin) : mark.value >= p * (1 - margin);
      if (hit || (was('TAKE_PROFIT') && hold)) active.TAKE_PROFIT = `structure at ${mark.value.toFixed(2)} reached Muse's take-profit ${p.toFixed(2)}`;
    } else if (credit && position.max_profit > 0) {
      const pct = pnl / position.max_profit * 100;
      const thr = rules.tp_credit_pct;
      if (pct >= thr || (was('TAKE_PROFIT') && pct >= thr * (1 - margin))) active.TAKE_PROFIT = `profit ${pct.toFixed(0)}% of max (target ${thr}%)`;
    } else if (!credit && basis > 0) {
      const pct = pnl / basis * 100;
      const thr = rules.tp_debit_pct;
      if (pct >= thr || (was('TAKE_PROFIT') && pct >= thr * (1 - margin))) active.TAKE_PROFIT = `up ${pct.toFixed(0)}% on the debit (target ${thr}%)`;
    }

    // Stop
    if (rules.stop_price != null) {
      const p = rules.stop_price;
      const hit = credit ? mark.value >= p : mark.value <= p;
      const hold = credit ? mark.value >= p * (1 - margin) : mark.value <= p * (1 + margin);
      if (hit || (was('STOP') && hold)) active.STOP = `structure at ${mark.value.toFixed(2)} hit Muse's stop ${p.toFixed(2)}`;
    } else if (credit && basis > 0) {
      const thr = rules.stop_credit_mult * basis;
      if (loss >= thr || (was('STOP') && loss >= thr * (1 - margin))) active.STOP = `loss $${loss.toFixed(0)} ≥ ${rules.stop_credit_mult}× credit ($${thr.toFixed(0)})`;
    } else if (!credit && basis > 0) {
      const pct = loss / basis * 100;
      const thr = rules.stop_debit_pct;
      if (pct >= thr || (was('STOP') && pct >= thr * (1 - margin))) active.STOP = `down ${pct.toFixed(0)}% of the debit (stop ${thr}%)`;
    }
  }

  // Expiry-day rules use the legs that expire today
  const todays = position.legs.filter(l => l.expiry === et.date);
  if (todays.length) {
    if (et.minutes >= hmToMinutes(rules.close_expiry_at || '15:30')) {
      active.CLOSE_EXPIRY = `expiry day, after ${rules.close_expiry_at} ET`;
    } else if (et.minutes >= hmToMinutes(rules.gamma_from || '14:00') && mark && mark.underlying) {
      const shorts = todays.filter(l => l.action === 'sell');
      const within = rules.gamma_within_pct ?? 1;
      const near = shorts.map(l => ({ l, d: Math.abs(mark.underlying - l.strike) / mark.underlying * 100 }))
        .sort((a, b) => a.d - b.d)[0];
      if (near && (near.d <= within || (was('ADJUST') && near.d <= within * (1 + margin)))) {
        active.ADJUST = `gamma risk: ${position.symbol} ${mark.underlying.toFixed(2)} is ${near.d.toFixed(2)}% from short ${near.l.type} ${near.l.strike}`;
      }
    }
  }

  const action = URGENCY.find(a => active[a]) || 'HOLD';
  return { action, reason: active[action] || 'within limits', active: Object.keys(active) };
}

module.exports = { evaluate, URGENCY };
