import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildHosted } from '../scripts/build-hosted.js';
import { analyze } from '../engine/analysis.js';
import { sealed } from './helpers.js';

test('hosted bundle runs the same router and engine as the server: identical result hash', async () => {
  const { bundle } = buildHosted();
  const store = new Map();
  const ctx = {
    window: {}, structuredClone, TextEncoder, URL,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  vm.createContext(ctx);
  vm.runInContext(bundle, ctx);
  const handle = ctx.window.LPAPI.handle;
  const health = await handle({ method: 'GET', path: '/api/health' });
  assert.equal(health.body.mode, 'hosted');
  const inputs = { capitalUsd: 10000, rangeWidthPct: 5, simulations: 300 };
  const r = await handle({ method: 'POST', path: '/api/analyze', body: { snapshotId: sealed().id, inputs } });
  assert.equal(r.status, 200);
  assert.equal(r.body.resultHash, analyze(sealed(), inputs).resultHash);
  const refresh = await handle({ method: 'POST', path: '/api/snapshots/refresh' });
  assert.equal(refresh.status, 503);
  // saving persists to localStorage when available
  const s = await handle({ method: 'POST', path: '/api/analyses', body: { snapshotId: 'latest', inputs } });
  assert.equal(s.status, 201);
  assert.ok(JSON.parse(store.get('lp-range-lab:analyses:v1')).some((a) => a.id === s.body.analysis.id));
});
