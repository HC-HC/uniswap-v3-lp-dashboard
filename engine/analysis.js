// Position analysis on a sealed snapshot: deposit, payoff, curve-aware fee estimates, Monte Carlo,
// rolling historical time-in-range, width comparison and a historical replay.
import { ApiError } from './errors.js';
import { contentHash } from './sha256.js';
import { alignRange, amountsForLiquidity, positionValue, liquidityForCapital, fullRangeLiquidity, toRawLiquidity } from './v3math.js';
import { makeRng, makeNormal, summarize, histogram } from './stats.js';
import { verifySnapshot, deriveMarket, completeDays, normalizePool } from './snapshot.js';
import { makeCurve, liquidityBars, averageL } from './curve.js';
import { normalizeInputs } from './validate.js';

export const ENGINE_VERSION = '2.1.0';

export const ASSUMPTIONS = [
  { id: 'A1', text: "Fee share at price P = your L ÷ (pool L(P) + your L). 'follow' keeps pool L at today's active L wherever price goes (LPs re-centre); 'static' reads pool L(P) from today's on-chain liquidity map." },
  { id: 'A2', text: 'Pool volume per day stays at the selected level (default: 30-day mean). Real volume rises with volatility and is bursty.' },
  { id: 'A3', text: 'Forward prices follow driftless geometric Brownian motion at realized volatility. Real ETH returns have fat tails, so extremes are understated.' },
  { id: 'A4', text: 'Fees accrue at 0.05% of volume while in range; no compounding; protocol fee off.' },
  { id: 'A5', text: 'Historical figures use GeckoTerminal daily candles; time in range per day assumes prices are spread evenly between low and high.' },
  { id: 'A6', text: 'Gas is a flat USD cost for mint, collect and burn. No rebalancing.' },
  { id: 'A7', text: 'Competition is the liquidity visible at the snapshot block. Just-in-time liquidity (added and removed around single swaps) is not visible, so fee share is overstated, most of all in thin pools.' },
];

export function roundDeep(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? (v === 0 ? 0 : Number(v.toPrecision(12))) : null;
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = roundDeep(v[k]); return o; }
  return v;
}

export function candleTimeInRange(c, Pa, Pb) {
  if (c.high <= c.low) return c.close >= Pa && c.close <= Pb ? 1 : 0;
  return Math.max(0, Math.min(1, (Math.min(c.high, Pb) - Math.max(c.low, Pa)) / (c.high - c.low)));
}

export function buildPosition(capital, P, range, poolL0, pool) {
  const L = liquidityForCapital(capital, P, range.lower, range.upper);
  const { x, y } = amountsForLiquidity(L, P, range.lower, range.upper);
  return { L, x, y, shareNow: L / (poolL0 + L), rawL: toRawLiquidity(L, pool), efficiency: L / fullRangeLiquidity(capital, P) };
}

export function simulatePaths({ P0, sigma, mu, days, stepsPerDay, n, seed }) {
  const steps = days * stepsPerDay, dt = 1 / (365 * stepsPerDay);
  const drift = (mu - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt);
  const normal = makeNormal(makeRng(seed));
  const paths = new Float64Array(n * steps);
  for (let i = 0; i < n; i++) { let lnP = Math.log(P0); for (let s = 0; s < steps; s++) { lnP += drift + vol * normal(); paths[i * steps + s] = Math.exp(lnP); } }
  return { paths, steps, n };
}

/** Pool L along every path from today's map (static mode). Outside the map, fall back to today's active L. */
export function poolLAlongPaths(sim, curve, L0) {
  const out = new Float64Array(sim.paths.length);
  let outside = 0;
  for (let k = 0; k < sim.paths.length; k++) { const v = curve.at(sim.paths[k]); if (v === null || v <= 0) { out[k] = L0; outside++; } else out[k] = v; }
  return { Lstatic: out, outsideFraction: outside / sim.paths.length };
}

