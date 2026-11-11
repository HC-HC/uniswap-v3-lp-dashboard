import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSnapshot, priceFromTick } from '../providers/live.js';
import { sealSnapshot, deriveMarket } from '../engine/snapshot.js';
import { mockNetwork } from './fixtures/rpc.js';

const quiet = { log: () => {} };

test('capture: on-chain reads decode correctly and the result seals', async () => {
  const net = mockNetwork();
  const s = await captureSnapshot(net, quiet);
  assert.equal(s.state.tick, 200005);
  assert.ok(Math.abs(s.state.price - priceFromTick(200005)) < 1e-6);
  assert.equal(s.state.liquidity, '1300000000000000000');
  assert.deepEqual(s.ticks.map((t) => t.tickIdx), [199500, 200010, 202000], 'ticks outside ±3000 excluded');
  assert.equal(s.ticks[1].liquidityNet, '-300000000000000000', 'signed int128 decoded');
  assert.equal(s.history.length, 90);
  assert.ok(s.history.every((d, i) => i === 0 || d.date > s.history[i - 1].date));
  const m = deriveMarket(sealSnapshot(s));
  assert.equal(m.activeLiquidity.value, 1.3e6);
  assert.ok(net.calls.batches > 0);
});

test('capture: falls back to single calls when batches are rejected', async () => {
  const net = mockNetwork({ rejectBatch: true });
  const s = await captureSnapshot(net, quiet);
  assert.equal(s.ticks.length, 3);
  assert.ok(net.calls.batches > 0 && net.calls.rpc > net.calls.batches);
});

test('capture: failure cases', async () => {
  await assert.rejects(captureSnapshot(mockNetwork({ rpcDown: true }), quiet), /No RPC endpoint reachable/);
  await assert.rejects(captureSnapshot(mockNetwork({ geckoStatus: 429 }), { ...quiet, http: { waitMs: 0 } }), /HTTP 429/);
  await assert.rejects(captureSnapshot(mockNetwork({ geckoPriceFactor: 1.05 }), quiet), (e) => e.code === 'UPSTREAM_MALFORMED' && /GeckoTerminal price/.test(e.message));
  await assert.rejects(captureSnapshot(mockNetwork({ fee: 3000, spacing: 60, init: { 199980: [1n, 1n] } }), quiet), /fee tier is 0.05%/);
});

test('capture: WETH price taken from the right side when GeckoTerminal lists USDC as base (0.01% / 0.30% pools)', async () => {
  const s = await captureSnapshot(mockNetwork({ geckoBase: 'usdc', fee: 3000, spacing: 60, init: { 199980: [5n * 10n ** 17n, 5n * 10n ** 17n], 200040: [5n * 10n ** 17n, -5n * 10n ** 17n] } }), { ...quiet, tier: 30 });
  assert.equal(s.market.priceField, 'quote_token_price_usd');
  assert.ok(Math.abs(s.market.priceUsd / s.state.price - 1) < 0.01);
  assert.equal(s.pool.address, '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8');
  await assert.rejects(captureSnapshot(mockNetwork(), { ...quiet, tier: 7 }), /Unknown fee tier/);
});

test('capture: waits and retries when GeckoTerminal rate-limits (HTTP 429)', async () => {
  const net = mockNetwork({ gecko429: 2 });
  const s = await captureSnapshot(net, { ...quiet, http: { waitMs: 0 } });
  assert.equal(s.history.length, 90);
  assert.ok(net.calls.gecko >= 4, 'two 429s then success');
  await assert.rejects(captureSnapshot(mockNetwork({ gecko429: 10 }), { ...quiet, http: { waitMs: 0, retries: 2 } }), /HTTP 429/);
});
