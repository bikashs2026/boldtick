// ── Shared GEX / DEX / Charm / Max-Pain math for the SPX GEX tab ──────────
// Ported 1:1 from the client-side functions in public/index.html (buildGEX,
// calcMaxPain, calcCharm, buildCharm, calcDteFraction, and the "Build Tent"
// pipeline in spxBuildTent) so that server-computed values — used by the
// read-only /api/external/gex/:symbol route — match what the GEX tab shows
// on screen exactly. Keep this in sync with index.html by hand if the
// client-side formulas ever change; there is no shared import between the
// browser and this file.

// ── Shared: time-adjusted DTE fraction ───────────────────────────────────
function calcDteFraction(dte) {
  if (dte > 0) return dte / 252;
  const est      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day      = est.getDay();
  const mins     = est.getHours() * 60 + est.getMinutes();
  const mktOpen  = 570;   // 9:30
  const mktClose = 960;   // 4:00
  const fullDay  = 6.5 / 252;
  if (day === 0 || day === 6 || mins < mktOpen || mins >= mktClose) return fullDay;
  const elapsed   = Math.max(0, mins - mktOpen);
  const remaining = Math.max(0.02, (mktClose - mktOpen - elapsed) / (mktClose - mktOpen));
  return remaining * fullDay;
}

