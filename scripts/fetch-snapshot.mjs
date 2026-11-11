#!/usr/bin/env node
// Capture live data (public Ethereum RPC + GeckoTerminal, no keys), keep the raw capture, and seal it.
//   node scripts/fetch-snapshot.mjs [--tier 1|5|30|100]     (optional: RPC_URL=https://...)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../providers/live.js';
import { sealSnapshot } from '../engine/snapshot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const i = process.argv.indexOf('--tier');
  const raw = await captureSnapshot(globalThis.fetch, { rpcUrl: process.env.RPC_URL, tier: i > 0 ? Number(process.argv[i + 1]) : 5 });
  const sealed = sealSnapshot(raw);
  mkdirSync(join(root, 'data/raw'), { recursive: true });
  mkdirSync(join(root, 'data/snapshots'), { recursive: true });
  writeFileSync(join(root, 'data/raw', `${raw.capturedAt.replace(/[:.]/g, '-')}-block-${raw.state.block}.json`), JSON.stringify(raw, null, 2));
  writeFileSync(join(root, 'data/snapshots', `${sealed.id}.json`), JSON.stringify(sealed, null, 2) + '\n');
  console.log(`sealed ${sealed.id} · block ${raw.state.block} · price ${raw.state.price.toFixed(2)} · ${raw.ticks.length} ticks · ${raw.history.length} days`);
} catch (e) { console.error('FAILED:', e.message); process.exit(1); }
