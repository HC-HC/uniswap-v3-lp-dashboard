// Input schema, defaults and validation for analysis requests. All problems are reported at once.
import { ApiError } from './errors.js';

export const INPUT_DEFAULTS = Object.freeze({
  horizonDays: 30,
  volumePolicy: '30d',
  volWindowDays: 90,
  liquidityMode: 'follow',
  driftAnnual: 0,
  gasUsd: 20,
  simulations: 2000,
  seed: 42,
  stepsPerDay: 4,
  compareWidthsPct: [1, 2, 5, 10, 15, 20, 30],
});

export const INPUT_SCHEMA = {
  capitalUsd: { type: 'number', required: true, min: 1, max: 1e9, doc: 'Capital to deploy, in USD (USDC).' },
  rangeLower: { type: 'number', min: 1e-9, doc: 'Lower bound, USDC per WETH. Required unless rangeWidthPct is set.' },
  rangeUpper: { type: 'number', min: 1e-9, doc: 'Upper bound, USDC per WETH. Required unless rangeWidthPct is set.' },
  rangeWidthPct: { type: 'number', min: 0.1, max: 95, doc: 'Alternative to explicit bounds: symmetric ±% around the entry price.' },
  entryPrice: { type: 'number', min: 1e-9, doc: 'Entry price for what-if analysis. Defaults to the snapshot spot price.' },
  horizonDays: { type: 'integer', min: 1, max: 365, doc: 'Holding period for the forward simulation.' },
  volumePolicy: { type: 'string', pattern: /^(7d|30d|90d|median30d|24h)$/, doc: 'Daily volume basis: mean of last 7/30/90 complete days, median of last 30, or the latest 24h figure.' },
  volWindowDays: { type: 'integer', min: 7, max: 90, doc: 'Window (days) for realized volatility.' },
  liquidityMode: { type: 'string', pattern: /^(follow|static)$/, doc: "Headline fee model. 'follow': other LPs' crowding moves with price (pool L stays at today's active L). 'static': today's liquidity map stays put." },
  volumeUsdOverride: { type: 'number', min: 0, max: 1e12, doc: 'Daily pool volume, in USD, to assume instead of the observed values.' },
  volatilityOverride: { type: 'number', min: 0.01, max: 5, doc: 'Annualized volatility (0.6 = 60%).' },
  driftAnnual: { type: 'number', min: -5, max: 5, doc: 'Annualized drift of the price (expected return); 0 means no directional view.' },
  gasUsd: { type: 'number', min: 0, max: 1e6, doc: 'Total gas for mint, collect and burn, in USD.' },
  simulations: { type: 'integer', min: 100, max: 20000, doc: 'Number of Monte Carlo paths.' },
  seed: { type: 'integer', min: 0, max: 4294967295, doc: 'PRNG seed; the same seed gives identical results.' },
  stepsPerDay: { type: 'integer', min: 1, max: 48, doc: 'Simulation sub-steps per day; more steps detect range exits more accurately.' },
  compareWidthsPct: { type: 'array', items: { type: 'number', min: 0.1, max: 95 }, maxItems: 12, doc: 'Symmetric widths (±%) to compare against.' },
};

function checkScalar(name, v, spec, errs) {
  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return errs.push({ field: name, message: 'must be a finite number' });
    if (spec.type === 'integer' && !Number.isInteger(v)) return errs.push({ field: name, message: 'must be an integer' });
    if (spec.min !== undefined && v < spec.min) return errs.push({ field: name, message: `must be ≥ ${spec.min}` });
    if (spec.max !== undefined && v > spec.max) return errs.push({ field: name, message: `must be ≤ ${spec.max}` });
  } else if (spec.type === 'string') {
    if (typeof v !== 'string') return errs.push({ field: name, message: 'must be a string' });
    if (spec.pattern && !spec.pattern.test(v)) return errs.push({ field: name, message: `has invalid format (${spec.pattern})` });
  }
  return null;
}

/** Validate raw inputs and fill defaults. Throws a 422 ApiError listing every problem. */
export function normalizeInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(422, 'INVALID_INPUTS', 'inputs must be a JSON object', { problems: [{ field: 'inputs', message: 'not an object' }] });
  }
  const errs = [];
  const unknown = Object.keys(raw).filter((k) => !(k in INPUT_SCHEMA));
  for (const k of unknown) errs.push({ field: k, message: 'unknown field' });
  const out = { ...INPUT_DEFAULTS, compareWidthsPct: [...INPUT_DEFAULTS.compareWidthsPct] };
  for (const [name, spec] of Object.entries(INPUT_SCHEMA)) {
    const v = raw[name];
    if (v === undefined || v === null) {
      if (spec.required) errs.push({ field: name, message: 'is required' });
      continue;
    }
    if (spec.type === 'array') {
      if (!Array.isArray(v)) { errs.push({ field: name, message: 'must be an array' }); continue; }
      if (v.length > spec.maxItems) { errs.push({ field: name, message: `at most ${spec.maxItems} items` }); continue; }
      v.forEach((item, i) => checkScalar(`${name}[${i}]`, item, spec.items, errs));
      out[name] = [...v];
      continue;
    }
    checkScalar(name, v, spec, errs);
    out[name] = v;
  }
  const hasBounds = out.rangeLower !== undefined || out.rangeUpper !== undefined;
  if (hasBounds && out.rangeWidthPct !== undefined) errs.push({ field: 'rangeWidthPct', message: 'give either rangeLower/rangeUpper or rangeWidthPct, not both' });
  if (!hasBounds && out.rangeWidthPct === undefined) errs.push({ field: 'rangeLower', message: 'rangeLower and rangeUpper (or rangeWidthPct) are required' });
  if (hasBounds) {
    if (out.rangeLower === undefined) errs.push({ field: 'rangeLower', message: 'is required when rangeUpper is given' });
    if (out.rangeUpper === undefined) errs.push({ field: 'rangeUpper', message: 'is required when rangeLower is given' });
    if (out.rangeLower !== undefined && out.rangeUpper !== undefined && !(out.rangeUpper > out.rangeLower)) {
      errs.push({ field: 'rangeUpper', message: 'must be greater than rangeLower' });
    }
  }
  if (errs.length) throw new ApiError(422, 'INVALID_INPUTS', `Invalid inputs (${errs.length} problem${errs.length > 1 ? 's' : ''})`, { problems: errs });
  return out;
}