export function evaluateOnPaths(sim, ctx, range, detail = false) {
  const { paths, steps, n } = sim;
  const { P0, capital, L0, Lstatic, volume, fee, gasUsd, stepsPerDay, pool, mode } = ctx;
  const pos = buildPosition(capital, P0, range, L0, pool);
  const vps = (volume * fee) / stepsPerDay;
  const feeFollowStep = vps * (pos.L / (L0 + pos.L));
  const net = new Float64Array(n), vsHodl = new Float64Array(n), fHead = new Float64Array(n), fS = new Float64Array(n), fF = new Float64Array(n), tir = new Float64Array(n), il = new Float64Array(n);
  let endIn = 0, beat = 0, loss = 0, exited = 0, inStepsTot = 0, staticFeeInTot = 0;
  const firstExit = [];
  for (let i = 0; i < n; i++) {
    let inSteps = 0, fe = -1, fStatic = 0;
    const b = i * steps;
    for (let s = 0; s < steps; s++) {
      const p = paths[b + s];
      if (p >= range.lower && p <= range.upper) { inSteps++; fStatic += vps * (pos.L / (Lstatic[b + s] + pos.L)); }
      else if (fe < 0) fe = s;
    }
    const PT = paths[b + steps - 1];
    const lp = positionValue(pos.L, PT, range.lower, range.upper), hodl = pos.x * PT + pos.y;
    const fFollow = feeFollowStep * inSteps;
    const fees = mode === 'static' ? fStatic : fFollow;
    const total = lp + fees - gasUsd;
    net[i] = total - capital; vsHodl[i] = total - hodl; fHead[i] = fees; fS[i] = fStatic; fF[i] = fFollow; tir[i] = inSteps / steps; il[i] = lp / hodl - 1;
    inStepsTot += inSteps; staticFeeInTot += fStatic;
    if (PT >= range.lower && PT <= range.upper) endIn++;
    if (total > hodl) beat++;
    if (total < capital) loss++;
    if (fe >= 0) { exited++; firstExit.push((fe + 1) / stepsPerDay); }
  }
  const dailyInRange = {
    follow: feeFollowStep * stepsPerDay,
    static: inStepsTot ? (staticFeeInTot / inStepsTot) * stepsPerDay : null, // average over in-range steps
  };
  const out = {
    position: pos,
    dailyFeesInRange: dailyInRange,
    probEndInRange: endIn / n, probEverExit: exited / n,
    medianFirstExitDays: firstExit.length ? summarize(firstExit).p50 : null,
    meanTimeInRange: summarize(tir).mean,
    probBeatHodl: beat / n, probLoss: loss / n,
    fees: summarize(fHead), feesStatic: summarize(fS), feesFollow: summarize(fF),
    netPnl: summarize(net), vsHodl: summarize(vsHodl), il: summarize(il),
  };
  if (detail) {
    out.histogramNetPnl = histogram(net, 36);
    const ends = new Float64Array(n);
    for (let i = 0; i < n; i++) ends[i] = paths[i * steps + steps - 1];
    out.endPrice = summarize(ends);
    out.samplePaths = [];
    for (let i = 0; i < Math.min(10, n); i++) { const pts = []; for (let d = 0; d < steps / stepsPerDay; d++) pts.push(paths[i * steps + (d + 1) * stepsPerDay - 1]); out.samplePaths.push(pts); }
    // P5/P50/P95 cone by day
    const D = steps / stepsPerDay; out.cone = [];
    const col = new Float64Array(n);
    for (let d = 0; d < D; d++) { for (let i = 0; i < n; i++) col[i] = paths[i * steps + (d + 1) * stepsPerDay - 1]; const s = summarize(col); out.cone.push({ day: d + 1, p5: s.p5, p50: s.p50, p95: s.p95 }); }
  }
  return out;
}

