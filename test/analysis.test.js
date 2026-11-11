import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analysisId, candleTimeInRange, simulatePaths, evaluateOnPaths, buildPosition, rollingTimeInRange } from '../engine/analysis.js';
import { normalizeInputs } from '../engine/validate.js';
import { alignRange } from '../engine/v3math.js';
import { sealSnapshot, completeDays } from '../engine/snapshot.js';
import { sealed, synthetic, POOL } from './helpers.js';

const SNAP = sealed();
const base = { capitalUsd: 10000, rangeWidthPct: 5, simulations: 400 };

test('same snapshot + inputs → identical result hash', () => {
  const a = analyze(SNAP, base), b = analyze(SNAP, { ...base });
  assert.equal(a.resultHash, b.resultHash);
  assert.notEqual(a.resultHash, analyze(SNAP, { ...base, seed: 7 }).resultHash);
  assert.notEqual(a.resultHash, analyze(SNAP, { ...base, liquidityMode: 'static' }).resultHash);
});

test('analysis id ignores explicit defaults', () => {
  assert.equal(analysisId(SNAP.id, normalizeInputs(base)), analysisId(SNAP.id, normalizeInputs({ ...base, seed: 42, liquidityMode: 'follow', volumePolicy: '30d' })));
});

test('follow-mode fee rate = volume × 0.05% × L/(L0+L)', () => {
  const { result: r } = analyze(SNAP, base);
  const L = r.position.liquidity, L0 = r.market.activeLiquidity.value;
  const expect = r.market.volume.value * 0.0005 * L / (L0 + L);
  assert.ok(Math.abs(r.fees.dailyInRange.follow - expect) / expect < 1e-9);
  assert.ok(Math.abs(r.position.shareNow - L / (L0 + L)) < 1e-12);
  assert.ok(Math.abs(r.fees.aprInRange.follow - expect * 365 / 10000) < 1e-9);
});

test('static mode reads the liquidity map: a crowded range earns less than follow', () => {
  // $2,000–$2,030 sits in the crowded band (pool L ≈ 1.4e7 > active 1.06e7)
  const { result: r } = analyze(SNAP, { capitalUsd: 10000, rangeLower: 2000, rangeUpper: 2030, simulations: 400, liquidityMode: 'static' });
  assert.ok(r.liquidity.crowdingVsActive > 1.2);
  assert.ok(r.fees.dailyInRange.static < r.fees.dailyInRange.follow * 0.9);
});

test('wider ranges: lower share and in-range APR, more time in range', () => {
  const { result: r } = analyze(SNAP, { ...base, compareWidthsPct: [2, 10, 30] });
  const [, a, b, c] = r.comparison.rows;
  assert.ok(a.shareNow > b.shareNow && b.shareNow > c.shareNow);
  assert.ok(a.aprInRange > b.aprInRange && b.aprInRange > c.aprInRange);
  assert.ok(a.meanTimeInRange < b.meanTimeInRange && b.meanTimeInRange < c.meanTimeInRange);
});

test('model time in range agrees with the rolling historical replay', () => {
  const { result: r } = analyze(SNAP, { ...base, simulations: 1500, compareWidthsPct: [5, 10, 20] });
  for (const row of r.comparison.rows.slice(1)) assert.ok(Math.abs(row.meanTimeInRange - row.historyTimeInRange) < 0.12, `±${row.widthPct}%: model ${row.meanTimeInRange} vs history ${row.historyTimeInRange}`);
});

test('zero volatility: never exits, fees exact, no IL', () => {
  const sim = simulatePaths({ P0: 2000, sigma: 1e-12, mu: 0, days: 10, stepsPerDay: 2, n: 20, seed: 1 });
  const range = alignRange(1800, 2200, POOL);
  const L0 = 2e6, Lstatic = new Float64Array(sim.paths.length).fill(L0);
  const ev = evaluateOnPaths(sim, { P0: 2000, capital: 1e4, L0, Lstatic, volume: 1e7, fee: 0.0005, gasUsd: 0, stepsPerDay: 2, pool: POOL, mode: 'follow' }, range);
  const pos = buildPosition(1e4, 2000, range, L0, POOL);
  assert.equal(ev.meanTimeInRange, 1); assert.equal(ev.probEndInRange, 1);
  assert.ok(Math.abs(ev.fees.mean - 1e7 * 0.0005 * pos.shareNow * 10) < 1e-6);
  assert.ok(Math.abs(ev.feesStatic.mean - ev.feesFollow.mean) < 1e-9, 'flat map: modes agree');
  assert.ok(Math.abs(ev.il.mean) < 1e-9);
});

test('replay uses observed daily volume', () => {
  const { result: r } = analyze(SNAP, base);
  const bt = r.backtest, L = buildPosition(10000, bt.entryPrice, alignRange(bt.range.lower, bt.range.upper, POOL), r.market.activeLiquidity.value, POOL);
  const days = completeDays(SNAP).slice(-30);
  let fees = 0; days.forEach((d) => { fees += d.volumeUsd * 0.0005 * L.shareNow * candleTimeInRange(d, bt.range.lower, bt.range.upper); });
  assert.ok(Math.abs(bt.feesUsd - fees) / Math.max(1, fees) < 1e-6);
  assert.equal(bt.days, 30); assert.equal(bt.to, '2026-11-10');
});

test('rolling time in range: a huge range is always in range', () => {
  const r = rollingTimeInRange(completeDays(SNAP), 0.1, 10, 30);
  assert.equal(r.mean, 1); assert.ok(r.windows > 50);
});