function nearestStrike(target, arr) {
  return arr.reduce((best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best, arr[0]);
}

// ── Max pain: price where aggregate option seller loss is minimized ────────
function calcMaxPain(strikes, calls, puts, price, em) {
  if (!strikes.length) return price || 0;
  const readOI = (map, s) => {
    const arr = map[s] || map[s.toFixed(1)] || map[String(s)] || [];
    return (arr[0] || {}).openInterest || 0;
  };

  const emBound = Math.max((em || 0) * 2, price * 0.15);
  const filtered = emBound > 0
    ? strikes.filter(s => Math.abs(s - price) <= emBound)
    : strikes;
  const relevant = filtered.length >= 2 ? filtered : strikes.filter(s => Math.abs(s - price) <= price * 0.20);

  const active = relevant.filter(s => readOI(calls, s) > 0 || readOI(puts, s) > 0);
  const useStrikes = active.length >= 3 ? active : relevant;

  let minLoss = Infinity, maxPainStrike = useStrikes[Math.floor(useStrikes.length / 2)] || price;

  for (const expiry of useStrikes) {
    let totalLoss = 0;
    for (const s of useStrikes) {
      if (expiry > s) totalLoss += (expiry - s) * readOI(calls, s);
      if (expiry < s) totalLoss += (s - expiry) * readOI(puts, s);
    }
    if (totalLoss < minLoss) { minLoss = totalLoss; maxPainStrike = expiry; }
  }

  return maxPainStrike;
}

// ── Gamma Exposure (GEX) profile ────────────────────────────────────────
function buildGEX(strikes, calls, puts, price, em) {
  const readGreeks = (map, s) => {
    const arr = map[s] || map[s.toFixed(1)] || map[String(s)] || [];
    const o = arr[0] || {};
    return { gamma: o.gamma || 0, oi: o.openInterest || 0 };
  };

  const emBound = Math.max((em || 0) * 2, price * 0.15);
  const relevant = emBound > 0
    ? strikes.filter(s => Math.abs(s - price) <= emBound)
    : strikes;
  const useStrikes = relevant.length >= 2 ? relevant : strikes.filter(s => Math.abs(s - price) <= price * 0.20);

  const profile = useStrikes.map(s => {
    const c = readGreeks(calls, s);
    const p = readGreeks(puts, s);

    const minGamma = 0.0001;
    const callGamma = (c.gamma > 0) ? c.gamma : (c.oi > 0 ? minGamma : 0);
    const putGamma  = (p.gamma > 0) ? p.gamma : (p.oi > 0 ? minGamma : 0);

    const callGEX = callGamma * c.oi * 100 * price * price * 0.01;
    const putGEX  = putGamma  * p.oi * 100 * price * price * 0.01;
    const netGEX  = callGEX - putGEX;

    if (c.oi === 0 && p.oi === 0) return null;

    return { strike: s, callGEX, putGEX, netGEX, callOI: c.oi, putOI: p.oi };
  }).filter(Boolean);

  const totalGEX = profile.reduce((sum, p) => sum + p.netGEX, 0);
  const regime   = totalGEX >= 0 ? 'Positive' : 'Negative';

  const flipStrikes = profile.filter(p => Math.abs(p.strike - price) <= Math.max(em || 0, price * 0.10));
  const flipProfile = flipStrikes.length >= 3 ? flipStrikes : profile;

  let cum = 0, flipStrike = price, prevCum = 0, foundFlip = false;
  for (let i = 0; i < flipProfile.length; i++) {
    prevCum = cum;
    cum += flipProfile[i].netGEX;
    flipProfile[i].cumGEX = cum;
    if (!foundFlip && i > 0 && Math.sign(prevCum) !== Math.sign(cum) && prevCum !== 0) {
      const dPrev = Math.abs(prevCum), dCur = Math.abs(cum);
      flipStrike = dPrev < dCur ? flipProfile[i - 1].strike : flipProfile[i].strike;
      foundFlip = true;
    }
  }
  let cumAll = 0;
  profile.forEach(p => { cumAll += p.netGEX; p.cumGEX = cumAll; });

  if (!foundFlip && useStrikes.length) {
    flipStrike = useStrikes.reduce((b, s) => Math.abs(s - price) < Math.abs(b - price) ? s : b, useStrikes[0]);
  }

  const wallBound = Math.max((em || 0) * 1.5, price * 0.12);
  const nearProfile = profile.filter(p => Math.abs(p.strike - price) <= wallBound);
  const wallProfile = nearProfile.length >= 3 ? nearProfile : profile;

  let callWall = null, putWall = null;
  wallProfile.forEach(p => {
    if (callWall === null || p.netGEX > callWall.netGEX) callWall = p;
    if (putWall === null  || p.netGEX < putWall.netGEX)  putWall  = p;
  });

  let posWeightSum = 0, posStrikeWeighted = 0;
  profile.forEach(p => {
    if (p.netGEX > 0) { posWeightSum += p.netGEX; posStrikeWeighted += p.strike * p.netGEX; }
  });
  const gammaPinCenter = posWeightSum > 0 ? posStrikeWeighted / posWeightSum : price;

  return {
    profile, totalGEX, regime,
    flipStrike, gammaPinCenter,
    callWallStrike: callWall ? callWall.strike : null,
    putWallStrike:  putWall  ? putWall.strike  : null,
  };
}

// ── Charm: Black-Scholes ∂Delta/∂t (r = q = 0 simplification) ─────────────
function calcCharm(S, K, sigma, T) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const phiD1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  return phiD1 * d2 / (2 * T);
}

function buildCharm(strikes, calls, puts, price, ivDecimal, dteFraction) {
  const readOI = (map, s) => {
    const arr = map[s] || map[s.toFixed(1)] || map[String(s)] || [];
    return (arr[0] || {}).openInterest || 0;
  };

  const profile = strikes.map(s => {
    const charm = calcCharm(price, s, ivDecimal, Math.max(dteFraction, 1e-5));
    const callOI = readOI(calls, s), putOI = readOI(puts, s);
    const netCharmExposure = charm * (callOI - putOI) * 100 * price;
    return { strike: s, charm, callOI, putOI, netCharmExposure };
  });

  const totalCharmExposure = profile.reduce((sum, p) => sum + p.netCharmExposure, 0);
  return { profile, totalCharmExposure };
}

