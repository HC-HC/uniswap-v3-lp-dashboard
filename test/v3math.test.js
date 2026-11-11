import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tickToPrice, priceToTick, alignRange, amountsForLiquidity, positionValue, liquidityForCapital,
  liquidityForAmounts, fullRangeLiquidity, toRawLiquidity, fromRawLiquidity, liquidityFromDepth, impermanentLoss,
} from '../engine/v3math.js';
import { POOL, close } from './helpers.js';

test('hand-computed position: P=100 on [81,121] with $1000', () => {
  // sqrt: 10, 9, 11 → L = 1000 / (2*10 - 9 - 100/11) = 1000 / 1.909090…
  const L = liquidityForCapital(1000, 100, 81, 121);
  assert.ok(close(L, 1000 / (20 - 9 - 100 / 11)));
  const { x, y } = amountsForLiquidity(L, 100, 81, 121);
  assert.ok(close(x, L * (1 / 10 - 1 / 11)));
  assert.ok(close(y, L * (10 - 9)));
  assert.ok(close(x * 100 + y, 1000), 'deposit value equals capital');
});

test('price ↔ tick for USDC/WETH (token0 = USDC 6dp, token1 = WETH 18dp)', () => {
  // human price P (USDC per WETH) = 1e12 / 1.0001^tick
  assert.ok(close(tickToPrice(200000, POOL), 1e12 / Math.pow(1.0001, 200000)));
  for (const p of [500, 2122.26, 4000, 10000]) assert.ok(close(tickToPrice(priceToTick(p, POOL), POOL), p, 1e-12));
  assert.ok(priceToTick(2000, POOL) > priceToTick(3000, POOL), 'higher USDC price → lower tick');
  assert.ok(Math.abs(priceToTick(2000, POOL) - 200311.5) < 1, 'P=2000 sits near tick 200311');
});

test('alignRange snaps to tick spacing and preserves ordering', () => {
  const r = alignRange(1900, 2350, POOL);
  assert.equal(r.tickLower % 10, 0);
  assert.equal(r.tickUpper % 10, 0);
  assert.ok(r.lower < r.upper);
  assert.ok(Math.abs(r.lower / 1900 - 1) < 0.0006 && Math.abs(r.upper / 2350 - 1) < 0.0006);
});

test('alignRange rejects a range narrower than one tick spacing', () => {
  assert.throws(() => alignRange(2000, 2000.5, POOL), (e) => e.code === 'RANGE_TOO_NARROW' && e.status === 422);
});

test('single-sided positions below / above range', () => {
  const Lb = liquidityForCapital(1000, 50, 81, 121);
  const below = amountsForLiquidity(Lb, 50, 81, 121);
  assert.equal(below.y, 0);
  assert.ok(close(below.x * 50, 1000));
  const La = liquidityForCapital(1000, 200, 81, 121);
  const above = amountsForLiquidity(La, 200, 81, 121);
  assert.equal(above.x, 0);
  assert.ok(close(above.y, 1000));
});

test('position value is continuous at the bounds', () => {
  const L = 1234.5;
  for (const b of [81, 121]) {
    assert.ok(close(positionValue(L, b * (1 - 1e-12), 81, 121), positionValue(L, b * (1 + 1e-12), 81, 121), 1e-9));
  }
});

test('liquidityForAmounts inverts amountsForLiquidity', () => {
  const L = 777;
  const { x, y } = amountsForLiquidity(L, 100, 81, 121);
  assert.ok(close(liquidityForAmounts(x, y, 100, 81, 121), L));
});

test('very wide range converges to Uniswap v2 IL formula 2√k/(1+k) − 1', () => {
  const P0 = 2000, Pa = P0 / 1e6, Pb = P0 * 1e6;
  const L = liquidityForCapital(10000, P0, Pa, Pb);
  for (const k of [0.5, 0.8, 1.25, 2, 4]) {
    const { il } = impermanentLoss(L, P0, P0 * k, Pa, Pb);
    const v2 = (2 * Math.sqrt(k)) / (1 + k) - 1;
    assert.ok(Math.abs(il - v2) < 2e-3, `k=${k}: ${il} vs ${v2}`);
  }
  assert.ok(close(L, fullRangeLiquidity(10000, P0), 2e-3));
});

test('IL is zero at entry and negative elsewhere; concentration amplifies it', () => {
  const P0 = 2000;
  const narrow = liquidityForCapital(1e4, P0, 1800, 2200);
  const wide = liquidityForCapital(1e4, P0, 1000, 4000);
  assert.ok(Math.abs(impermanentLoss(narrow, P0, P0, 1800, 2200).il) < 1e-12);
  const iln = impermanentLoss(narrow, P0, 2150, 1800, 2200).il;
  const ilw = impermanentLoss(wide, P0, 2150, 1000, 4000).il;
  assert.ok(iln < 0 && ilw < 0 && iln < ilw, 'narrow range loses more for the same move');
});

test('raw ↔ human liquidity conversion uses sqrt(10^(6+18)) = 1e12', () => {
  assert.equal(toRawLiquidity(2, POOL), 2e12);
  assert.ok(close(fromRawLiquidity(toRawLiquidity(123.456, POOL), POOL), 123.456));
});

test('liquidityFromDepth: exact inverse of a constant-L swap', () => {
  // Swap quoteIn into a pool with known L: sqrt(P1) = sqrt(P0) + quoteIn / L
  const L = 2e6, P0 = 2300, quoteIn = 1e6;
  const sP1 = Math.sqrt(P0) + quoteIn / L;
  const baseOut = L * (1 / Math.sqrt(P0) - 1 / sP1);
  const slippage = quoteIn / baseOut / P0 - 1; // average execution price vs spot
  assert.ok(close(liquidityFromDepth(quoteIn, slippage, P0), L, 1e-9));
});

test('invalid numeric inputs raise 422', () => {
  assert.throws(() => liquidityForCapital(0, 100, 81, 121), (e) => e.code === 'INVALID_NUMBER');
  assert.throws(() => liquidityForCapital(100, 100, 121, 81), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => priceToTick(-1, POOL), (e) => e.status === 422);
  assert.throws(() => liquidityFromDepth(1, 0, 1), (e) => e.status === 422);
});
