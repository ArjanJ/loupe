#!/usr/bin/env node
// Local dev server for the website: serves site/ + mapped demos/fonts/licenses directly from source with no build step.
// Usage: npm run site:dev   (or PORT=3000 npm run site:dev, or node scripts/dev-site.mjs --port 3000)
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from './build-site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = realpathSync(join(ROOT, 'site'));
const ROUTES = new Map(FILES.map(([src, dest]) => [dest, join(ROOT, src)]));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const insideSite = (p) => p === SITE || p.startsWith(SITE + sep);

function resolveFile(urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  const target = rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
  const ext = extname(target).toLowerCase();

  if (ROUTES.has(target)) {
    const mapped = ROUTES.get(target);
    return existsSync(mapped) && lstatSync(mapped).isFile() ? { file: mapped, ext } : null;
  }

  const candidate = normalize(join(SITE, target));
  if (!insideSite(candidate) || !existsSync(candidate)) return null;
  const st = lstatSync(candidate);
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (!insideSite(realpathSync(candidate))) return null;
  return { file: candidate, ext };
}

export function createSiteDevServer() {
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }).end('Method Not Allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad Request');
      return;
    }

    const resolved = resolveFile(pathname);
    if (!resolved) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not Found');
      return;
    }

    const body = readFileSync(resolved.file);
    res.writeHead(200, {
      'content-type': TYPES[resolved.ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
  });
}

function parsePort(argv) {
  let raw = process.env.PORT || '8080';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') { raw = argv[++i]; }
    else if (arg.startsWith('--port=')) { raw = arg.slice('--port='.length); }
    else if (/^\d+$/.test(arg)) { raw = arg; }
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`dev-site: invalid port "${raw}"`);
    process.exit(1);
  }
  return port;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const host = process.env.HOST || '127.0.0.1';
  const port = parsePort(process.argv.slice(2));
  const server = createSiteDevServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`dev-site: port ${port} is already in use (try PORT=${port + 1} npm run site:dev)`);
    } else {
      console.error(`dev-site: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`Loupe site dev server running at http://${host}:${addr.port}/`);
    console.log('Serving live from site/ + demos/ + fonts/ (no build needed; refresh after edits)');
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