// ── Delta Exposure (DEX) — same nearest-25-strikes subset as the GEX tab ──
function buildDEX(strikes, calls, puts, price) {
  const focused = strikes
    .map(s => {
      const cArr = (calls[s] || calls[s.toFixed?.(1)] || [])[0] || {};
      const pArr = (puts[s]  || puts[s.toFixed?.(1)]  || [])[0] || {};
      const callDelta = Math.abs(cArr.delta || 0);
      const putDelta  = Math.abs(pArr.delta || 0);
      const callOI    = cArr.openInterest || 0;
      const putOI     = pArr.openInterest || 0;
      const callDEX   = callDelta * callOI * 100 * price * 0.01;
      const putDEX    = putDelta  * putOI  * 100 * price * 0.01;
      return { strike: s, callDEX, putDEX, netDEX: callDEX - putDEX, callOI, putOI };
    })
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))
    .slice(0, 25);

  const totalCallDEX = focused.reduce((s, p) => s + p.callDEX, 0);
  const totalPutDEX  = focused.reduce((s, p) => s + p.putDEX,  0);
  const netDEX       = totalCallDEX - totalPutDEX;

  return {
    callDEX: totalCallDEX,
    putDEX: totalPutDEX,
    netDEX,
    bias: netDEX > 0 ? 'Bullish' : 'Bearish',
  };
}

