#!/usr/bin/env node
// Build dist/index.html: one self-contained page with the same engine + API router the server uses,
// running in-page against the bundled snapshot(s). No network access is needed (or allowed) when hosted.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// dependency order matters: each module only references names defined above it
const MODULES = [
  'engine/errors.js', 'engine/sha256.js', 'engine/v3math.js', 'engine/curve.js', 'engine/stats.js', 'engine/validate.js',
  'engine/snapshot.js', 'engine/analysis.js', 'engine/tiers.js', 'api/openapi.js', 'api/memory-storage.js', 'api/router.js',
];

export function bundleModules() {
  const seen = new Map();
  const parts = MODULES.map((m) => {
    let src = readFileSync(join(root, m), 'utf8');
    src = src.replace(/^import [^;]+;\s*$/gm, '').replace(/^export \{[^}]*\};?\s*$/gm, '').replace(/^export (?=(async )?(function|const|class|let)\b)/gm, '');
    for (const [, name] of src.matchAll(/^(?:async )?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(name)) throw new Error(`top-level name collision: ${name} in ${m} and ${seen.get(name)}`);
      seen.set(name, m);
    }
    return `// ---- ${m} ----\n${src}`;
  });
  return parts.join('\n');
}

export function buildHosted(page = 'index') {
  const appJs = 'simple.js';
  const snapshots = readdirSync(join(root, 'data/snapshots')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(root, 'data/snapshots', f), 'utf8')));
  const analyses = readdirSync(join(root, 'data/analyses')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(root, 'data/analyses', f), 'utf8')));
  const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const bundle = `(function(){\n"use strict";\n${bundleModules()}\n
// ---- hosted bootstrap ----
const SEED = { snapshots: ${safe(snapshots)}, analyses: ${safe(analyses)} };
const KEY = 'lp-range-lab:analyses:v1';
let extra = [];
try { extra = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { extra = []; }
const storage = new MemoryStorage({ snapshots: SEED.snapshots, analyses: SEED.analyses.concat(extra) });
const basePut = storage.putAnalysis.bind(storage);
storage.putAnalysis = (a) => { basePut(a); try { const mine = storage.listAnalyses().filter((x) => !SEED.analyses.some((s) => s.id === x.id)); localStorage.setItem(KEY, JSON.stringify(mine)); } catch (e) {} };
window.LPAPI = { handle: createRouter({ storage, liveProvider: null, mode: 'hosted' }) };
})();`;
  const html = readFileSync(join(root, `public/${page}.html`), 'utf8')
    .replace('<link rel="stylesheet" href="simple.css">', () => `<style>\n${readFileSync(join(root, 'public/simple.css'), 'utf8')}\n</style>`)
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${readFileSync(join(root, 'public/styles.css'), 'utf8')}\n</style>`)
    .replace('<script src="charts.js"></script>', () => `<script>\n${readFileSync(join(root, 'public/charts.js'), 'utf8')}\n</script>`)
    .replace(`<script src="${appJs}"></script>`, () => `<script>\n${bundle}\n</script>\n<script>\n${readFileSync(join(root, 'public/' + appJs), 'utf8')}\n</script>`);
  if (/src="(charts|app|simple)\.js"|href="(styles|simple)\.css"/.test(html)) throw new Error('asset inlining failed');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, `dist/${page}.html`), html);
  if (page === 'index') { mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/index.html'), html); } // GitHub Pages copy
  return { bytes: html.length, snapshots: snapshots.length, analyses: analyses.length, bundle };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const page of ['index']) {
    const r = buildHosted(page);
    console.log(`dist/${page}.html  ${(r.bytes / 1024).toFixed(0)} KiB  (${r.snapshots} snapshot(s), ${r.analyses} saved analysis/es)`);
  }
}
