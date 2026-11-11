// Uniswap v3 concentrated-liquidity math in human units.
// Convention throughout: P = price of the base asset (WETH) in the quote asset (USDC).
//   x = base amount (WETH), y = quote amount (USDC), value V = x*P + y.
// For a position with liquidity L on [Pa, Pb]:
//   P <= Pa : x = L(1/sqrt(Pa) - 1/sqrt(Pb)), y = 0
//   Pa<P<Pb : x = L(1/sqrt(P)  - 1/sqrt(Pb)), y = L(sqrt(P) - sqrt(Pa))
//   P >= Pb : x = 0,                          y = L(sqrt(Pb) - sqrt(Pa))
// Human L converts to on-chain (raw) L by multiplying by sqrt(10^dec0 * 10^dec1).
import { ApiError } from './errors.js';

const LOG_TICK = Math.log(1.0001);
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * Pool tick -> human price of base in quote. `baseIsToken1` true when the base asset (WETH)
 * is token1 (true for the USDC/WETH mainnet pools, where token0 = USDC).
 */
export function tickToPrice(tick, pool) {
  const { dec0, dec1, baseIsToken1 } = poolDecimals(pool);
  // raw price token1/token0 = 1.0001^tick; human token1 per token0 = raw * 10^(dec0-dec1)
  const t1PerT0 = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
  return baseIsToken1 ? 1 / t1PerT0 : t1PerT0;
}

export function priceToTick(price, pool) {
  assertPositive(price, 'price');
  const { dec0, dec1, baseIsToken1 } = poolDecimals(pool);
  const t1PerT0 = baseIsToken1 ? 1 / price : price;
  const raw = t1PerT0 / Math.pow(10, dec0 - dec1);
  return Math.log(raw) / LOG_TICK;
}

function poolDecimals(pool) {
  const dec0 = pool.token0.decimals;
  const dec1 = pool.token1.decimals;
  const baseIsToken1 = pool.base === 'token1';
  return { dec0, dec1, baseIsToken1 };
}

/** Snap a requested [lower, upper] price range to initializable ticks (nearest multiple of spacing). */
export function alignRange(lower, upper, pool) {
  const s = pool.tickSpacing;
  const tA = priceToTick(lower, pool);
  const tB = priceToTick(upper, pool);
  let lo = Math.round(Math.min(tA, tB) / s) * s;
  let hi = Math.round(Math.max(tA, tB) / s) * s;
  lo = Math.max(lo, Math.ceil(MIN_TICK / s) * s);
  hi = Math.min(hi, Math.floor(MAX_TICK / s) * s);
  if (hi <= lo) {
    throw new ApiError(422, 'RANGE_TOO_NARROW',
      `Range ${lower}–${upper} collapses to a single tick at spacing ${s}; widen it.`, { tickLower: lo, tickUpper: hi });
  }
  const pAtLo = tickToPrice(lo, pool);
  const pAtHi = tickToPrice(hi, pool);
  return { tickLower: lo, tickUpper: hi, lower: Math.min(pAtLo, pAtHi), upper: Math.max(pAtLo, pAtHi) };
}

export function amountsForLiquidity(L, P, Pa, Pb) {
  const sa = Math.sqrt(Pa), sb = Math.sqrt(Pb);
  if (P <= Pa) return { x: L * (1 / sa - 1 / sb), y: 0 };
  if (P >= Pb) return { x: 0, y: L * (sb - sa) };
  const s = Math.sqrt(P);
  return { x: L * (1 / s - 1 / sb), y: L * (s - sa) };
}

export function positionValue(L, P, Pa, Pb) {
  const { x, y } = amountsForLiquidity(L, P, Pa, Pb);
  return x * P + y;
}

/** Liquidity bought by `capital` (in quote units) at price P for range [Pa, Pb], optimally split. */
export function liquidityForCapital(capital, P, Pa, Pb) {
  assertPositive(capital, 'capital');
  assertPositive(P, 'price');
  if (!(Pa > 0 && Pb > Pa)) throw new ApiError(422, 'INVALID_RANGE', 'Require 0 < lower < upper.', { lower: Pa, upper: Pb });
  const sa = Math.sqrt(Pa), sb = Math.sqrt(Pb);
  if (P <= Pa) return capital / (P * (1 / sa - 1 / sb));
  if (P >= Pb) return capital / (sb - sa);
  const s = Math.sqrt(P);
  return capital / (2 * s - sa - P / sb);
}

/** Liquidity from explicit token amounts (min of the two constraints, as the NonfungiblePositionManager does). */
export function liquidityForAmounts(x, y, P, Pa, Pb) {
  const sa = Math.sqrt(Pa), sb = Math.sqrt(Pb);
  if (P <= Pa) return x / (1 / sa - 1 / sb);
  if (P >= Pb) return y / (sb - sa);
  const s = Math.sqrt(P);
  return Math.min(x / (1 / s - 1 / sb), y / (s - sa));
}

/** Uniswap v2 / full-range liquidity for the same capital, for capital-efficiency comparisons. */
export function fullRangeLiquidity(capital, P) {
  return capital / (2 * Math.sqrt(P));
}

export function toRawLiquidity(Lhuman, pool) {
  return Lhuman * Math.sqrt(Math.pow(10, pool.token0.decimals) * Math.pow(10, pool.token1.decimals));
}

export function fromRawLiquidity(Lraw, pool) {
  return Lraw / Math.sqrt(Math.pow(10, pool.token0.decimals) * Math.pow(10, pool.token1.decimals));
}

/**
 * Active liquidity implied by a depth quote: pushing `quoteIn` of the quote token into the pool moves
 * the average execution price `slippage` above spot. With L constant over the move, the average price
 * of the bought base equals sqrt(P0*P1), so sqrt(P1) = sqrt(P0)*(1+s) and quoteIn = L*sqrt(P0)*s.
 */
export function liquidityFromDepth(quoteIn, slippage, P0) {
  assertPositive(quoteIn, 'quoteIn');
  assertPositive(slippage, 'slippage');
  assertPositive(P0, 'price');
  return quoteIn / (Math.sqrt(P0) * slippage);
}

/** Impermanent loss of an LP position vs holding its initial amounts, excluding fees. */
export function impermanentLoss(L, P0, P1, Pa, Pb) {
  const a0 = amountsForLiquidity(L, P0, Pa, Pb);
  const hodl = a0.x * P1 + a0.y;
  const lp = positionValue(L, P1, Pa, Pb);
  return { lp, hodl, il: hodl > 0 ? lp / hodl - 1 : 0 };
}

function assertPositive(v, name) {
  if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new ApiError(422, 'INVALID_NUMBER', `${name} must be a positive finite number`, { [name]: v });
  }
}