// ── Full snapshot: mirrors the SPX GEX tab's "Build Tent" pipeline ────────
// chain: raw Schwab option-chain response ({ callExpDateMap, putExpDateMap,
//   underlyingPrice }). expDate: optional 'YYYY-MM-DD' to pin a specific
//   expiration instead of the nearest available one (matches the GEX tab's
//   own dropdown-vs-nearest fallback logic).
function computeGexSnapshot(chain, expDate) {
  const price = chain.underlyingPrice || 0;
  const callMap = chain.callExpDateMap || {};
  const putMap  = chain.putExpDateMap  || {};
  const allKeys = [...new Set([...Object.keys(callMap), ...Object.keys(putMap)])];
  if (!allKeys.length || !price) return null;

  const today = Date.now();
  const parseExpDateEST = key => new Date(key.split(':')[0] + 'T17:00:00Z').getTime();

  let bestKey = null, bestDiff = Infinity;
  for (const key of allKeys) {
    const keyDate = key.split(':')[0];
    if (expDate && keyDate === expDate) { bestKey = key; break; }
    const expMs = parseExpDateEST(key);
    const daysOut = (expMs - today) / 86400000;
    if (daysOut < -0.5) continue;
    const diff = Math.abs(daysOut);
    if (diff < bestDiff) { bestDiff = diff; bestKey = key; }
  }
  if (!bestKey) return null;

  const calls = callMap[bestKey] || {};
  const puts  = putMap[bestKey]  || {};
  const dte   = Math.max(0, Math.round((parseExpDateEST(bestKey) - today) / 86400000));

  const allStrikes = [...new Set([
    ...Object.keys(calls).map(Number).filter(n => !isNaN(n)),
    ...Object.keys(puts).map(Number).filter(n => !isNaN(n)),
  ])].sort((a, b) => a - b);
  if (!allStrikes.length) return null;

  const strikeStep = allStrikes.length > 1
    ? allStrikes.reduce((min, s, i) => i === 0 ? Infinity : Math.min(min, s - allStrikes[i - 1]), Infinity)
    : 5;

  const readOI = (map, s) => { const arr = map[s] || map[s.toFixed(1)] || []; return (arr[0] || {}).openInterest || 0; };
  const nearAtm = allStrikes.filter(s => Math.abs(s - price) <= 50);
  const totalOINearAtm = nearAtm.reduce((sum, s) => sum + readOI(calls, s) + readOI(puts, s), 0);
  const hasOI = totalOINearAtm > 0;

  const atm = nearestStrike(price, allStrikes);
  const nearbyStrikes = allStrikes.filter(s => Math.abs(s - atm) <= strikeStep * 2);
  const ivSamples = nearbyStrikes.map(s => {
    const arr = calls[s] || calls[s.toFixed(1)] || [];
    const v = arr[0]?.volatility || 0;
    if (!v || v <= 0) return null;
    return v > 5 ? v / 100 : v;
  }).filter(v => v !== null && v > 0.005 && v < 3.0);

  let ivDecimal;
  if (ivSamples.length >= 2) {
    const sorted = [...ivSamples].sort((a, b) => a - b);
    ivDecimal = sorted[Math.floor(sorted.length / 2)];
  } else {
    const atmArr = calls[atm] || calls[atm.toFixed(1)] || [];
    const rawIV = atmArr[0]?.volatility || 13;
    ivDecimal = rawIV > 5 ? rawIV / 100 : rawIV;
  }
  ivDecimal = Math.max(0.01, Math.min(2.0, ivDecimal));

  const dteFraction = calcDteFraction(dte);
  let expectedMove = price * ivDecimal * Math.sqrt(dteFraction);
  const maxReasonableEM = dte === 0
    ? price * 0.05
    : price * ivDecimal * Math.sqrt(dte / 252) * 1.5;
  expectedMove = Math.min(expectedMove, maxReasonableEM);

  const maxPainStrike = hasOI ? calcMaxPain(allStrikes, calls, puts, price, expectedMove) : price;

  const maxPainDist = Math.abs(maxPainStrike - price);
  const baseMpWeight = hasOI ? 0.15 : 0;
  const mpDampen = hasOI && expectedMove > 0
    ? Math.max(0, Math.min(1, 1 - (maxPainDist - expectedMove * 0.25) / (expectedMove * 0.75)))
    : 0;
  const mpWeight = baseMpWeight * mpDampen;
  const mpBlendTarget = price * (1 - mpWeight) + maxPainStrike * mpWeight;

  const gex = hasOI ? buildGEX(allStrikes, calls, puts, price, expectedMove) : null;

  const gammaPinCenter = hasOI && gex ? gex.gammaPinCenter : price;
  const gammaDist = Math.abs(gammaPinCenter - mpBlendTarget);
  const gammaDampen = hasOI && expectedMove > 0
    ? Math.max(0, Math.min(1, 1 - (gammaDist - expectedMove * 0.5) / (expectedMove * 2.5)))
    : 0;
  const baseGammaWeight = (hasOI && gex?.regime === 'Positive') ? 0.30 : (hasOI ? 0.05 : 0);
  const gammaWeight = baseGammaWeight * gammaDampen;
  const pinTarget = mpBlendTarget * (1 - gammaWeight) + gammaPinCenter * gammaWeight;

  const charm = hasOI ? buildCharm(allStrikes, calls, puts, price, ivDecimal, dteFraction) : null;
  const charmFlowToday = charm ? charm.totalCharmExposure * dteFraction : 0;
  const charmDriftPct  = (charm && gex && gex.totalGEX !== 0) ? (charmFlowToday / gex.totalGEX) : 0;
  const maxShift = expectedMove * 0.15;
  const charmPinShift = Math.max(-maxShift, Math.min(maxShift, price * (charmDriftPct / 100)));
  const charmAdjPinTarget = pinTarget + charmPinShift;

  const dex = buildDEX(allStrikes, calls, puts, price);

  return {
    expDate: bestKey.split(':')[0],
    dte,
    timestamp: new Date().toISOString(),
    price,
    hasOI,
    iv: ivDecimal,
    expectedMove,
    maxPain: hasOI ? maxPainStrike : null,
    regime: gex ? gex.regime : null,
    totalGEX: gex ? gex.totalGEX : null,
    flip: gex ? gex.flipStrike : null,
    callWall: gex ? gex.callWallStrike : null,
    putWall: gex ? gex.putWallStrike : null,
    gammaPinCenter: gex ? gex.gammaPinCenter : null,
    byStrike: gex ? gex.profile : null, // [{ strike, callGEX, putGEX, netGEX, callOI, putOI }], ascending by strike
    pin: hasOI ? charmAdjPinTarget : null,
    dex,
    charm: charm ? {
      totalCharmExposure: charm.totalCharmExposure,
      charmFlowToday,
      charmDriftPct,
      charmPinShift,
    } : null,
  };
}

module.exports = {
  computeGexSnapshot,
  calcDteFraction, nearestStrike, calcMaxPain, buildGEX, calcCharm, buildCharm, buildDEX,
};