test('candle overlap model', () => {
  assert.equal(candleTimeInRange({ low: 10, high: 20, close: 15 }, 0, 100), 1);
  assert.equal(candleTimeInRange({ low: 10, high: 20, close: 15 }, 15, 40), 0.5);
  assert.equal(candleTimeInRange({ low: 10, high: 20, close: 15 }, 30, 40), 0);
});

test('deposit sums to capital; bounds hold the documented asset', () => {
  const { result: r } = analyze(SNAP, base);
  const P = r.position.entryPrice.value;
  assert.ok(Math.abs(r.position.amounts.weth * P + r.position.amounts.usdc - 10000) < 1e-6);
  assert.ok(r.risk.atLower.ilPct < 0 && r.risk.atUpper.ilPct < 0);
  assert.equal(r.position.range.tickLower % 10, 0);
});

test('warnings: out of range, what-if, large share, gas', () => {
  const w = (i) => analyze(SNAP, { simulations: 100, ...i }).result.warnings.map((x) => x.code);
  assert.ok(w({ capitalUsd: 1e4, rangeLower: 2200, rangeUpper: 2400 }).includes('ENTRY_OUT_OF_RANGE'));
  assert.ok(w({ capitalUsd: 1e4, rangeWidthPct: 5, entryPrice: 2100 }).includes('WHAT_IF_ENTRY'));
  assert.ok(w({ capitalUsd: 5e8, rangeWidthPct: 1 }).includes('LARGE_SHARE'));
  assert.ok(w({ capitalUsd: 1000, rangeWidthPct: 5, gasUsd: 50 }).includes('GAS_HEAVY'));
});

test('input validation failure cases', () => {
  const bad = (i, field) => assert.throws(() => normalizeInputs(i), (e) => e.code === 'INVALID_INPUTS' && e.details.problems.some((p) => p.field === field), field);
  bad({}, 'capitalUsd');
  bad({ capitalUsd: 0, rangeWidthPct: 5 }, 'capitalUsd');
  bad({ capitalUsd: 100 }, 'rangeLower');
  bad({ capitalUsd: 100, rangeLower: 2100, rangeUpper: 2000 }, 'rangeUpper');
  bad({ capitalUsd: 100, rangeWidthPct: 5, rangeLower: 1, rangeUpper: 2 }, 'rangeWidthPct');
  bad({ capitalUsd: 100, rangeWidthPct: 5, volumePolicy: 'median' }, 'volumePolicy');
  bad({ capitalUsd: 100, rangeWidthPct: 5, liquidityMode: 'magic' }, 'liquidityMode');
  bad({ capitalUsd: 100, rangeWidthPct: 5, horizonDays: 0.5 }, 'horizonDays');
  bad({ capitalUsd: 100, rangeWidthPct: 5, simulations: 10 }, 'simulations');
  bad({ capitalUsd: 100, rangeWidthPct: 5, hack: 1 }, 'hack');
  assert.throws(() => analyze(SNAP, { capitalUsd: 1e4, rangeLower: 2060, rangeUpper: 2060.1 }), (e) => e.code === 'RANGE_TOO_NARROW');
});

test('refuses a tampered snapshot', () => {
  const t = sealed(); t.state.liquidity = '1';
  assert.throws(() => analyze(t, base), (e) => e.code === 'SNAPSHOT_HASH_MISMATCH');
});

test('works on a synthetic snapshot (no real-data coupling)', () => {
  const s = sealSnapshot(synthetic());
  const { result } = analyze(s, { capitalUsd: 1000, rangeWidthPct: 3, simulations: 100 });
  assert.equal(result.market.activeLiquidity.value, 1.3e6);
});

test('break-even volume: feeding it back zeroes the expected result vs holding', () => {
  const { result: r } = analyze(SNAP, base);
  const be = r.breakEven;
  assert.ok(be.multiple > 1, 'currently loses to holding, so break-even volume is above today');
  const { result: r2 } = analyze(SNAP, { ...base, volumeUsdOverride: be.volumeUsd });
  assert.ok(Math.abs(r2.simulation.vsHodl.mean) < 1e-6 * 10000, `vs hold at break-even = ${r2.simulation.vsHodl.mean}`);
  for (const row of r.comparison.rows) assert.ok(row.breakEven.volumeUsd === null || row.breakEven.volumeUsd >= 0);
});

test('ETH exposure: matches deposit now, 100% WETH at lower edge, 0% at upper', () => {
  const { result: r } = analyze(SNAP, base);
  const e = r.exposure;
  assert.ok(Math.abs(e.now.weth - r.position.amounts.weth) < 1e-9);
  assert.ok(Math.abs(e.atLower.pctOfPosition - 1) < 1e-9);
  assert.ok(Math.abs(e.atUpper.pctOfPosition) < 1e-9);
  assert.ok(e.atLower.weth > e.now.weth, 'falling price adds ETH exposure');
});

test('scenarios: flat price earns full fees with no loss; moves past an edge cut time in range', () => {
  const { result: r } = analyze(SNAP, base);
  const s = r.scenarios.rows, flat = s.find((x) => x.move === 0);
  assert.equal(flat.timeInRange, 1);
  assert.ok(Math.abs(flat.fees - r.fees.dailyInRange.follow * 30) < 1e-6);
  assert.ok(Math.abs(flat.lpValue - flat.hodlValue) < 1e-6);
  const down30 = s.find((x) => x.move === -0.3);
  assert.ok(down30.timeInRange < 0.2 && down30.vsHodl < flat.vsHodl);
});
