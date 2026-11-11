// Transport-agnostic API router. The Node server and the hosted (in-browser) build both use it,
// so the HTTP API and the hosted page run the same code.
//   handle({ method, path, query, body }) -> { status, body, headers? }
import { ApiError, isApiError } from '../engine/errors.js';
import { sealSnapshot, verifySnapshot, deriveMarket, validateSnapshot } from '../engine/snapshot.js';
import { analyze, analysisId, ENGINE_VERSION, ASSUMPTIONS } from '../engine/analysis.js';
import { normalizeInputs, INPUT_SCHEMA, INPUT_DEFAULTS } from '../engine/validate.js';
import { buildOpenApi } from './openapi.js';
import { liquidityBars } from '../engine/curve.js';
import { compareTiers } from '../engine/tiers.js';

const DEFAULT_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'; // WETH/USDC 0.05%

const json = (status, body, headers) => ({ status, body, headers });

function snapshotSummary(s) {
  return {
    id: s.id,
    label: s.label,
    capturedAt: s.capturedAt,
    contentHash: s.contentHash,
    block: s.state?.block,
    price: s.state?.price,
    pool: { address: s.pool.address, feeTier: s.pool.feeTier, pair: `${s.pool.token1.symbol}/${s.pool.token0.symbol}` },
    sources: Object.fromEntries(Object.entries(s.sources || {}).map(([k, v]) => [k, { name: v.name, url: v.url }])),
    ticks: s.ticks?.length || 0,
    historyDays: s.history?.length || 0,
  };
}

function analysisSummary(a) {
  return {
    id: a.id, label: a.label, createdAt: a.createdAt, snapshotId: a.snapshotId, engineVersion: a.engineVersion,
    resultHash: a.resultHash,
    capitalUsd: a.inputs.capitalUsd, range: a.result?.position?.range,
    mode: a.inputs.liquidityMode, expectedFeeApr: a.result?.fees?.expectedApr?.[a.inputs.liquidityMode], expectedNetPnl: a.result?.simulation?.netPnl?.mean,
  };
}

