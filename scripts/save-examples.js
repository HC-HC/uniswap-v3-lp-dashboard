#!/usr/bin/env node
// Run each examples/*.json through the API router and persist it as a saved analysis.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../api/router.js';
import { FileStorage } from '../api/storage.js';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handle = createRouter({ storage: new FileStorage(join(root, 'data')), now: () => new Date('2026-11-08T23:30:00Z') });
for (const f of readdirSync(join(root, 'examples')).filter((x) => x.endsWith('.json'))) {
  const r = await handle({ method: 'POST', path: '/api/analyses', body: JSON.parse(readFileSync(join(root, 'examples', f), 'utf8')) });
  console.log(f, r.status, r.body.analysis?.id || JSON.stringify(r.body));
}
