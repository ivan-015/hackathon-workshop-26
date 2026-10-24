// Local E2E server: serves public/ at the site root and mounts the real
// api/*.js default handlers behind a minimal Vercel-like req/res shim.
//
// The Claude upstream is stubbed in-process: lib/claude.js posts to a
// hard-coded API_URL with the global fetch, so this server wraps
// globalThis.fetch and answers requests to that URL with a canned job_plan
// tool call. Every other fetch (Supabase included) goes to the real network.
//
// Usage: node e2e/server.mjs   (PORT, SUPABASE_URL, ... from the environment)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API_URL } from '../lib/claude.js';
import { STUB_PLAN } from './fixtures/plans.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 4173;
const MAX_BODY_BYTES = 6 * 1024 * 1024;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

// ---- Claude stub ----------------------------------------------------------
const realFetch = globalThis.fetch;
const claudeCalls = { count: 0 };

function claudeStubResponse() {
  claudeCalls.count += 1;
  const message = {
    id: 'msg_e2e_stub',
    type: 'message',
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_e2e', name: 'job_plan', input: STUB_PLAN }],
  };
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url === API_URL) return Promise.resolve(claudeStubResponse());
  return realFetch(input, init);
};

// ---- Vercel-like shim -----------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw, contentType) {
  if (!raw) return undefined;
  if (!/application\/json/i.test(contentType || '')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // handlers re-parse strings and reject invalid JSON themselves
  }
}

function shimResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value) => {
    res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return res;
  };
  return res;
}

const handlerCache = new Map();

async function loadHandler(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  if (handlerCache.has(name)) return handlerCache.get(name);
  const file = path.join(API_DIR, `${name}.js`);
  try {
    await stat(file);
  } catch {
    return null;
  }
  const mod = await import(pathToFileURL(file).href);
  handlerCache.set(name, mod.default);
  return mod.default;
}

async function handleApi(req, res, name) {
  if (name === '__e2e') {
    // Test-only introspection: how many times the Claude stub was hit.
    return shimResponse(res).status(200).json({ claudeCalls: claudeCalls.count });
  }
  const handler = await loadHandler(name);
  if (!handler) return shimResponse(res).status(404).json({ error: 'not_found' });
  const raw = await readBody(req);
  req.body = parseJsonBody(raw, req.headers['content-type']);
  await handler(req, shimResponse(res));
  if (!res.writableEnded) res.end();
}

// ---- Static ---------------------------------------------------------------
async function handleStatic(res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  try {
    const body = await readFile(file);
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    return res.end(body);
  } catch {
    res.statusCode = 404;
    return res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const api = /^\/api\/([^/]+)\/?$/.exec(pathname);
    if (api) return await handleApi(req, res, api[1]);
    // The app lives in public/demo/; serve it at /demo as well as /demo/ (vercel.json does the same).
    return await handleStatic(res, pathname === '/demo' ? '/demo/index.html' : pathname);
  } catch (err) {
    console.error('[e2e-server]', req.method, pathname, err);
    if (!res.headersSent) res.statusCode = err.status ?? 500;
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'server_error' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e-server] http://127.0.0.1:${PORT} (SUPABASE_URL=${process.env.SUPABASE_URL ?? 'unset'})`);
});
