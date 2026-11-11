// Small deterministic statistics toolkit.

/** mulberry32: fast, seedable 32-bit PRNG. Same seed => same stream in every JS engine. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller (uses two uniforms per draw; deterministic). */
export function makeNormal(rng) {
  return function normal() {
    let u = rng();
    if (u < 1e-12) u = 1e-12;
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). */
export function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Quantile with linear interpolation on a pre-sorted ascending array. */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values) {
  const s = Float64Array.from(values).sort();
  return {
    mean: mean(s),
    p5: quantileSorted(s, 0.05),
    p25: quantileSorted(s, 0.25),
    p50: quantileSorted(s, 0.5),
    p75: quantileSorted(s, 0.75),
    p95: quantileSorted(s, 0.95),
    min: s[0],
    max: s[s.length - 1],
  };
}

export function histogram(values, bins = 30) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (min === max) { min -= 1; max += 1; }
  const w = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - min) / w))]++;
  return counts.map((c, i) => ({ from: min + i * w, to: min + (i + 1) * w, count: c }));
}

export function median(xs) {
  return quantileSorted(Float64Array.from(xs).sort(), 0.5);
}
