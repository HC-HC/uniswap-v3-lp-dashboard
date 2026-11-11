// Simulated Ethereum JSON-RPC (Uniswap v3 pool reads) + GeckoTerminal for provider tests.
import { priceFromTick } from '../../providers/live.js';
const enc = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');

export function mockNetwork({ tick = 200005, spacing = 10, fee = 500, liquidity = 13n * 10n ** 17n, init, geckoPriceFactor = 1.002, rejectBatch = false, rpcDown = false, geckoStatus = 200, geckoBase = 'weth', gecko429 = 0 } = {}) {
  let limited = gecko429;
  const ticks = init || { 197000: [5n * 10n ** 17n, 5n * 10n ** 17n], 199500: [8n * 10n ** 17n, 8n * 10n ** 17n], 200010: [3n * 10n ** 17n, -3n * 10n ** 17n], 202000: [5n * 10n ** 17n, -5n * 10n ** 17n], 210000: [1n, 1n] };
  const sqrtX96 = BigInt(Math.round(Math.sqrt(1e12 / priceFromTick(tick)) * 2 ** 96));
  const ethCall = (data) => {
    const sel = data.slice(0, 10), arg = data.length > 10 ? BigInt.asIntN(256, BigInt('0x' + data.slice(10))) : null;
    if (sel === '0x3850c7bd') return '0x' + sqrtX96.toString(16).padStart(64, '0') + enc(tick) + '0'.repeat(64 * 5);
    if (sel === '0x1a686502') return '0x' + enc(liquidity);
    if (sel === '0xd0c93a7c') return '0x' + enc(spacing);
    if (sel === '0xddca3f43') return '0x' + enc(fee);
    if (sel === '0x5339c296') { let bits = 0n; for (const t of Object.keys(ticks).map(Number)) { const c = Math.floor(t / spacing); if ((c >> 8) === Number(arg)) bits |= 1n << BigInt(c & 255); } return '0x' + enc(bits); }
    if (sel === '0xf30dba93') { const [g, n] = ticks[Number(arg)] || [0n, 0n]; return '0x' + enc(g) + enc(n) + '0'.repeat(64 * 6); }
    throw new Error('unknown selector ' + sel);
  };
  const calls = { batches: 0, rpc: 0, gecko: 0 };
  const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const impl = async (url, init2) => {
    if (url.includes('geckoterminal')) {
      calls.gecko++;
      if (limited > 0) { limited--; return ok({}, 429); }
      if (geckoStatus !== 200) return ok({}, geckoStatus);
      if (url.includes('/ohlcv/')) return ok({ data: { attributes: { ohlcv_list: Array.from({ length: 90 }, (_, i) => [1755000000 + (89 - i) * 86400, 2000, 2050, 1950, 2000 * (1 + 0.01 * Math.sin(i)), 5e7]) } } });
      const weth = 'eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', usdc = 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ethUsd = String(priceFromTick(tick) * geckoPriceFactor);
      const attrs = geckoBase === 'weth' ? { base_token_price_usd: ethUsd, quote_token_price_usd: '1.0002' } : { base_token_price_usd: '1.0004', quote_token_price_usd: ethUsd };
      return ok({ data: { attributes: { reserve_in_usd: '80000000', volume_usd: { h24: '60000000' }, ...attrs }, relationships: { base_token: { data: { id: geckoBase === 'weth' ? weth : usdc } }, quote_token: { data: { id: geckoBase === 'weth' ? usdc : weth } } } } });
    }
    if (rpcDown) throw new Error('ECONNREFUSED');
    calls.rpc++;
    const body = JSON.parse(init2.body);
    if (Array.isArray(body)) { calls.batches++; if (rejectBatch) return ok({ jsonrpc: '2.0', error: { message: 'batch not allowed' } }); return ok(body.map((b) => ({ jsonrpc: '2.0', id: b.id, result: ethCall(b.params[0].data) }))); }
    if (body.method === 'eth_blockNumber') return ok({ jsonrpc: '2.0', id: body.id, result: '0x17d7840' });
    return ok({ jsonrpc: '2.0', id: body.id, result: ethCall(body.params[0].data) });
  };
  impl.calls = calls;
  return impl;
}
