#!/usr/bin/env node
// Validate a raw capture (from scripts/fetch-snapshot.mjs), content-address it, and store it in data/snapshots/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealSnapshot } from '../engine/snapshot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('usage: seal-snapshot.js <capture.json>'); process.exit(2); }
try {
  const sealed = sealSnapshot(JSON.parse(readFileSync(file, 'utf8')));
  mkdirSync(join(root, 'data', 'snapshots'), { recursive: true });
  const out = join(root, 'data', 'snapshots', `${sealed.id}.json`);
  writeFileSync(out, JSON.stringify(sealed, null, 2) + '\n');
  console.log(`${sealed.id}  ${sealed.contentHash}\n→ ${out}`);
} catch (e) {
  console.error(e.message, e.details ? JSON.stringify(e.details, null, 2) : '');
  process.exit(1);
}
