// Live data provider: no-signup snapshot of the Uniswap v3 WETH/USDC 0.05% pool.
//   node fetch-snapshot-nokey.mjs            → snapshots/<timestamp>-<hash>.json
// Optional: RPC_URL=https://your-rpc node fetch-snapshot-nokey.mjs
//
// Sources (all free, no API key):
//   • Ethereum JSON-RPC (public node)  → slot0, liquidity, tick spacing, fee, tick bitmap, every initialized tick
//   • GeckoTerminal API                → TVL, 24h volume, 90 days of daily OHLCV with pool volume
// Node 18+ (built-in fetch). No dependencies.


// Uniswap v3 USDC/WETH pools on Ethereum (token0 = USDC 6dp, token1 = WETH 18dp). Key = fee tier in bp.
export const POOLS = {
  1: { address: '0xe0554a476a092703abdb3ef35c80e0d76d32939f', fee: 100, spacing: 1 },
  5: { address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', fee: 500, spacing: 10 },
  30: { address: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', fee: 3000, spacing: 60 },
  100: { address: '0x7bea39867e4169dbe237d55c8242a8f2fcdcc387', fee: 10000, spacing: 200 },
};
export const POOL = POOLS[5].address;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TICK_WINDOW = 3000;   // ±3000 ticks ≈ ±35% in price around the current tick
const HISTORY_DAYS = 90;
const RPC_URLS = [(typeof process !== 'undefined' && process.env?.RPC_URL) || null, 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org'].filter(Boolean);
const GT = 'https://api.geckoterminal.com/api/v2';

// Function selectors = first 4 bytes of keccak256(signature)
const SEL = { slot0: '0x3850c7bd', liquidity: '0x1a686502', tickSpacing: '0xd0c93a7c', fee: '0xddca3f43', tickBitmap: '0x5339c296', ticks: '0xf30dba93' };

// ---------- ABI helpers ----------
const encInt = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const asInt = (v, bits = 256) => BigInt.asIntN(bits, v);
export const priceFromTick = (t) => 1e12 / Math.pow(1.0001, t); // USDC per WETH for this pool

// ---------- RPC ----------
function makeRpc(fetchImpl, url, pool = POOL) {
  let id = 0;
  const post = async (body) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return res.json();
  };
  async function call(method, params) {
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  // Batch eth_calls; falls back to small sequential groups if the node rejects batches.
  async function batchCalls(datas, blockTag, chunk = 50) {
    const out = new Array(datas.length);
    for (let i = 0; i < datas.length; i += chunk) {
      const slice = datas.slice(i, i + chunk);
      const reqs = slice.map((data, k) => ({ jsonrpc: '2.0', id: i + k, method: 'eth_call', params: [{ to: pool, data }, blockTag] }));
      let res;
      try { res = await post(reqs); } catch { res = null; }
      if (Array.isArray(res) && res.every((r) => r.result)) {
        for (const r of res) out[r.id] = r.result;
      } else {
        for (let k = 0; k < slice.length; k += 5) {
          const part = await Promise.all(slice.slice(k, k + 5).map((d) => call('eth_call', [{ to: pool, data: d }, blockTag])));
          part.forEach((r, j) => { out[i + k + j] = r; });
        }
      }
    }
    return out;
  }
  return { call, batchCalls, url, pool };
}

async function pickRpc(fetchImpl, urls = RPC_URLS, pool = POOL) {
  for (const url of urls) {
    try {
      const rpc = makeRpc(fetchImpl, url, pool);
      const bn = await rpc.call('eth_blockNumber', []);
      return { rpc, block: parseInt(bn, 16) };
    } catch (e) { console.warn(`RPC ${url} failed: ${e.message}`); }
  }
  throw new Error('No RPC endpoint reachable. Set RPC_URL to any Ethereum mainnet RPC.');
}

// ---------- on-chain reads ----------
export async function readPool(rpc, block) {
  const tag = '0x' + block.toString(16);
  const eth = (data) => rpc.call('eth_call', [{ to: rpc.pool, data }, tag]);
  const [slot0, liq, spacingHex, feeHex] = await Promise.all([eth(SEL.slot0), eth(SEL.liquidity), eth(SEL.tickSpacing), eth(SEL.fee)]);
  const sqrtPriceX96 = word(slot0, 0);
  const tick = Number(asInt(word(slot0, 1)));
  const spacing = Number(asInt(word(spacingHex, 0)));
  const fee = Number(word(feeHex, 0));
  const liquidity = word(liq, 0);

  // Which ticks are initialized? Scan the tick bitmap words covering the window.
  const comp = (t) => Math.floor(t / spacing);
  const wLo = comp(tick - TICK_WINDOW) >> 8, wHi = comp(tick + TICK_WINDOW) >> 8;
  const wordPositions = [];
  for (let w = wLo; w <= wHi; w++) wordPositions.push(w);
  const words = await rpc.batchCalls(wordPositions.map((w) => SEL.tickBitmap + encInt(w)), tag);
  const initialized = [];
  wordPositions.forEach((w, i) => {
    const bits = word(words[i], 0);
    for (let b = 0; b < 256; b++) {
      if ((bits >> BigInt(b)) & 1n) {
        const t = (w * 256 + b) * spacing;
        if (t >= tick - TICK_WINDOW && t <= tick + TICK_WINDOW) initialized.push(t);
      }
    }
  });

  // Read liquidityGross / liquidityNet for each initialized tick.
  const tickData = await rpc.batchCalls(initialized.map((t) => SEL.ticks + encInt(t)), tag);
  const ticks = initialized.map((t, i) => ({
    tickIdx: t,
    liquidityGross: word(tickData[i], 0).toString(),
    liquidityNet: asInt(word(tickData[i], 1)).toString(), // int128, sign-extended in the ABI word
  })).sort((a, b) => a.tickIdx - b.tickIdx);

  const s = Number(sqrtPriceX96) / 2 ** 96;
  return {
    block, tick, spacing, fee,
    sqrtPriceX96: sqrtPriceX96.toString(),
    liquidity: liquidity.toString(),
    price: 1e12 / (s * s), // USDC per WETH
    ticks,
  };
}

// ---------- GeckoTerminal ----------
/** GET JSON; on HTTP 429 (GeckoTerminal allows ~30 calls/min) wait and retry up to 3 times. */
async function getJson(fetchImpl, url, { retries = 3, waitMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      if (typeof console !== 'undefined') console.warn(`rate limited by ${new URL(url).host}; retrying in ${waitMs / 1000}s (${attempt + 1}/${retries})`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${url} HTTP ${res.status}`);
  }
}

export async function readGecko(fetchImpl, pool = POOL, http = {}) {
  const p = await getJson(fetchImpl, `${GT}/networks/eth/pools/${pool}`, http);
  const a = p?.data?.attributes;
  if (!a) throw new Error('GeckoTerminal: unexpected pool response');
  const o = await getJson(fetchImpl, `${GT}/networks/eth/pools/${pool}/ohlcv/day?aggregate=1&limit=${HISTORY_DAYS}&currency=usd&token=${WETH}`, http);
  const list = o?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error('GeckoTerminal: unexpected OHLCV response');
  const history = list
    .map(([ts, open, high, low, close, volumeUsd]) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), open, high, low, close, volumeUsd }))
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  // GeckoTerminal's "base" token differs by pool (WETH for 0.05%, USDC for 0.01%/0.30%): take the WETH side explicitly.
  const baseId = String(p?.data?.relationships?.base_token?.data?.id || '').toLowerCase();
  const quoteId = String(p?.data?.relationships?.quote_token?.data?.id || '').toLowerCase();
  const wethIsBase = baseId.endsWith(WETH) || (!quoteId.endsWith(WETH) && Number(a.base_token_price_usd) > 10);
  return {
    tvlUsd: Number(a.reserve_in_usd),
    volume24hUsd: Number(a.volume_usd?.h24),
    priceUsd: Number(wethIsBase ? a.base_token_price_usd : a.quote_token_price_usd),
    priceField: wethIsBase ? 'base_token_price_usd' : 'quote_token_price_usd',
    history,
  };
}

// ---------- main ----------
export async function captureSnapshot(fetchImpl = globalThis.fetch, { rpcUrl, tier = 5, now = () => new Date(), log = console.log, http } = {}) {
  const T = POOLS[tier];
  if (!T) throw Object.assign(new Error(`Unknown fee tier ${tier} bp (use 1, 5, 30 or 100)`), { code: 'INVALID_TIER' });
  const POOL = T.address;
  const capturedAt = now().toISOString();
  const { rpc, block } = await pickRpc(fetchImpl, rpcUrl ? [rpcUrl, ...RPC_URLS] : RPC_URLS, POOL);
  const chain = await readPool(rpc, block);
  const gecko = await readGecko(fetchImpl, POOL, http);

  // Sanity checks: print loudly rather than fail silently
  const checks = [
    [`fee tier is ${T.fee / 1e4}%`, chain.fee === T.fee],
    [`tick spacing is ${T.spacing}`, chain.spacing === T.spacing],
    ['slot0 price ≈ price from tick', Math.abs(chain.price / priceFromTick(chain.tick) - 1) < 0.0002],
    ['on-chain price ≈ GeckoTerminal price (±1%)', Math.abs(chain.price / gecko.priceUsd - 1) < 0.01],
    ['found initialized ticks', chain.ticks.length > 0],
    ['history has ≥ 30 days', gecko.history.length >= 30],
  ];
  for (const [label, ok] of checks) log(`${ok ? '✓' : '✗'} ${label}`);
  const failed = checks.filter(([, ok]) => !ok).map(([l]) => l);
  if (failed.length) throw Object.assign(new Error(`Capture failed sanity checks: ${failed.join('; ')}`), { code: 'UPSTREAM_MALFORMED' });

  return {
    schemaVersion: 1,
    capturedAt,
    pool: { address: POOL, chain: 'ethereum', feeTier: chain.fee / 1e6, tickSpacing: chain.spacing, token0: { symbol: 'USDC', decimals: 6 }, token1: { symbol: 'WETH', decimals: 18 } },
    sources: {
      rpc: { name: 'Ethereum JSON-RPC (pool contract reads)', url: new URL(rpc.url).origin, block },
      geckoterminal: { name: 'GeckoTerminal API v2', url: `${GT}/networks/eth/pools/${POOL}` },
    },
    // observed on-chain at `block`
    state: { block, tick: chain.tick, sqrtPriceX96: chain.sqrtPriceX96, liquidity: chain.liquidity, price: chain.price },
    ticks: chain.ticks,
    // observed from GeckoTerminal at capturedAt
    market: { tvlUsd: gecko.tvlUsd, volume24hUsd: gecko.volume24hUsd, priceUsd: gecko.priceUsd, priceField: gecko.priceField },
    history: gecko.history,
    checks: Object.fromEntries(checks),
  };
}

