#!/usr/bin/env node
// HTTP server: JSON API under /api/*, static frontend under /.
//   PORT=8787 RPC_URL=https://... LIVE=1 node server.js
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, INVALID_JSON } from './api/router.js';
import { FileStorage } from './api/storage.js';
import { captureSnapshot } from './providers/live.js';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 2 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createApp({ dataDir = join(root, 'data'), live = process.env.LIVE !== '0', rpcUrl = process.env.RPC_URL, fetchImpl = globalThis.fetch } = {}) {
  const storage = new FileStorage(dataDir);
  const liveProvider = live ? () => captureSnapshot(fetchImpl, { rpcUrl, log: () => {} }) : null;
  const handle = createRouter({ storage, liveProvider, mode: 'server' });

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        const declared = Number(req.headers['content-length'] || 0);
        for await (const c of req) { // drain fully so the client sees a clean 413 instead of a reset
          size += c.length;
          if (size <= MAX_BODY && declared <= MAX_BODY) chunks.push(c);
        }
        if (size > MAX_BODY || declared > MAX_BODY) {
          res.writeHead(413, { 'content-type': 'application/json', ...cors });
          return res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: `Body exceeds ${MAX_BODY} bytes` } }));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim()) { try { body = JSON.parse(text); } catch { body = INVALID_JSON; } }
      }
      const out = await handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...(out.headers || {}) });
      return res.end(JSON.stringify(out.body));
    }
    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const allowed = join(root, 'public');
    const file = normalize(join(allowed, rel));
    if (!file.startsWith(allowed) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  createApp().listen(port, () => console.log(`Uniswap v3 LP Dashboard → http://localhost:${port}  (API: /api/openapi.json)`));
}
