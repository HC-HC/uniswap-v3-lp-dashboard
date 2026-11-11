import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, canonicalJson, contentHash } from '../engine/sha256.js';
import { makeRng, makeNormal, stdev, mean, quantileSorted, summarize, histogram, logReturns } from '../engine/stats.js';

test('pure-JS sha256 matches node:crypto across sizes and unicode', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Δ WETH/USDC ✓ 🦄']) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
  assert.equal(contentHash({ x: 1, y: 2 }), contentHash({ y: 2, x: 1 }));
  assert.notEqual(contentHash({ x: 1 }), contentHash({ x: 1.0000001 }));
  assert.equal(canonicalJson({ a: undefined, b: NaN }), '{"b":null}');
});

test('seeded PRNG is deterministic and roughly uniform', () => {
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  const r = makeRng(7), xs = Array.from({ length: 20000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(mean(xs) - 0.5) < 0.01);
});

test('normal generator has ~zero mean and unit variance', () => {
  const n = makeNormal(makeRng(1)), xs = Array.from({ length: 40000 }, n);
  assert.ok(Math.abs(mean(xs)) < 0.02);
  assert.ok(Math.abs(stdev(xs) - 1) < 0.02);
});

test('stdev / quantiles / histogram', () => {
  assert.ok(Number.isNaN(stdev([1])));
  assert.equal(stdev([5, 5, 5, 5]), 0);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935) < 1e-8);
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  const s = summarize([3, 1, 2, 5, 4]);
  assert.equal(s.p50, 3); assert.equal(s.min, 1); assert.equal(s.max, 5);
  const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.equal(h.length, 5);
  assert.equal(h.reduce((a, b) => a + b.count, 0), 10);
  assert.ok(Math.abs(logReturns([100, 110])[0] - Math.log(1.1)) < 1e-15);
});
