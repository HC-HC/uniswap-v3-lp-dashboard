// Snapshot validation, content addressing, and derivation of market inputs with provenance.
// A snapshot is the raw capture written by scripts/fetch-snapshot.mjs (on-chain state + ticks via JSON-RPC,
// market + daily history via GeckoTerminal), sealed with a content hash.
// Provenance tags:
//   observed  – published by a named source at a stated time/block (copied, not modelled)
//   derived   – deterministic arithmetic on observed values (curve, means, realized volatility)
//   estimated – rests on a model assumption (fees, simulation)
//   assumed   – supplied by the user or a default with no data behind it
import { ApiError } from './errors.js';
import { contentHash } from './sha256.js';
import { fromRawLiquidity } from './v3math.js';
import { buildSegments } from './curve.js';
import { logReturns, stdev, mean } from './stats.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Pool metadata with `base` filled in: the WETH side is the base asset whose price is quoted in USDC. */
export function normalizePool(pool) {
  if (pool.base === 'token0' || pool.base === 'token1') return pool;
  const base = /^W?ETH$/i.test(pool.token1?.symbol || '') ? 'token1' : 'token0';
  return { ...pool, base };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isIntStr = (v, signed) => typeof v === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(v);

export function validateSnapshot(s) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ApiError(422, 'SNAPSHOT_INVALID', 'Snapshot must be a JSON object', { problems: ['not an object'] });
  need(s.schemaVersion === SNAPSHOT_SCHEMA_VERSION, `schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  need(isIso(s.capturedAt), 'capturedAt must be an ISO timestamp');
  const p = s.pool || {};
  need(typeof p.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(p.address), 'pool.address must be a 20-byte hex address');
  need(isPos(p.feeTier) && p.feeTier < 0.1, 'pool.feeTier must be a fraction such as 0.0005');
  need(Number.isInteger(p.tickSpacing) && p.tickSpacing > 0, 'pool.tickSpacing must be a positive integer');
  for (const t of ['token0', 'token1']) need(p[t] && Number.isInteger(p[t].decimals), `pool.${t}.decimals must be an integer`);
  const st = s.state || {};
  need(Number.isInteger(st.tick), 'state.tick must be an integer');
  need(isIntStr(st.liquidity) && BigInt(st.liquidity) > 0n, 'state.liquidity must be a positive integer string');
  need(isPos(st.price), 'state.price must be > 0');
  need(Number.isInteger(st.block) && st.block > 0, 'state.block must be a block number');
  need(Array.isArray(s.ticks) && s.ticks.length > 0, 'ticks must be a non-empty array');
  (s.ticks || []).forEach((t, i) => {
    if (i > 2000) return;
    need(Number.isInteger(Number(t.tickIdx)) && Number(t.tickIdx) % (p.tickSpacing || 1) === 0, `ticks[${i}].tickIdx must be a multiple of tickSpacing`);
    need(isIntStr(String(t.liquidityNet), true), `ticks[${i}].liquidityNet must be an integer string`);
  });
  const m = s.market || {};
  need(isPos(m.tvlUsd), 'market.tvlUsd must be > 0');
  need(isNum(m.volume24hUsd) && m.volume24hUsd >= 0, 'market.volume24hUsd must be ≥ 0');
  need(Array.isArray(s.history), 'history must be an array');
  let prev = '';
  (s.history || []).forEach((d, i) => {
    const ok = isPos(d.open) && isPos(d.high) && isPos(d.low) && isPos(d.close) && d.high >= d.low - 1e-9;
    need(ok, `history[${i}] needs positive open/high/low/close with high ≥ low`);
    need(isNum(d.volumeUsd) && d.volumeUsd >= 0, `history[${i}].volumeUsd must be ≥ 0`);
    need(typeof d.date === 'string' && d.date > prev, `history[${i}].date must be strictly increasing`);
    prev = d.date;
  });
  need(s.sources && s.sources.rpc && s.sources.geckoterminal, 'sources.rpc and sources.geckoterminal are required');
  if (problems.length) throw new ApiError(422, 'SNAPSHOT_INVALID', `Snapshot failed validation (${problems.length} problem${problems.length > 1 ? 's' : ''})`, { problems });
  return true;
}

function stripSeal(s) { const { id, contentHash: _h, label: _l, ...rest } = s; return rest; }

export function sealSnapshot(s, label) {
  const body = stripSeal(s);
  validateSnapshot(body);
  const hash = contentHash(body);
  return { id: 'snap_' + hash.slice(0, 16), contentHash: hash, label: label || `WETH/USDC ${+(body.pool.feeTier * 100).toFixed(2)}% · block ${body.state.block} · ${body.capturedAt.slice(0, 16)}Z`, ...body };
}

export function verifySnapshot(s) {
  if (!s || typeof s.contentHash !== 'string') throw new ApiError(422, 'SNAPSHOT_UNSEALED', 'Snapshot has no contentHash');
  const hash = contentHash(stripSeal(s));
  if (hash !== s.contentHash || s.id !== 'snap_' + hash.slice(0, 16)) {
    throw new ApiError(409, 'SNAPSHOT_HASH_MISMATCH', 'Snapshot contents do not match their recorded hash; refusing to analyse it.', { expected: s.contentHash, actual: hash });
  }
  return true;
}

/** Daily candles excluding a partial day dated on the capture date. */
export function completeDays(snap) {
  const day = snap.capturedAt.slice(0, 10);
  return (snap.history || []).filter((d) => d.date < day);
}

export function realizedVol(days, window) {
  const sl = days.slice(-(window + 1));
  if (sl.length < 8) return null;
  const r = logReturns(sl.map((d) => d.close));
  const daily = stdev(r);
  return { daily, annual: daily * Math.sqrt(365), n: r.length, from: sl[0].date, to: sl[sl.length - 1].date };
}

export function deriveMarket(snap, opts = {}) {
  const warnings = [];
  const rpc = { source: 'rpc', sourceName: snap.sources.rpc.name, url: snap.sources.rpc.url, block: snap.state.block, observedAt: snap.capturedAt };
  const gt = { source: 'geckoterminal', sourceName: snap.sources.geckoterminal.name, url: snap.sources.geckoterminal.url, observedAt: snap.capturedAt };
  const days = completeDays(snap);
  const pool = normalizePool(snap.pool);

  const spot = { value: snap.state.price, kind: 'observed', method: 'slot0().sqrtPriceX96 read on-chain', ...rpc, alternatives: [{ value: snap.market.priceUsd, ...gt, note: 'GeckoTerminal WETH price (USD)' }] };
  const activeLiquidity = { value: fromRawLiquidity(Number(snap.state.liquidity), pool), raw: snap.state.liquidity, kind: 'observed', method: 'pool.liquidity() read on-chain', ...rpc };
  const segs = buildSegments(snap.state, snap.ticks, pool);
  const curve = { kind: 'derived', method: `active L rebuilt from ${snap.ticks.length} initialized ticks (liquidityNet) around the current tick`, ...rpc, minPrice: segs[0].priceLow, maxPrice: segs[segs.length - 1].priceHigh, segments: segs.length };
  if (segs.some((s) => s.negative)) warnings.push({ code: 'CURVE_NEGATIVE', message: 'Rebuilt liquidity goes negative somewhere: tick data is inconsistent.' });

  const meanVol = (n) => { const v = days.slice(-n).map((d) => d.volumeUsd); return v.length ? { value: mean(v), n: v.length } : null; };
  const medianVol = (n) => { const v = days.slice(-n).map((d) => d.volumeUsd).sort((a, b) => a - b); return v.length ? { value: v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2, n: v.length } : null; };
  let volume;
  const policy = opts.volumePolicy || '30d';
  if (isNum(opts.volumeUsdOverride)) volume = { value: opts.volumeUsdOverride, kind: 'assumed', method: 'user override' };
  else if (policy === '24h') volume = { value: snap.market.volume24hUsd, kind: 'observed', method: 'GeckoTerminal volume_usd.h24', ...gt };
  else if (policy === 'median30d') {
    const mv = medianVol(30);
    if (!mv) throw new ApiError(422, 'NO_VOLUME_HISTORY', 'Snapshot has no complete days of volume history');
    volume = { value: mv.value, kind: 'derived', method: `median daily pool volume, last ${mv.n} complete days`, ...gt };
  }
  else {
    const n = { '7d': 7, '30d': 30, '90d': 90 }[policy];
    if (!n) throw new ApiError(422, 'INVALID_POLICY', `volumePolicy must be 7d, 30d, 90d or 24h (got ${policy})`);
    const mv = meanVol(n);
    if (!mv) throw new ApiError(422, 'NO_VOLUME_HISTORY', 'Snapshot has no complete days of volume history');
    volume = { value: mv.value, kind: 'derived', method: `mean daily pool volume, last ${mv.n} complete days`, ...gt };
  }
  volume.alternatives = [
    { label: '7-day mean', value: meanVol(7)?.value }, { label: '30-day mean', value: meanVol(30)?.value },
    { label: '90-day mean', value: meanVol(90)?.value }, { label: '30-day median', value: medianVol(30)?.value }, { label: '24h (GeckoTerminal)', value: snap.market.volume24hUsd },
  ];
  const v30 = meanVol(30)?.value, m30 = medianVol(30)?.value;
  if (v30 && m30 && v30 / m30 > 1.5) warnings.push({ code: 'VOLUME_LUMPY', message: `Volume is lumpy: the 30-day mean ($${(v30 / 1e6).toFixed(1)}M) is ${(v30 / m30).toFixed(1)}× the median ($${(m30 / 1e6).toFixed(1)}M) because of a few very large days.` });
  if (v30 && snap.market.volume24hUsd / v30 > 2) warnings.push({ code: 'VOLUME_24H_SPIKE', message: `Latest 24h volume ($${(snap.market.volume24hUsd / 1e6).toFixed(0)}M) is ${(snap.market.volume24hUsd / v30).toFixed(1)}× the 30-day mean. Fee estimates use the ${policy === '24h' ? '24h figure' : 'mean'}.` });

  const windows = { d7: realizedVol(days, 7), d30: realizedVol(days, 30), d90: realizedVol(days, 90) };
  let volatility;
  if (isPos(opts.volatilityOverride)) volatility = { annual: opts.volatilityOverride, daily: opts.volatilityOverride / Math.sqrt(365), kind: 'assumed', method: 'user override', windows };
  else {
    const w = opts.volWindowDays || 90;
    const rv = realizedVol(days, w);
    if (!rv) throw new ApiError(422, 'INSUFFICIENT_HISTORY', `Need at least 8 complete days for volatility (have ${days.length}); pass volatilityOverride.`);
    volatility = { ...rv, kind: 'derived', method: `sample stdev of ${rv.n} daily log returns × √365`, ...gt, windows };
    if (rv.n < 60) warnings.push({ code: 'SHORT_VOL_WINDOW', message: `Volatility uses ${rv.n} daily returns; sampling error ≈ ±${Math.round(100 / Math.sqrt(2 * rv.n))}%.` });
  }

  return {
    pool,
    feeTier: { value: snap.pool.feeTier, kind: 'observed', method: 'fee() read on-chain = 500 (0.05%)', ...rpc },
    spot, activeLiquidity, curve, segs, volume, volatility,
    tvl: { value: snap.market.tvlUsd, kind: 'observed', method: 'GeckoTerminal reserve_in_usd', ...gt },
    history: { days: days.length, from: days[0]?.date, to: days[days.length - 1]?.date, ...gt },
    warnings,
  };
}