/** Same ±% range re-centred at each past start day's open and held H days. */
export function rollingTimeInRange(days, ratioLow, ratioHigh, H) {
  const hold = Math.min(H, days.length - 1);
  if (hold < 2) return null;
  const res = [];
  for (let s = 0; s + hold <= days.length; s++) {
    const Pa = days[s].open * ratioLow, Pb = days[s].open * ratioHigh;
    let t = 0;
    for (let d = s; d < s + hold; d++) t += candleTimeInRange(days[d], Pa, Pb);
    res.push(t / hold);
  }
  const sorted = [...res].sort((a, b) => a - b);
  return { windows: res.length, holdDays: hold, mean: res.reduce((a, b) => a + b, 0) / res.length, p10: sorted[Math.floor(0.1 * (sorted.length - 1))], median: sorted[Math.floor(0.5 * (sorted.length - 1))] };
}

/** Replay: range set at the open of the first of the last N complete days, held to the end; observed daily volume. */
export function replay({ days, n, capital, ratioLow, ratioHigh, L0, curveAtShift, fee, gasUsd, pool, mode }) {
  const sl = days.slice(-n);
  if (sl.length < 2) return null;
  const P0 = sl[0].open;
  const range = alignRange(P0 * ratioLow, P0 * ratioHigh, pool);
  const pos = buildPosition(capital, P0, range, L0, pool);
  let fees = 0, inR = 0;
  const series = [];
  for (const d of sl) {
    const f = candleTimeInRange(d, range.lower, range.upper);
    // pool L near the day's price: follow = today's active L; static = today's map shifted so it is centred on P0
    const Lp = mode === 'static' ? (curveAtShift(d.close / P0) ?? L0) : L0;
    fees += d.volumeUsd * fee * (pos.L / (Lp + pos.L)) * f;
    inR += f;
    const lp = positionValue(pos.L, d.close, range.lower, range.upper), hodl = pos.x * d.close + pos.y;
    series.push({ t: d.date, close: d.close, low: d.low, high: d.high, volumeUsd: d.volumeUsd, lp, hodl, fees, timeInRange: f });
  }
  const last = series[series.length - 1];
  return {
    kind: 'mixed', from: sl[0].date, to: last.t, days: sl.length, entryPrice: P0, range: { lower: range.lower, upper: range.upper },
    timeInRangePct: inR / sl.length, feesUsd: fees, lpValueEnd: last.lp, hodlValueEnd: last.hodl,
    netPnlUsd: last.lp + fees - gasUsd - capital, netVsHodlUsd: last.lp + fees - gasUsd - last.hodl, impermanentLossPct: last.lp / last.hodl - 1, series,
  };
}

function valueCurve(L, x0, y0, P0, range) {
  const lo = Math.min(P0, range.lower) * 0.75, hi = Math.max(P0, range.upper) * 1.25;
  const pts = [];
  for (let i = 0; i <= 100; i++) { const p = lo * Math.pow(hi / lo, i / 100); const lp = positionValue(L, p, range.lower, range.upper), hodl = x0 * p + y0; pts.push({ price: p, lp, hodl, ilPct: lp / hodl - 1 }); }
  return pts;
}

/**
 * Daily pool volume at which the expected result vs holding is zero. Fees scale linearly with volume and
 * nothing else in the result depends on it, so: vsHold(V) = fees·V/V0 + rest  →  V* = V0 · (−rest) / fees.
 */
export function breakEvenVolume(volume0, expectedFees, expectedVsHodl) {
  const rest = expectedVsHodl - expectedFees;          // price effect − gas (volume-independent)
  if (rest >= 0) return { volumeUsd: 0, multiple: 0, note: 'beats holding even with zero fees' };
  if (!(expectedFees > 0)) return { volumeUsd: null, multiple: null, note: 'no fees earned on these paths' };
  const v = volume0 * (-rest) / expectedFees;
  return { volumeUsd: v, multiple: v / volume0 };
}

/** ETH exposure (WETH held, in USD and % of position value) at a given price. */
export function exposureAt(L, P, range) {
  const { x, y } = amountsForLiquidity(L, P, range.lower, range.upper);
  const value = x * P + y;
  return { price: P, weth: x, usd: x * P, pctOfPosition: value > 0 ? (x * P) / value : 0 };
}

