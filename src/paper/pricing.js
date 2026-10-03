// src/paper/pricing.js — structure math: risk, live price, marks, P&L
//
// Prices are per share (a 1.20 credit = $120 per contract). "units" = how many
// of the structure (every leg has the same quantity in all supported structures).

const MULT = 100;

function normLegs(idea) {
  return (idea.legs || []).map(l => ({
    action: String(l.action).toLowerCase(),
    type: String(l.type).toLowerCase(),
    strike: Number(l.strike),
    qty: Number(l.qty),
    expiry: String(l.expiry || idea.expiry),
  }));
}

const units = legs => (legs.length ? legs[0].qty : 0);
const sells = (legs, type) => legs.filter(l => l.action === 'sell' && (!type || l.type === type));
const buys  = (legs, type) => legs.filter(l => l.action === 'buy'  && (!type || l.type === type));

// Risk for one structure at a given limit price. Returns $ totals for all units.
function riskProfile(structure, legs, price) {
  const u = units(legs);
  const p = Number(price);
  switch (structure) {
    case 'iron_condor': {
      const sp = sells(legs, 'put')[0], lp = buys(legs, 'put')[0], sc = sells(legs, 'call')[0], lc = buys(legs, 'call')[0];
      const width = Math.max(sp.strike - lp.strike, lc.strike - sc.strike);
      return { defined: true, width, max_profit: r2(p * MULT * u), max_loss: r2((width - p) * MULT * u), breakevens: [r2(sp.strike - p), r2(sc.strike + p)] };
    }
    case 'bull_put_spread': {
      const sp = sells(legs, 'put')[0], lp = buys(legs, 'put')[0];
      const width = sp.strike - lp.strike;
      return { defined: true, width, max_profit: r2(p * MULT * u), max_loss: r2((width - p) * MULT * u), breakevens: [r2(sp.strike - p)] };
    }
    case 'diagonal':
    case 'calendar': {
      const long = buys(legs)[0], short = sells(legs)[0];
      // A long strike further OTM than the short adds the strike gap to the risk.
      const gap = long.type === 'call' ? Math.max(0, long.strike - short.strike) : Math.max(0, short.strike - long.strike);
      return { defined: true, width: null, max_profit: null, max_loss: r2((p + gap) * MULT * u), breakevens: null };
    }
    case 'covered_call':
      return { defined: true, covered: true, width: null, max_profit: r2(p * MULT * u), max_loss: null, breakevens: null };
    case 'covered_strangle': {
      const sp = sells(legs, 'put')[0];
      // The short put is cash-secured: assignment risk, not a defined max loss.
      return { defined: false, covered: true, width: null, max_profit: r2(p * MULT * u), max_loss: null,
        assignment_risk: r2((sp.strike - p) * MULT * u), breakevens: null };
    }
    default:
      return { defined: false, width: null, max_profit: null, max_loss: null, breakevens: null };
  }
}

// Opening price of the structure from live quotes (per unit, positive number).
// quotes: Map legKey -> { bid, ask, mid, delta }
function openingPrice(legs, quotes, creditOrDebit) {
  let mid = 0, natural = 0;
  for (const l of legs) {
    const q = quotes.get(legKey(l));
    if (!q) return null;
    const n = l.qty / units(legs);
    if (l.action === 'sell') { mid += n * q.mid; natural += n * q.bid; }
    else { mid -= n * q.mid; natural -= n * q.ask; }
  }
  // mid/natural here are net credit; flip for debit structures.
  if (creditOrDebit === 'debit') { mid = -mid; natural = -natural; }
  return { mid: r2(mid), natural: r2(natural) };
}

// Mark of an open position: value of the structure now (per unit, positive),
// and P&L in dollars. entryPrice is per unit, positive.
function mark(legs, quotes, creditOrDebit, entryPrice) {
  let netMid = 0, netNat = 0; // value we'd receive by closing (long legs sold, short legs bought)
  for (const l of legs) {
    const q = quotes.get(legKey(l));
    if (!q || q.mid == null) return { stale: true };
    const n = l.qty / units(legs);
    if (l.action === 'buy') { netMid += n * q.mid; netNat += n * q.bid; }
    else { netMid -= n * q.mid; netNat -= n * q.ask; }
  }
  const u = units(legs);
  const credit = creditOrDebit === 'credit';
  const entryNet = credit ? entryPrice : -entryPrice; // cash received per unit at entry
  return {
    stale: false,
    value: r2(credit ? -netMid : netMid),            // structure price now
    natural: r2(credit ? -netNat : netNat),          // what closing at the touch costs / returns
    pnl: r2((entryNet + netMid) * MULT * u),
    pnl_natural: r2((entryNet + netNat) * MULT * u),
  };
}

// Closing order price for a position (per unit, positive).
function closingPrice(m, mode) { return mode === 'natural' ? m.natural : m.value; }

// Exchange tick for an order price.
function roundToTick(symbol, price, dir = 'nearest') {
  const s = String(symbol).toUpperCase().replace(/^\$/, '');
  const tick = (s === 'SPX' || s === 'SPXW' || s === 'XSP') ? (price >= 3 ? 0.10 : 0.05) : 0.01;
  const f = dir === 'up' ? Math.ceil : dir === 'down' ? Math.floor : Math.round;
  const steps = f(Number((price / tick).toFixed(6)));
  return Math.max(tick, r2(steps * tick));
}

function legKey(l) { return `${l.expiry}|${l.type}|${Number(l.strike)}`; }
function r2(v) { return Math.round(v * 100) / 100 + 0; } // + 0 turns -0 into 0

module.exports = { normLegs, units, sells, buys, riskProfile, openingPrice, mark, closingPrice, roundToTick, legKey, MULT, r2 };
