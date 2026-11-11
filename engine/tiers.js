// Fee-tier comparison: the same price range, analysed in each WETH/USDC pool (1, 5, 30, 100 bp).
// Each pool uses its OWN on-chain liquidity map, its own volume history and its own tick grid.
// For a fair comparison every pool shares the base pool's volatility and the same seed, so the
// simulated price paths are (near-)identical; only pool-specific economics differ.
import { ApiError } from './errors.js';
import { contentHash } from './sha256.js';
import { analyze, roundDeep, ENGINE_VERSION } from './analysis.js';
import { normalizeInputs } from './validate.js';

const pairKey = (s) => `${s.pool.chain}:${s.pool.token0.symbol}/${s.pool.token1.symbol}`;

export function compareTiers(base, others, rawInputs) {
  const inputs = normalizeInputs(rawInputs);
  const all = [base, ...others.filter((o) => o.id !== base.id)];
  const key = pairKey(base);
  for (const s of all) if (pairKey(s) !== key) throw new ApiError(422, 'TIER_PAIR_MISMATCH', `Snapshot ${s.id} is ${pairKey(s)}, not ${key}`);
  const seen = new Set();
  for (const s of all) {
    if (seen.has(s.pool.feeTier)) throw new ApiError(422, 'TIER_DUPLICATE', `Two snapshots for the ${s.pool.feeTier * 100}% tier; pass one per tier`);
    seen.add(s.pool.feeTier);
  }

  const { result: b } = analyze(base, { ...rawInputs, compareWidthsPct: [] });
  const sigma = b.market.volatility.annual;
  const lower = b.position.requestedRange.lower, upper = b.position.requestedRange.upper;
  const shared = { ...rawInputs, compareWidthsPct: [], rangeLower: lower, rangeUpper: upper, volatilityOverride: inputs.volatilityOverride ?? sigma };
  delete shared.rangeWidthPct;
  delete shared.entryPrice;

  const warnings = [];
  const times = all.map((s) => Date.parse(s.capturedAt));
  const spreadH = (Math.max(...times) - Math.min(...times)) / 3600000;
  if (spreadH > 1) warnings.push({ code: 'TIER_SNAPSHOTS_NOT_SIMULTANEOUS', message: `Tier snapshots were captured up to ${spreadH.toFixed(1)}h apart; prices and liquidity may have moved between them.` });

  const rows = all.map((s) => {
    const { result: r } = analyze(s, shared);
    const mode = r.inputs.liquidityMode;
    const alts = Object.fromEntries((r.market.volume.alternatives || []).map((a) => [a.label, a.value]));
    const vMed = alts['30-day median'], vUsed = r.market.volume.value;
    const feesAtMedian = vMed && vUsed ? r.fees.expected[mode] * vMed / vUsed : null;
    if (r.position.status !== 'in-range') warnings.push({ code: 'TIER_OUT_OF_RANGE', message: `${s.pool.feeTier * 100}% pool: range is ${r.position.status} at this pool's price.` });
    return {
      tierBp: Math.round(s.pool.feeTier * 1e4), feeTier: s.pool.feeTier, tickSpacing: s.pool.tickSpacing,
      address: s.pool.address, snapshotId: s.id, block: s.state.block, capturedAt: s.capturedAt,
      spot: r.market.spot.value, tvlUsd: r.market.tvl.value, volumeUsd: r.market.volume.value,
      poolFeesPerDay: r.fees.poolDailyFeesUsd, poolFeeAprOnTvl: r.fees.poolFeeAprOnTvl,
      activeL: r.market.activeLiquidity.value,
      range: { lower: r.position.range.lower, upper: r.position.range.upper, tickLower: r.position.range.tickLower, tickUpper: r.position.range.tickUpper },
      shareNow: r.position.shareNow,
      dailyFeesInRange: r.fees.dailyInRange[mode] ?? r.fees.dailyInRange.follow,
      expectedFees: r.fees.expected[mode], expectedFeeApr: r.fees.expectedApr[mode],
      timeInRange: r.simulation.meanTimeInRange,
      edgeLoss: Math.min(r.risk.atLower.ilUsd, r.risk.atUpper.ilUsd),
      netVsHold: r.simulation.vsHodl.mean, probBeatHodl: r.simulation.probBeatHodl,
      breakEvenVolumeUsd: r.breakEven.volumeUsd, breakEvenMultiple: r.breakEven.multiple,
      volumeMedian30: vMed ?? null, volumeLumpiness: vMed ? vUsed / vMed : null,
      expectedFeesAtMedianVolume: feesAtMedian, netVsHoldAtMedianVolume: feesAtMedian === null ? null : r.simulation.vsHodl.mean - r.fees.expected[mode] + feesAtMedian,
      feesPerActiveLPerDay: r.fees.poolDailyFeesUsd / r.market.activeLiquidity.value,
      base: s.id === base.id,
    };
  }).sort((x, y) => x.feeTier - y.feeTier);

  const baseRow = rows.find((r) => r.base);
  for (const r of rows) {
    if (r.base) continue;
    if (r.volumeLumpiness > 1.5) warnings.push({ code: 'TIER_LUMPY_VOLUME', message: `${r.feeTier * 100}% pool: volume is lumpy (mean ${r.volumeLumpiness.toFixed(1)}× the median); see the median-volume result.` });
    if (r.netVsHold > 0 && baseRow.netVsHold <= 0) warnings.push({ code: 'TIER_TOO_GOOD', message: `${r.feeTier * 100}% pool looks better than ${baseRow.feeTier * 100}% because its active liquidity is ${(baseRow.activeL / r.activeL).toFixed(0)}× thinner. Treat with caution: one snapshot can't see just-in-time liquidity bots add around big swaps, and thin pools can attract new LPs quickly.` });
  }

  const result = roundDeep({
    engineVersion: ENGINE_VERSION, kind: 'estimated',
    basis: `same price range ($${lower.toFixed(2)}–$${upper.toFixed(2)}), snapped to each pool's tick grid; each pool's own liquidity map and ${inputs.volumePolicy} volume; shared volatility ${(sigma * 100).toFixed(1)}% and seed ${inputs.seed}`,
    inputs, baseSnapshotId: base.id, sharedVolatility: sigma, rows, warnings,
  });
  return { result, resultHash: contentHash(result) };
}