/** Fraction of a steady (log-linear) move from P0 to P1 that stays inside [a, b]. */
export function linearTimeInRange(P0, P1, a, b) {
  const l0 = Math.log(P0), l1 = Math.log(P1), la = Math.log(a), lb = Math.log(b);
  if (Math.abs(l1 - l0) < 1e-12) return P0 >= a && P0 <= b ? 1 : 0;
  const t = (l) => (l - l0) / (l1 - l0);
  const lo = Math.max(0, Math.min(t(la), t(lb))), hi = Math.min(1, Math.max(t(la), t(lb)));
  return Math.max(0, hi - lo);
}

/** "If ETH moves steadily to X% over the horizon": deterministic what-ifs for the presenter. */
export function priceScenarios({ moves, P0, pos, range, dailyFees, H, gasUsd, capital }) {
  return moves.map((m) => {
    const P1 = P0 * (1 + m);
    const tir = linearTimeInRange(P0, P1, range.lower, range.upper);
    const fees = dailyFees * H * tir;
    const lp = positionValue(pos.L, P1, range.lower, range.upper), hodl = pos.x * P1 + pos.y;
    return { move: m, price: P1, timeInRange: tir, fees, lpValue: lp, hodlValue: hodl, netPnl: lp + fees - gasUsd - capital, vsHodl: lp + fees - gasUsd - hodl };
  });
}

