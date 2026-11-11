import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealSnapshot, normalizePool } from '../engine/snapshot.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_FILE = join(root, 'data/raw/2026-11-11T03-46-19Z-block-26389083.json');
export const rawSnapshot = () => JSON.parse(readFileSync(RAW_FILE, 'utf8'));
export const sealed = () => sealSnapshot(rawSnapshot());
export const storedSnapshots = () => readdirSync(join(root, 'data/snapshots')).map((f) => JSON.parse(readFileSync(join(root, 'data/snapshots', f), 'utf8')));
export const POOL = normalizePool(rawSnapshot().pool);
export const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

/** Small synthetic snapshot with known liquidity (for exact-answer tests). */
export function synthetic({ tick = 200005, liquidity = '1300000000000000000', ticks, history, volume24hUsd = 5e7 } = {}) {
  const price = 1e12 / Math.pow(1.0001, tick);
  const hist = history || Array.from({ length: 60 }, (_, i) => { const c = price * (1 + 0.05 * Math.sin(i / 5)); return { date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, volumeUsd: 4e7 }; });
  return {
    schemaVersion: 1, capturedAt: '2026-11-11T00:00:00.000Z',
    pool: { address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', chain: 'ethereum', feeTier: 0.0005, tickSpacing: 10, token0: { symbol: 'USDC', decimals: 6 }, token1: { symbol: 'WETH', decimals: 18 } },
    sources: { rpc: { name: 'test rpc', url: 'https://rpc.test', block: 1 }, geckoterminal: { name: 'test gt', url: 'https://gt.test' } },
    state: { block: 1, tick, sqrtPriceX96: '0', liquidity, price },
    ticks: ticks || [
      { tickIdx: 199500, liquidityNet: '800000000000000000' },
      { tickIdx: 200010, liquidityNet: '-300000000000000000' },
      { tickIdx: 202000, liquidityNet: '-500000000000000000' },
      { tickIdx: 197100, liquidityNet: '500000000000000000' },
    ],
    market: { tvlUsd: 8e7, volume24hUsd, priceUsd: price },
    history: hist,
  };
}
