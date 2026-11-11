import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments, makeCurve, liquidityBars, averageL } from '../engine/curve.js';
import { normalizePool } from '../engine/snapshot.js';
import { amountsForLiquidity } from '../engine/v3math.js';
import { synthetic, rawSnapshot } from './helpers.js';

const pool = normalizePool(synthetic().pool);

test('synthetic curve: exact L per segment', () => {
  const s = synthetic();
  const segs = buildSegments(s.state, s.ticks, pool);
  const byTick = Object.fromEntries(segs.map((x) => [`${x.tickLower}-${x.tickUpper}`, x.Lraw]));
  assert.deepEqual(byTick, {
    '197100-199500': '500000000000000000',  // below the current segment: 1.3e18 − 0.8e18
    '199500-200010': '1300000000000000000', // current segment = liquidity()
    '200010-202000': '1000000000000000000', // 1.3e18 + (−0.3e18)
  });
  assert.ok(segs.every((x, i) => i === 0 || x.priceLow >= segs[i - 1].priceLow), 'sorted by price');
  assert.ok(segs.find((x) => x.current).L === 1.3e6, 'human L = raw / 1e12');
});

test('curve lookup, bars and range average', () => {
  const s = synthetic();
  const segs = buildSegments(s.state, s.ticks, pool);
  const c = makeCurve(segs);
  assert.equal(c.at(s.state.price), 1.3e6);
  assert.equal(c.at(1e12 / Math.pow(1.0001, 201000)), 1.0e6);
  assert.equal(c.at(1), null, 'outside the window');
  const bars = liquidityBars(segs, s.state.price, 10, 20);
  assert.equal(bars.length, 20);
  const a = averageL(segs, segs[1].priceLow, segs[1].priceHigh);
  assert.ok(Math.abs(a.L - 1.3e6) < 1e-6 && Math.abs(a.coverage - 1) < 1e-9);
});

test('inconsistent ticks are flagged as negative liquidity', () => {
  const s = synthetic({ ticks: [{ tickIdx: 200010, liquidityNet: '-300000000000000000' }, { tickIdx: 200100, liquidityNet: '-5000000000000000000' }, { tickIdx: 200300, liquidityNet: '0' }, { tickIdx: 199000, liquidityNet: '1300000000000000000' }] });
  assert.ok(buildSegments(s.state, s.ticks, pool).some((x) => x.negative));
});

test('no ticks → 422', () => {
  const s = synthetic({ ticks: [] });
  assert.throws(() => buildSegments(s.state, s.ticks, pool), (e) => e.code === 'NO_TICKS');
});

test('real snapshot: curve is consistent with on-chain state', () => {
  const s = rawSnapshot();
  const p = normalizePool(s.pool);
  const segs = buildSegments(s.state, s.ticks, p);
  const cur = segs.find((x) => x.current);
  assert.equal(cur.Lraw, s.state.liquidity, 'current segment equals liquidity()');
  assert.ok(s.state.price >= cur.priceLow && s.state.price <= cur.priceHigh, 'spot inside current segment');
  assert.ok(segs.every((x) => !x.negative), 'never negative');
  let usd = 0;
  for (const x of segs) { const a = amountsForLiquidity(x.L, s.state.price, x.priceLow, x.priceHigh); usd += a.x * s.state.price + a.y; }
  assert.ok(usd <= s.market.tvlUsd, `liquidity in window ($${(usd / 1e6).toFixed(1)}M) ≤ TVL`);
  const c = makeCurve(segs);
  assert.ok(c.at(2015) > c.at(2100) * 1.2, 'crowding around $2,000–2,030 exceeds the band above price');
});
