import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, INVALID_JSON } from '../api/router.js';
import { MemoryStorage } from '../api/memory-storage.js';
import { createApp } from '../server.js';
import { sealed, rawSnapshot, root } from './helpers.js';
import { mockNetwork } from './fixtures/rpc.js';
import { captureSnapshot } from '../providers/live.js';

const SNAP = sealed();
const INPUTS = { capitalUsd: 10000, rangeWidthPct: 5, simulations: 300 };
const mk = (opts = {}) => createRouter({ storage: new MemoryStorage({ snapshots: [SNAP] }), now: () => new Date('2026-11-08T23:00:00Z'), ...opts });

test('health, schema, openapi', async () => {
  const h = mk();
  assert.equal((await h({ path: '/api/health' })).body.ok, true);
  const s = await h({ path: '/api/schema' });
  assert.ok(s.body.inputs.capitalUsd.required);
  assert.ok(s.body.provenanceKinds.estimated);
  const o = await h({ path: '/api/openapi.json' });
  assert.equal(o.body.openapi, '3.1.0');
  assert.ok(o.body.paths['/api/analyze'].post);
});

test('routing errors: 404, 405, bad JSON, non-object body', async () => {
  const h = mk();
  assert.equal((await h({ path: '/api/nope' })).status, 404);
  assert.equal((await h({ method: 'DELETE', path: '/api/snapshots' })).status, 405);
  assert.equal((await h({ method: 'POST', path: '/api/analyze', body: INVALID_JSON })).body.error.code, 'BAD_JSON');
  assert.equal((await h({ method: 'POST', path: '/api/analyze', body: [1, 2] })).status, 400);
  assert.equal((await h({ method: 'POST', path: '/api/analyze' })).status, 400);
});

test('analyze: latest snapshot, unknown snapshot, invalid inputs', async () => {
  const h = mk();
  const ok = await h({ method: 'POST', path: '/api/analyze', body: { snapshotId: 'latest', inputs: INPUTS } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.snapshot.id, SNAP.id);
  const nf = await h({ method: 'POST', path: '/api/analyze', body: { snapshotId: 'snap_0123456789abcdef', inputs: INPUTS } });
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'SNAPSHOT_NOT_FOUND');
  const bad = await h({ method: 'POST', path: '/api/analyze', body: { inputs: { capitalUsd: -1 } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.problems.length >= 2);
});

test('market endpoint honours query overrides', async () => {
  const h = mk();
  const r = await h({ path: `/api/snapshots/${SNAP.id}/market`, query: { volumePolicy: '24h' } });
  assert.equal(r.body.market.volume.value, SNAP.market.volume24hUsd);
  assert.equal(r.body.liquidityBars.length, 100);
  assert.equal(r.body.history.length, SNAP.history.length);
  assert.equal(r.body.market.segs, undefined, 'raw segments not shipped');
  const r2 = await h({ path: `/api/snapshots/${SNAP.id}/market`, query: { volumeUsdOverride: '1e8' } });
  assert.equal(r2.body.market.volume.kind, 'assumed');
});

test('save → get → replay is reproducible and idempotent', async () => {
  const h = mk();
  const s1 = await h({ method: 'POST', path: '/api/analyses', body: { snapshotId: SNAP.id, inputs: INPUTS, label: 'test' } });
  assert.equal(s1.status, 201);
  const id = s1.body.analysis.id;
  const s2 = await h({ method: 'POST', path: '/api/analyses', body: { snapshotId: SNAP.id, inputs: { ...INPUTS, seed: 42 } } });
  assert.equal(s2.status, 200, 'same normalized inputs → same id');
  assert.equal(s2.body.analysis.id, id);
  const got = await h({ path: `/api/analyses/${id}` });
  assert.equal(got.body.analysis.resultHash, s1.body.analysis.resultHash);
  const rp = await h({ method: 'POST', path: `/api/analyses/${id}/replay` });
  assert.equal(rp.body.reproducible, true);
  assert.equal(rp.body.recomputedResultHash, s1.body.analysis.resultHash);
  const list = await h({ path: '/api/analyses' });
  assert.equal(list.body.analyses.length, 1);
  assert.equal((await h({ path: '/api/analyses/an_0000000000000000' })).status, 404);
  assert.equal((await h({ method: 'POST', path: '/api/analyses/an_0000000000000000/replay' })).status, 404);
});

test('replay detects a snapshot that changed under a saved analysis', async () => {
  const storage = new MemoryStorage({ snapshots: [SNAP] });
  const h = createRouter({ storage });
  const { body } = await h({ method: 'POST', path: '/api/analyses', body: { snapshotId: SNAP.id, inputs: INPUTS } });
  const corrupted = structuredClone(SNAP);
  corrupted.state.price = 1;
  storage.putSnapshot(corrupted);
  const rp = await h({ method: 'POST', path: `/api/analyses/${body.analysis.id}/replay` });
  assert.equal(rp.status, 409);
  assert.equal(rp.body.error.code, 'SNAPSHOT_HASH_MISMATCH');
});

test('bundle export → import into a fresh instance reproduces the hash', async () => {
  const a = mk();
  const { body } = await a({ method: 'POST', path: '/api/analyses', body: { snapshotId: SNAP.id, inputs: INPUTS } });
  const bundle = (await a({ path: `/api/analyses/${body.analysis.id}/bundle` })).body;
  const fresh = createRouter({ storage: new MemoryStorage() });
  const imp = await fresh({ method: 'POST', path: '/api/bundles/import', body: JSON.parse(JSON.stringify(bundle)) });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.reproducible, true);
  assert.equal((await fresh({ path: `/api/analyses/${body.analysis.id}` })).status, 200);
  // tampered bundle
  const t = JSON.parse(JSON.stringify(bundle));
  t.snapshot.market.volume24hUsd = 1;
  const bad = await createRouter({ storage: new MemoryStorage() })({ method: 'POST', path: '/api/bundles/import', body: t });
  assert.equal(bad.body.error.code, 'SNAPSHOT_HASH_MISMATCH');
  const bad2 = await fresh({ method: 'POST', path: '/api/bundles/import', body: { bundleVersion: 9 } });
  assert.equal(bad2.body.error.code, 'BUNDLE_INVALID');
});

test('import raw snapshot: created, idempotent, invalid rejected', async () => {
  const h = createRouter({ storage: new MemoryStorage() });
  const r1 = await h({ method: 'POST', path: '/api/snapshots', body: rawSnapshot() });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.snapshot.id, SNAP.id, 'content-addressed id is stable');
  assert.equal((await h({ method: 'POST', path: '/api/snapshots', body: rawSnapshot() })).status, 200);
  const bad = rawSnapshot(); bad.ticks = [];
  const r3 = await h({ method: 'POST', path: '/api/snapshots', body: bad });
  assert.equal(r3.status, 422);
  assert.equal(r3.body.error.code, 'SNAPSHOT_INVALID');
});

