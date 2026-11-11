// Liquidity curve: active liquidity at every price, rebuilt from on-chain initialized ticks.
//   state.liquidity = active L in the segment containing the current tick.
//   Crossing an initialized tick k upward:   L += liquidityNet[k]
//   Crossing it downward (k ≤ current tick): L -= liquidityNet[k]
// With base = token1 (WETH) and quote = token0 (USDC), a higher tick means a lower WETH price.
import { ApiError } from './errors.js';
import { tickToPrice, fromRawLiquidity } from './v3math.js';

export function buildSegments(state, ticks, pool) {
  const t0 = Number(state.tick);
  const L0 = BigInt(state.liquidity);
  const sorted = ticks.map((t) => ({ idx: Number(t.tickIdx), net: BigInt(t.liquidityNet) })).sort((a, b) => a.idx - b.idx);
  if (!sorted.length) throw new ApiError(422, 'NO_TICKS', 'Snapshot has no initialized ticks');
  const above = sorted.filter((t) => t.idx > t0);
  const below = sorted.filter((t) => t.idx <= t0).reverse();
  const lo = below.length ? below[0].idx : sorted[0].idx;
  const hi = above.length ? above[0].idx : sorted[sorted.length - 1].idx;
  const raw = [{ tickLower: lo, tickUpper: hi, L: L0, current: true }];
  let L = L0;
  for (let i = 0; i < above.length - 1; i++) { L += above[i].net; raw.push({ tickLower: above[i].idx, tickUpper: above[i + 1].idx, L }); }
  L = L0;
  for (let i = 0; i < below.length - 1; i++) { L -= below[i].net; raw.unshift({ tickLower: below[i + 1].idx, tickUpper: below[i].idx, L }); }
  const segs = raw.map((s) => {
    const pA = tickToPrice(s.tickLower, pool), pB = tickToPrice(s.tickUpper, pool);
    return { tickLower: s.tickLower, tickUpper: s.tickUpper, Lraw: s.L.toString(), L: fromRawLiquidity(Number(s.L), pool), priceLow: Math.min(pA, pB), priceHigh: Math.max(pA, pB), current: !!s.current, negative: s.L < 0n };
  });
  segs.sort((a, b) => a.priceLow - b.priceLow);
  return segs;
}

/** Fast lookup structure: L at any price (null outside the curve window). */
export function makeCurve(segs) {
  const lows = Float64Array.from(segs.map((s) => s.priceLow));
  const Ls = Float64Array.from(segs.map((s) => s.L));
  const minP = segs[0].priceLow, maxP = segs[segs.length - 1].priceHigh;
  function at(p) {
    if (p < minP || p >= maxP) return null;
    let lo = 0, hi = lows.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lows[mid] <= p) lo = mid; else hi = mid - 1; }
    return Ls[lo];
  }
  return { at, minP, maxP, segs };
}

/** Log-spaced bars for charting: tick-weighted average L in each bar. */
export function liquidityBars(segs, center, halfWidthPct = 25, n = 100) {
  const lo = center * (1 - halfWidthPct / 100), hi = center * (1 + halfWidthPct / 100);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const a = lo * Math.pow(hi / lo, i / n), b = lo * Math.pow(hi / lo, (i + 1) / n);
    let w = 0, acc = 0;
    for (const s of segs) {
      const x = Math.max(a, s.priceLow), y = Math.min(b, s.priceHigh);
      if (y > x) { const ww = Math.log(y / x); acc += s.L * ww; w += ww; }
    }
    bars.push({ priceLow: a, priceHigh: b, L: w > 0 ? acc / w : null });
  }
  return bars;
}

/** Tick-weighted average pool L across [a, b] (for "how crowded is my range"). */
export function averageL(segs, a, b) {
  let w = 0, acc = 0;
  for (const s of segs) {
    const x = Math.max(a, s.priceLow), y = Math.min(b, s.priceHigh);
    if (y > x) { const ww = Math.log(y / x); acc += s.L * ww; w += ww; }
  }
  return { L: w > 0 ? acc / w : null, coverage: w / Math.log(b / a) };
}