export function analyze(snapshot, rawInputs) {
  verifySnapshot(snapshot);
  const inputs = normalizeInputs(rawInputs);
  const market = deriveMarket(snapshot, inputs);
  const pool = normalizePool(snapshot.pool), fee = pool.feeTier;
  const warnings = [...market.warnings];
  const curve = makeCurve(market.segs);
  const L0 = market.activeLiquidity.value;
  const spot = market.spot.value;
  const P0 = inputs.entryPrice ?? spot;
  if (inputs.entryPrice !== undefined) warnings.push({ code: 'WHAT_IF_ENTRY', message: `What-if entry at ${P0.toFixed(2)}: the liquidity map is still today's, observed at ${spot.toFixed(2)}.` });
  const reqLower = inputs.rangeWidthPct !== undefined ? P0 * (1 - inputs.rangeWidthPct / 100) : inputs.rangeLower;
  const reqUpper = inputs.rangeWidthPct !== undefined ? P0 * (1 + inputs.rangeWidthPct / 100) : inputs.rangeUpper;
  const range = alignRange(reqLower, reqUpper, pool);
  const capital = inputs.capitalUsd, volume = market.volume.value;
  const sigma = market.volatility.annual, mode = inputs.liquidityMode;
  const days = completeDays(snapshot);

  const pos = buildPosition(capital, P0, range, L0, pool);
  const status = P0 < range.lower ? 'below-range' : P0 > range.upper ? 'above-range' : 'in-range';
  if (status !== 'in-range') warnings.push({ code: 'ENTRY_OUT_OF_RANGE', message: `Entry ${P0.toFixed(2)} is ${status.replace('-', ' ')}: single-sided deposit, no fees until price re-enters.` });
  if (pos.shareNow > 0.05) warnings.push({ code: 'LARGE_SHARE', message: `You would be ${(pos.shareNow * 100).toFixed(1)}% of active liquidity; the fee model breaks down at that size.` });
  if (inputs.gasUsd > capital * 0.01) warnings.push({ code: 'GAS_HEAVY', message: `Gas is ${(inputs.gasUsd / capital * 100).toFixed(1)}% of capital.` });
  const crowd = averageL(market.segs, range.lower, range.upper);
  if (crowd.coverage < 0.999) warnings.push({ code: 'CURVE_PARTIAL', message: `Liquidity map covers ${(crowd.coverage * 100).toFixed(0)}% of this range; outside it, static mode uses today's active L.` });

  // Monte Carlo (shared paths for every candidate range)
  const sim = simulatePaths({ P0, sigma, mu: inputs.driftAnnual, days: inputs.horizonDays, stepsPerDay: inputs.stepsPerDay, n: inputs.simulations, seed: inputs.seed });
  const { Lstatic, outsideFraction } = poolLAlongPaths(sim, curve, L0);
  const ctx = { P0, capital, L0, Lstatic, volume, fee, gasUsd: inputs.gasUsd, stepsPerDay: inputs.stepsPerDay, pool, mode };
  const main = evaluateOnPaths(sim, ctx, range, true);
  const { position: _p, ...mainStats } = main;
  const ratioLow = range.lower / P0, ratioHigh = range.upper / P0;
  const rolling = rollingTimeInRange(days, ratioLow, ratioHigh, inputs.horizonDays);

  const daily = mode === 'static' ? (main.dailyFeesInRange.static ?? main.dailyFeesInRange.follow) : main.dailyFeesInRange.follow;
  const bound = (P) => { const lp = positionValue(pos.L, P, range.lower, range.upper), hodl = pos.x * P + pos.y; return { price: P, lpValue: lp, hodlValue: hodl, ilUsd: lp - hodl, ilPct: lp / hodl - 1, breakEvenDays: daily > 0 ? (hodl - lp) / daily : null }; };

  const comparison = inputs.compareWidthsPct.map((w) => {
    const r = alignRange(P0 * (1 - w / 100), P0 * (1 + w / 100), pool);
    const ev = evaluateOnPaths(sim, ctx, r);
    const roll = rollingTimeInRange(days, r.lower / P0, r.upper / P0, inputs.horizonDays);
    const lp = (P) => positionValue(ev.position.L, P, r.lower, r.upper), hodl = (P) => ev.position.x * P + ev.position.y;
    return row(w, r, ev, roll, capital, inputs.horizonDays, mode, { atLower: lp(r.lower) - hodl(r.lower), atUpper: lp(r.upper) - hodl(r.upper) }, volume);
  });
  const lpB = bound(range.lower), upB = bound(range.upper);
  const selected = { ...row(null, range, main, rolling, capital, inputs.horizonDays, mode, { atLower: lpB.ilUsd, atUpper: upB.ilUsd }, volume), selected: true };

  const curveAtShift = (ratio) => curve.at(spot * ratio);
  const bt = replay({ days, n: 30, capital, ratioLow, ratioHigh, L0, curveAtShift, fee, gasUsd: inputs.gasUsd, pool, mode });

  const result = roundDeep({
    engineVersion: ENGINE_VERSION,
    snapshot: { id: snapshot.id, contentHash: snapshot.contentHash, capturedAt: snapshot.capturedAt, label: snapshot.label, block: snapshot.state.block },
    inputs,
    market: {
      feeTier: market.feeTier, spot: market.spot, activeLiquidity: market.activeLiquidity, tvl: market.tvl, volume: market.volume, volatility: market.volatility, curve: market.curve, history: market.history,
    },
    liquidity: {
      kind: 'derived',
      bars: liquidityBars(market.segs, P0, 25, 100),
      inRangeAvgL: crowd.L, coverage: crowd.coverage, activeL: L0,
      crowdingVsActive: crowd.L ? crowd.L / L0 : null,
    },
    position: {
      kind: 'derived', entryPrice: inputs.entryPrice !== undefined ? { value: P0, kind: 'assumed' } : { value: P0, kind: 'observed', source: 'rpc' },
      requestedRange: { lower: reqLower, upper: reqUpper }, range, status,
      liquidity: pos.L, liquidityRaw: pos.rawL, amounts: { weth: pos.x, usdc: pos.y },
      composition: { wethPct: (pos.x * P0) / capital, usdcPct: pos.y / capital },
      shareNow: pos.shareNow, capitalEfficiencyVsFullRange: pos.efficiency,
    },
    fees: {
      kind: 'estimated', mode, volumeUsed: volume, poolDailyFeesUsd: volume * fee, poolFeeAprOnTvl: (volume * fee * 365) / market.tvl.value,
      dailyInRange: main.dailyFeesInRange, aprInRange: { follow: main.dailyFeesInRange.follow * 365 / capital, static: main.dailyFeesInRange.static !== null ? main.dailyFeesInRange.static * 365 / capital : null },
      expected: { follow: main.feesFollow.mean, static: main.feesStatic.mean },
      expectedApr: { follow: (main.feesFollow.mean / inputs.horizonDays) * 365 / capital, static: (main.feesStatic.mean / inputs.horizonDays) * 365 / capital },
      staticOutsideMapFraction: outsideFraction,
      sensitivity: (market.volume.alternatives || []).filter((a) => a.value).map((a) => ({ label: a.label, apr: a.value * fee * (pos.L / (L0 + pos.L)) * 365 / capital })),
      assumptions: ['A1', 'A2', 'A4'],
    },
    risk: {
      kind: 'derived', atLower: { ...lpB, holds: '100% WETH' }, atUpper: { ...upB, holds: '100% USDC' },
      downsideToLowerPct: range.lower / P0 - 1, upsideToUpperPct: range.upper / P0 - 1,
      oneSigmaDailyMovePct: Math.exp(market.volatility.daily) - 1,
      valueCurve: valueCurve(pos.L, pos.x, pos.y, P0, range),
    },
    simulation: { kind: 'estimated', model: 'GBM', params: { sigmaAnnual: sigma, driftAnnual: inputs.driftAnnual, horizonDays: inputs.horizonDays, stepsPerDay: inputs.stepsPerDay, paths: inputs.simulations, seed: inputs.seed, liquidityMode: mode }, assumptions: ['A1', 'A2', 'A3', 'A4', 'A6'], ...mainStats },
    breakEven: { kind: 'estimated', basis: `${mode} fees, expected result vs holding`, currentVolumeUsd: volume, ...breakEvenVolume(volume, main.fees.mean, main.vsHodl.mean) },
    exposure: { kind: 'derived', now: exposureAt(pos.L, P0, range), atLower: exposureAt(pos.L, range.lower, range), atUpper: exposureAt(pos.L, range.upper, range) },
    scenarios: { kind: 'estimated', description: 'ETH moves steadily (log-linear) to each price over the horizon; fees accrue while inside the range at the in-range rate', rows: priceScenarios({ moves: [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3], P0, pos, range, dailyFees: daily, H: inputs.horizonDays, gasUsd: inputs.gasUsd, capital }) },
    historyRolling: rolling ? { kind: 'observed-replay', ...rolling, assumptions: ['A5'] } : null,
    comparison: { kind: 'estimated', basis: 'same simulated paths for every row; history column re-centres each range on every past day', rows: [selected, ...comparison] },
    backtest: bt ? { ...bt, assumptions: ['A1', 'A4', 'A5', 'A6'] } : null,
    assumptions: ASSUMPTIONS,
    warnings,
  });
  return { result, resultHash: contentHash(result) };
}