export function createRouter({ storage, liveProvider = null, now = () => new Date(), mode = 'server' }) {
  const byNewest = (a, b) => (a.capturedAt < b.capturedAt ? 1 : -1);
  /** Newest snapshot of a pool (default: the 0.05% pool; falls back to any pool). */
  const latestSnapshot = (pool = DEFAULT_POOL) => {
    const all = storage.listSnapshots().sort(byNewest);
    return all.find((s) => s.pool.address.toLowerCase() === pool.toLowerCase()) || all[0] || null;
  };
  /** Newest snapshot of every pool with the same token pair as `base`. */
  const latestPerTier = (base) => {
    const out = new Map();
    for (const s of storage.listSnapshots().sort(byNewest)) {
      if (s.pool.token0.symbol !== base.pool.token0.symbol || s.pool.token1.symbol !== base.pool.token1.symbol) continue;
      if (s.pool.address.toLowerCase() === base.pool.address.toLowerCase()) continue;
      if (!out.has(s.pool.feeTier)) out.set(s.pool.feeTier, s);
    }
    return [...out.values()];
  };
  const loadSnapshot = (id) => {
    const s = !id || id === 'latest' ? latestSnapshot() : storage.getSnapshot(id);
    if (!s) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', `No snapshot '${id || 'latest'}'`, { available: storage.listSnapshots().map((x) => x.id) });
    verifySnapshot(s);
    return s;
  };
  const requireBody = (body) => {
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Request body must be a JSON object');
    }
    return body;
  };

  const record = (snap, inputs, label) => {
    const { result, resultHash } = analyze(snap, inputs);
    const id = analysisId(snap.id, result.inputs);
    return { id, label: label || null, createdAt: now().toISOString(), engineVersion: ENGINE_VERSION, snapshotId: snap.id, snapshotContentHash: snap.contentHash, inputs: result.inputs, resultHash, result };
  };

  const replay = (rec) => {
    const snap = loadSnapshot(rec.snapshotId);
    if (snap.contentHash !== rec.snapshotContentHash) {
      throw new ApiError(409, 'SNAPSHOT_HASH_MISMATCH', 'Stored snapshot differs from the one this analysis was run on', { expected: rec.snapshotContentHash, actual: snap.contentHash });
    }
    const { resultHash, result } = analyze(snap, rec.inputs);
    return {
      id: rec.id,
      reproducible: resultHash === rec.resultHash,
      storedResultHash: rec.resultHash,
      recomputedResultHash: resultHash,
      storedEngineVersion: rec.engineVersion,
      currentEngineVersion: ENGINE_VERSION,
      snapshotId: snap.id,
      ...(resultHash === rec.resultHash ? {} : { note: rec.engineVersion !== ENGINE_VERSION ? 'Engine version changed since this analysis was saved.' : 'Same engine and snapshot but a different result: the runtime’s floating-point behaviour differs.' }),
      result,
    };
  };

  const routes = [
    ['GET', /^\/api\/health$/, () => json(200, { ok: true, engineVersion: ENGINE_VERSION, mode, snapshots: storage.listSnapshots().length, liveRefresh: !!liveProvider, time: now().toISOString() })],
    ['GET', /^\/api\/openapi\.json$/, () => json(200, buildOpenApi())],
    ['GET', /^\/api\/schema$/, () => json(200, {
      inputs: Object.fromEntries(Object.entries(INPUT_SCHEMA).map(([k, v]) => [k, { ...v, pattern: v.pattern ? String(v.pattern) : undefined, default: INPUT_DEFAULTS[k] }])),
      assumptions: ASSUMPTIONS,
      provenanceKinds: {
        observed: 'Value as published by a named source at a stated time',
        derived: 'Deterministic arithmetic on observed values (median, realized volatility, position math)',
        estimated: 'Depends on a modelling assumption that could be wrong (fees, active liquidity from depth, simulations)',
        assumed: 'Supplied by the user or a default with no data behind it',
        mixed: 'Observed price path combined with estimated fees',
      },
    })],
    ['GET', /^\/api\/snapshots$/, () => json(200, { snapshots: storage.listSnapshots().map(snapshotSummary).sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)) })],
    ['POST', /^\/api\/snapshots$/, (_m, body) => {
      const sealed = sealSnapshot(requireBody(body));
      const existed = !!storage.getSnapshot(sealed.id);
      if (!existed) storage.putSnapshot(sealed);
      return json(existed ? 200 : 201, { snapshot: snapshotSummary(sealed), created: !existed });
    }],
    ['POST', /^\/api\/snapshots\/refresh$/, async () => {
      if (!liveProvider) throw new ApiError(503, 'LIVE_DISABLED', mode === 'hosted' ? 'The hosted page cannot make network requests. Run the API server to refresh live data.' : 'Live refresh is disabled on this server.');
      const base = latestSnapshot();
      let raw;
      try {
        raw = await liveProvider({ base });
        if (!raw) throw new ApiError(502, 'UPSTREAM_MALFORMED', 'Live provider returned nothing');
      } catch (e) {
        if (isApiError(e)) { e.details = { ...(e.details || {}), fallbackSnapshotId: base?.id || null }; throw e; }
        throw new ApiError(502, e?.code === 'UPSTREAM_MALFORMED' ? 'UPSTREAM_MALFORMED' : 'UPSTREAM_UNAVAILABLE', String(e?.message || e), { fallbackSnapshotId: base?.id || null });
      }
      let sealed;
      try { sealed = sealSnapshot(raw); } catch (e) {
        throw new ApiError(502, 'UPSTREAM_MALFORMED', 'Live data failed snapshot validation; nothing was stored.', { problems: e.details?.problems, fallbackSnapshotId: base?.id || null });
      }
      storage.putSnapshot(sealed);
      return json(201, { snapshot: snapshotSummary(sealed) });
    }],
    ['GET', /^\/api\/snapshots\/([\w-]+)$/, (m) => json(200, loadSnapshot(m[1]))],
    ['GET', /^\/api\/snapshots\/([\w-]+)\/market$/, (m, _b, q) => {
      const s = loadSnapshot(m[1]);
      const opts = {};
      if (q.volumePolicy) opts.volumePolicy = q.volumePolicy;
      for (const k of ['volumeUsdOverride', 'volatilityOverride', 'volWindowDays']) if (q[k] !== undefined) opts[k] = Number(q[k]);
      const { segs, ...market } = deriveMarket(s, opts);
      return json(200, { snapshotId: s.id, market, liquidityBars: liquidityBars(segs, market.spot.value, Number(q.halfWidthPct) || 25, Number(q.bars) || 100), history: s.history });
    }],
    ['POST', /^\/api\/tiers$/, (_m, body) => {
      const b = requireBody(body);
      const base = loadSnapshot(b.snapshotId);
      const others = Array.isArray(b.compareSnapshotIds) ? b.compareSnapshotIds.map((id) => loadSnapshot(id)) : latestPerTier(base);
      for (const o of others) verifySnapshot(o);
      const { result, resultHash } = compareTiers(base, others, b.inputs);
      return json(200, { resultHash, result });
    }],
    ['POST', /^\/api\/analyze$/, (_m, body) => {
      const b = requireBody(body);
      const snap = loadSnapshot(b.snapshotId);
      const { result, resultHash } = analyze(snap, b.inputs);
      return json(200, { analysisId: analysisId(snap.id, result.inputs), resultHash, result });
    }],
    ['GET', /^\/api\/analyses$/, () => json(200, { analyses: storage.listAnalyses().map(analysisSummary).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) })],
    ['POST', /^\/api\/analyses$/, (_m, body) => {
      const b = requireBody(body);
      const snap = loadSnapshot(b.snapshotId);
      const normalized = normalizeInputs(b.inputs);
      const id = analysisId(snap.id, normalized);
      const prior = storage.getAnalysis(id);
      if (prior) return json(200, { analysis: prior, created: false });
      const rec = record(snap, b.inputs, typeof b.label === 'string' ? b.label.slice(0, 120) : null);
      storage.putAnalysis(rec);
      return json(201, { analysis: rec, created: true });
    }],
    ['GET', /^\/api\/analyses\/([\w-]+)$/, (m) => {
      const a = storage.getAnalysis(m[1]);
      if (!a) throw new ApiError(404, 'ANALYSIS_NOT_FOUND', `No saved analysis '${m[1]}'`);
      return json(200, { analysis: a });
    }],
    ['POST', /^\/api\/analyses\/([\w-]+)\/replay$/, (m) => {
      const a = storage.getAnalysis(m[1]);
      if (!a) throw new ApiError(404, 'ANALYSIS_NOT_FOUND', `No saved analysis '${m[1]}'`);
      return json(200, replay(a));
    }],
    ['GET', /^\/api\/analyses\/([\w-]+)\/bundle$/, (m) => {
      const a = storage.getAnalysis(m[1]);
      if (!a) throw new ApiError(404, 'ANALYSIS_NOT_FOUND', `No saved analysis '${m[1]}'`);
      const { result: _r, ...rec } = a;
      return json(200, { bundleVersion: 1, analysis: rec, snapshot: loadSnapshot(a.snapshotId) });
    }],
    ['POST', /^\/api\/bundles\/import$/, (_m, body) => {
      const b = requireBody(body);
      if (b.bundleVersion !== 1 || !b.analysis || !b.snapshot) throw new ApiError(422, 'BUNDLE_INVALID', 'Expected { bundleVersion: 1, analysis, snapshot }');
      validateSnapshot((({ id, contentHash, ...r }) => r)(b.snapshot));
      verifySnapshot(b.snapshot);
      if (b.analysis.snapshotId !== b.snapshot.id) throw new ApiError(422, 'BUNDLE_INVALID', 'analysis.snapshotId does not match snapshot.id');
      const normalized = normalizeInputs(b.analysis.inputs);
      if (analysisId(b.snapshot.id, normalized) !== b.analysis.id && b.analysis.engineVersion === ENGINE_VERSION) {
        throw new ApiError(422, 'BUNDLE_INVALID', 'analysis.id does not match its snapshot and inputs');
      }
      if (!storage.getSnapshot(b.snapshot.id)) storage.putSnapshot(b.snapshot);
      const r = replay({ ...b.analysis, inputs: normalized });
      if (!storage.getAnalysis(b.analysis.id)) storage.putAnalysis({ ...b.analysis, inputs: normalized, result: r.result });
      return json(200, r);
    }],
  ];

  return async function handle({ method = 'GET', path = '/', query = {}, body } = {}) {
    try {
      if (body === INVALID_JSON) throw new ApiError(400, 'BAD_JSON', 'Request body is not valid JSON');
      let pathMatched = false;
      for (const [m, re, fn] of routes) {
        const match = path.match(re);
        if (!match) continue;
        pathMatched = true;
        if (m !== method) continue;
        return await fn(match, body, query);
      }
      if (pathMatched) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${method} not allowed on ${path}`);
      throw new ApiError(404, 'NOT_FOUND', `No route ${method} ${path}`);
    } catch (e) {
      if (isApiError(e)) return json(e.status, e.toJSON());
      return json(500, { error: { code: 'INTERNAL', message: String(e?.message || e) } });
    }
  };
}

export const INVALID_JSON = Symbol('invalid-json');
