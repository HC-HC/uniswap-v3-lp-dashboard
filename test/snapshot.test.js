import test from 'node:test';
import assert from 'node:assert/strict';
import { sealSnapshot, verifySnapshot, validateSnapshot, deriveMarket, completeDays, normalizePool } from '../engine/snapshot.js';
import { mean } from '../engine/stats.js';
import { rawSnapshot, sealed, storedSnapshots, synthetic } from './helpers.js';

test('sealing is deterministic and matches the stored snapshot', () => {
  const a = sealed(), b = sealed();
  assert.equal(a.id, b.id);
  assert.match(a.id, /^snap_[0-9a-f]{16}$/);
  assert.ok(storedSnapshots().some((s) => s.id === a.id && s.contentHash === a.contentHash));
});

test('tampering with any value is detected', () => {
  const s = sealed(); s.ticks[10].liquidityNet = '1';
  assert.throws(() => verifySnapshot(s), (e) => e.code === 'SNAPSHOT_HASH_MISMATCH' && e.status === 409);
  const t = sealed(); t.state.price = 3000;
  assert.throws(() => verifySnapshot(t), (e) => e.code === 'SNAPSHOT_HASH_MISMATCH');
  assert.throws(() => verifySnapshot(rawSnapshot()), (e) => e.code === 'SNAPSHOT_UNSEALED');
  const relabel = sealed(); relabel.label = 'renamed';
  assert.doesNotThrow(() => verifySnapshot(relabel), 'label is display-only and not hashed');
});

test('validation reports every problem', () => {
  const s = rawSnapshot();
  s.pool.address = '0x12'; s.state.liquidity = '12.5'; s.ticks[0].tickIdx = 197021; s.history[3].date = '2000-01-01'; delete s.sources.rpc; s.market.tvlUsd = -1;
  try { validateSnapshot(s); assert.fail('should throw'); } catch (e) {
    assert.equal(e.code, 'SNAPSHOT_INVALID');
    assert.ok(e.details.problems.length >= 6, JSON.stringify(e.details.problems));
  }
  assert.throws(() => sealSnapshot({ schemaVersion: 2 }), (e) => e.code === 'SNAPSHOT_INVALID');
  assert.throws(() => validateSnapshot([]), (e) => e.code === 'SNAPSHOT_INVALID');
});

test('normalizePool infers WETH as base', () => {
  assert.equal(normalizePool(rawSnapshot().pool).base, 'token1');
  assert.equal(normalizePool({ token0: { symbol: 'WETH' }, token1: { symbol: 'USDT' } }).base, 'token0');
});

test('deriveMarket: provenance and values from the real snapshot', () => {
  const snap = sealed(), m = deriveMarket(snap);
  assert.equal(m.spot.kind, 'observed'); assert.equal(m.spot.value, snap.state.price); assert.equal(m.spot.block, 26389083);
  assert.equal(m.activeLiquidity.kind, 'observed'); assert.ok(Math.abs(m.activeLiquidity.value - 10574976.554603412) < 1e-6);
  assert.equal(m.curve.kind, 'derived');
  const days = completeDays(snap);
  assert.equal(days[days.length - 1].date, '2026-11-10', 'partial capture-day candle excluded');
  assert.equal(m.volume.kind, 'derived');
  assert.ok(Math.abs(m.volume.value - mean(days.slice(-30).map((d) => d.volumeUsd))) < 1e-6);
  assert.equal(m.volatility.kind, 'derived'); assert.equal(m.volatility.n, 88);
  assert.ok(m.volatility.annual > 0.3 && m.volatility.annual < 1.2);
  assert.ok(m.warnings.some((w) => w.code === 'VOLUME_24H_SPIKE'));
});

test('deriveMarket: policies and overrides', () => {
  const snap = sealed();
  assert.equal(deriveMarket(snap, { volumePolicy: '24h' }).volume.kind, 'observed');
  assert.equal(deriveMarket(snap, { volumeUsdOverride: 5e7 }).volume.kind, 'assumed');
  const v = deriveMarket(snap, { volatilityOverride: 0.6 }).volatility;
  assert.equal(v.kind, 'assumed'); assert.ok(Math.abs(v.daily - 0.6 / Math.sqrt(365)) < 1e-12);
  assert.equal(deriveMarket(snap, { volWindowDays: 30 }).volatility.n, 30);
  assert.throws(() => deriveMarket(snap, { volumePolicy: 'median' }), (e) => e.code === 'INVALID_POLICY');
});

test('short history: volatility needs an override', () => {
  const s = sealSnapshot(synthetic({ history: synthetic().history.slice(0, 5) }));
  assert.throws(() => deriveMarket(s), (e) => e.code === 'INSUFFICIENT_HISTORY');
  assert.doesNotThrow(() => deriveMarket(s, { volatilityOverride: 0.5 }));
  const empty = sealSnapshot(synthetic({ history: [] }));
  assert.throws(() => deriveMarket(empty, { volatilityOverride: 0.5 }), (e) => e.code === 'NO_VOLUME_HISTORY');
});