function row(w, r, ev, roll, capital, H, mode, ilAt, volume) {
  const d = mode === 'static' ? (ev.dailyFeesInRange.static ?? ev.dailyFeesInRange.follow) : ev.dailyFeesInRange.follow;
  return {
    widthPct: w, lower: r.lower, upper: r.upper,
    shareNow: ev.position.shareNow, efficiency: ev.position.efficiency,
    dailyFeesInRange: d, aprInRange: (d * 365) / capital,
    meanTimeInRange: ev.meanTimeInRange, historyTimeInRange: roll ? roll.mean : null, probEndInRange: ev.probEndInRange,
    expectedFees: ev.fees.mean, expectedFeeApr: (ev.fees.mean / H) * 365 / capital,
    expectedFeesFollow: ev.feesFollow.mean, expectedFeesStatic: ev.feesStatic.mean,
    expectedNetPnl: ev.netPnl.mean, p5NetPnl: ev.netPnl.p5, medianNetPnl: ev.netPnl.p50,
    expectedVsHodl: ev.vsHodl.mean, probBeatHodl: ev.probBeatHodl,
    ilAtLower: ilAt.atLower, ilAtUpper: ilAt.atUpper,
    breakEven: breakEvenVolume(volume, ev.fees.mean, ev.vsHodl.mean),
  };
}

export function analysisId(snapshotId, normalizedInputs) {
  return 'an_' + contentHash({ snapshotId, inputs: normalizedInputs, engineVersion: ENGINE_VERSION }).slice(0, 16);
}

export { ApiError };
