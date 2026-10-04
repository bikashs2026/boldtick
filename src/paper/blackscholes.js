// src/paper/blackscholes.js — theoretical option value before expiration,
// for the Build tab's T+0 P&L line (what the structure would be worth today,
// as opposed to its payoff at expiration). Nothing else in BoldTick needs
// this: every other price (fills, marks, risk) comes from the live bid/ask,
// never a model price.

const DEFAULT_R = 0.045; // risk-free rate assumption; not fetched live, close enough for a what-if curve

// Abramowitz & Stegun 7.1.26 approximation, error < 1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normCDF(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// Theoretical price of one option, per share. T is time to expiry in years;
// T<=0 or sigma<=0 falls back to intrinsic value (no time value left to model).
function price(type, S, K, T, sigma, r = DEFAULT_R) {
  if (T <= 0 || !(sigma > 0)) {
    return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / sd;
  const d2 = d1 - sd;
  if (type === 'call') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

module.exports = { normCDF, erf, price, DEFAULT_R };