test('refresh: disabled, upstream down (fallback kept), failed checks, success', async () => {
  assert.equal((await mk()({ method: 'POST', path: '/api/snapshots/refresh' })).body.error.code, 'LIVE_DISABLED');
  const storage = new MemoryStorage({ snapshots: [SNAP] });
  const quiet = { log: () => {} };
  const down = createRouter({ storage, liveProvider: () => captureSnapshot(mockNetwork({ rpcDown: true }), quiet) });
  const r = await down({ method: 'POST', path: '/api/snapshots/refresh' });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(r.body.error.details.fallbackSnapshotId, SNAP.id);
  assert.equal(storage.listSnapshots().length, 1, 'nothing stored on failure');
  const mismatch = createRouter({ storage, liveProvider: () => captureSnapshot(mockNetwork({ geckoPriceFactor: 1.2 }), quiet) });
  const m = await mismatch({ method: 'POST', path: '/api/snapshots/refresh' });
  assert.equal(m.body.error.code, 'UPSTREAM_MALFORMED', 'on-chain vs GeckoTerminal price disagreement blocks the snapshot');
  const junk = createRouter({ storage, liveProvider: async () => ({ schemaVersion: 1 }) });
  assert.equal((await junk({ method: 'POST', path: '/api/snapshots/refresh' })).body.error.code, 'UPSTREAM_MALFORMED');
  const live = createRouter({ storage, liveProvider: () => captureSnapshot(mockNetwork(), { ...quiet, now: () => new Date('2026-11-12T00:00:00Z') }) });
  const ok = await live({ method: 'POST', path: '/api/snapshots/refresh' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const latest = await live({ method: 'POST', path: '/api/analyze', body: { snapshotId: 'latest', inputs: { ...INPUTS, volatilityOverride: 0.6 } } });
  assert.equal(latest.body.result.snapshot.id, ok.body.snapshot.id, '"latest" now resolves to the new snapshot');
});

test('HTTP server end to end (file storage, body limit, CORS)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lprl-'));
  cpSync(join(root, 'data/snapshots'), join(dir, 'snapshots'), { recursive: true });
  const srv = createApp({ dataDir: dir, live: false }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const h = await fetch(base + '/api/health');
    assert.equal(h.headers.get('access-control-allow-origin'), '*');
    const a = await fetch(base + '/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: 'latest', inputs: INPUTS }) });
    assert.equal(a.status, 201);
    const { analysis } = await a.json();
    assert.ok(JSON.parse(readFileSync(join(dir, 'analyses', `${analysis.id}.json`), 'utf8')).resultHash === analysis.resultHash, 'persisted to disk');
    const rp = await (await fetch(`${base}/api/analyses/${analysis.id}/replay`, { method: 'POST' })).json();
    assert.equal(rp.reproducible, true);
    assert.equal((await fetch(base + '/api/analyze', { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(base + '/api/analyze', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024) })).status, 413);
    assert.equal((await fetch(base + '/api/snapshots/refresh', { method: 'POST' })).status, 503);
    const page = await fetch(base + '/');
    assert.match(await page.text(), /Uniswap v3 LP Dashboard/);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    // path-traversal style ids never touch the filesystem
    assert.equal((await fetch(base + '/api/snapshots/..%2F..%2Fpackage')).status, 404);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
