import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTiers } from '../engine/tiers.js';
import { sealSnapshot, deriveMarket } from '../engine/snapshot.js';
import { createRouter } from '../api/router.js';
import { MemoryStorage } from '../api/memory-storage.js';
import { synthetic, sealed } from './helpers.js';

const ADDR = { 1: '0xe0554a476a092703abdb3ef35c80e0d76d32939f', 5: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', 30: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8' };
const SPACING = { 1: 1, 5: 10, 30: 60 };
/** Same liquidity and volume in every tier, so only the fee rate and tick grid differ. */
function tier(bp, { capturedAt = '2026-11-11T00:00:00.000Z', volumeUsd = 4e7 } = {}) {
  const s = synthetic({ ticks: [{ tickIdx: 197100, liquidityNet: '500000000000000000' }, { tickIdx: 199500, liquidityNet: '800000000000000000' }, { tickIdx: 200040, liquidityNet: '-300000000000000000' }, { tickIdx: 202020, liquidityNet: '-500000000000000000' }] });
  s.pool = { ...s.pool, address: ADDR[bp], feeTier: bp / 1e4, tickSpacing: SPACING[bp] };
  s.capturedAt = capturedAt;
  s.history = s.history.map((d) => ({ ...d, volumeUsd }));
  return sealSnapshot(s);
}
const INPUTS = { capitalUsd: 10000, rangeWidthPct: 5, simulations: 300 };

test('same liquidity and volume: fees scale with the fee tier; ranges snap to each grid', () => {
  const { result } = compareTiers(tier(5), [tier(1), tier(30)], INPUTS);
  const [t1, t5, t30] = result.rows;
  assert.deepEqual(result.rows.map((r) => r.tierBp), [1, 5, 30], 'sorted by tier');
  assert.ok(t5.base && !t1.base && !t30.base);
  assert.ok(Math.abs(t30.poolFeesPerDay / t5.poolFeesPerDay - 6) < 1e-9);
  assert.ok(Math.abs(t5.poolFeesPerDay / t1.poolFeesPerDay - 5) < 1e-9);
  const r = t30.expectedFees / t5.expectedFees;
  assert.ok(r > 5.3 && r < 6.7, `30 bp vs 5 bp fees ratio ${r}`);
  assert.equal(t30.range.tickLower % 60, 0);
  assert.equal(t5.range.tickLower % 10, 0);
  assert.ok(Math.abs(t1.timeInRange - t5.timeInRange) < 0.05, 'shared volatility and seed → similar time in range');
});

test('identical copies of one tier are rejected; different pairs are rejected', () => {
  assert.throws(() => compareTiers(tier(5), [tier(5, { capturedAt: '2026-11-11T00:00:01.000Z' })], INPUTS), (e) => e.code === 'TIER_DUPLICATE');
  const other = synthetic(); other.pool = { ...other.pool, token0: { symbol: 'USDT', decimals: 6 } };
  assert.throws(() => compareTiers(tier(5), [sealSnapshot(other)], INPUTS), (e) => e.code === 'TIER_PAIR_MISMATCH');
});

test('warnings: non-simultaneous snapshots, thin pool that looks too good', () => {
  const { result } = compareTiers(tier(5), [tier(30, { capturedAt: '2026-11-11T05:00:00.000Z' })], INPUTS);
  assert.ok(result.warnings.some((w) => w.code === 'TIER_SNAPSHOTS_NOT_SIMULTANEOUS'));
});

test('median volume policy and lumpy-volume warning', () => {
  const s = synthetic();
  s.history = s.history.map((d, i) => ({ ...d, volumeUsd: i === s.history.length - 2 ? 1e9 : 1e7 }));
  const m = deriveMarket(sealSnapshot(s), { volumePolicy: 'median30d' });
  assert.equal(m.volume.value, 1e7);
  assert.ok(m.warnings.some((w) => w.code === 'VOLUME_LUMPY'));
});

test('API: /api/tiers uses the newest snapshot per tier; "latest" stays on the 0.05% pool', async () => {
  const storage = new MemoryStorage({ snapshots: [sealed(), tier(30, { capturedAt: '2026-11-12T00:00:00.000Z' }), tier(1, { capturedAt: '2026-11-12T00:00:00.000Z' })] });
  const h = createRouter({ storage });
  const a = await h({ method: 'POST', path: '/api/analyze', body: { snapshotId: 'latest', inputs: INPUTS } });
  assert.equal(a.body.result.snapshot.id, sealed().id, '"latest" = newest 0.05% snapshot, not the newer 0.30% one');
  const t = await h({ method: 'POST', path: '/api/tiers', body: { snapshotId: 'latest', inputs: INPUTS } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(t.body.result.rows.map((r) => r.tierBp), [1, 5, 30]);
  assert.ok(t.body.result.warnings.some((w) => w.code === 'TIER_SNAPSHOTS_NOT_SIMULTANEOUS'));
  const bad = await h({ method: 'POST', path: '/api/tiers', body: { snapshotId: 'latest', compareSnapshotIds: ['snap_0000000000000000'], inputs: INPUTS } });
  assert.equal(bad.status, 404);
});
