#!/usr/bin/env node
// Loupe: typed relationships ("how parts communicate") for a zoom tree written by `loupe scan`.
// Usage: loupe relations <repoDir> <tree.json>   (or node src/relations.mjs <repoDir> <tree.json>)
// Reads the tree plus its <tree>.files.json sidecar and statically analyses the repo for:
//   import    runtime imports between files (type-only imports are skipped)
//   http      server routes (Express/Fastify/Hono/Koa-style `app.get("/x")`, Next.js route handlers and pages/api)
//             matched to the code that calls them (fetch/axios/ky/... string literals)
//   db        Prisma model access (`prisma.user.findMany`) and Drizzle table access, pointed at the schema file
//   queue     BullMQ / pg-boss / Inngest producers and consumers paired by queue or event name, web workers
//   external  well-known SDKs and hosts, plus backends configured by *_URL environment variables
//   webhook   inbound routes under /webhook(s)
// then asks the LLM (cached) to label the rolled-up relationships and derive a few end-to-end flows.
// Writes the tree back in place (idempotent): root.children += "External services", root.relations, root.rollups, root.flows.
// LOUPE_NOLLM=1 skips uncached LLM calls (static analysis only).
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { createLlm, git, hasTrackedFiles, redactSecrets } from './llm.mjs';
import { SafeFsError, within, checkSafePath, safeDir, safeWriteFile } from './fs-safe.mjs';
import { SRC_EXT, SECRET_FILE, isMinified, gitSourceFilters } from './source.mjs';

if (!process.argv[2] || !process.argv[3]) { console.error('usage: loupe relations <repoDir> <tree.json>'); process.exit(2); }
const REPO = resolve(process.argv[2]);
const TREE = resolve(process.argv[3]);
const CACHE = resolve(process.env.LOUPE_CACHE || join(dirname(TREE), '.loupe-cache'));
const NOLLM = !!process.env.LOUPE_NOLLM;
const IGNORE = process.env.LOUPE_IGNORE ? new RegExp(process.env.LOUPE_IGNORE) : null;
const log = (...a) => console.error('[rel]', ...a);

try {
  checkSafePath(TREE, { withinDir: within(REPO, TREE) ? REPO : null });
  safeDir(CACHE, { withinDir: within(REPO, CACHE) ? REPO : null });
} catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }

// Untrusted repo: only read regular files that resolve (after symlinks) inside REPO, up to MAX_BYTES.
const REAL_REPO = realpathSync(REPO);
const MAX_BYTES = 1024 * 1024;
const insideRepo = (p) => { if (!within(REPO, resolve(REPO, p))) return false; try { return within(REAL_REPO, realpathSync(join(REPO, p))); } catch { return true; /* does not exist yet: nothing to read */ } };
const isRegularFile = (p) => { try { if (!insideRepo(p)) return false; const s = statSync(join(REPO, p)); return s.isFile() && s.size <= MAX_BYTES; } catch { return false; } };
const readRepo = (p) => (isRegularFile(p) ? readFileSync(join(REPO, p), 'utf8') : '');


const FILES = TREE.replace(/\.json$/, '') + '.files.json';
if (!existsSync(FILES)) { console.error(`${FILES} not found: run \`loupe scan\` first (relations needs its file map; manifest trees don't have one)`); process.exit(2); }
let doc, fileMap;
try { doc = JSON.parse(readFileSync(TREE, 'utf8')); fileMap = JSON.parse(readFileSync(FILES, 'utf8')); } catch (e) { console.error(`cannot read ${TREE}: ${e.message}`); process.exit(1); }
if (!doc?.root || !Array.isArray(doc.root.children) || !fileMap || typeof fileMap !== 'object') { console.error(`${TREE}: expected a tree from \`loupe scan\``); process.exit(1); }
doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
const root = doc.root;
root.children = root.children.filter((c) => c.id !== 'pkg:external'); // idempotent
delete root.relations; delete root.rollups; delete root.flows;

const nodes = new Map();
const parentOf = new Map();
(function walk(n, p) { if (p) parentOf.set(n.id, p.id); nodes.set(n.id, n); n.children.forEach((c) => walk(c, n)); })(root, null);
const ancestors = (id) => { const out = []; let cur = id; while (cur) { out.push(cur); cur = parentOf.get(cur); } return out; };

// ---------------------------------------------------------------- source files
const files = new Map(); // path -> { text, lines, node, pkg }
const wsDirs = root.children.map((c) => c.path).filter((p) => p && p !== '.').sort((a, b) => b.length - a.length);
const pkgOf = (f) => wsDirs.find((d) => f.startsWith(d + '/')) || '.';
const mapEntries = Object.entries(fileMap).filter(([f]) => SRC_EXT.test(f) && !SECRET_FILE.test(f) && !(IGNORE && IGNORE.test(f)));
const mapPaths = mapEntries.map(([f]) => f);
const filters = gitSourceFilters(REPO, mapPaths, git, mapPaths, wsDirs);
for (const [f, node] of mapEntries) {
  if (filters.isSkippedPath(f)) continue;
  const text = readRepo(f); if (!text) continue;
  if (!filters.isIncludedByAttr(f) && isMinified(text)) continue;
  files.set(f, { path: f, text, lines: text.split('\n'), node, pkg: pkgOf(f) });
}
function lineIndex(fi) { if (!fi.nl) { fi.nl = []; for (let i = 0; i < fi.text.length; i++) if (fi.text.charCodeAt(i) === 10) fi.nl.push(i); } return fi.nl; }
const lineAt = (fi, idx) => { const nl = lineIndex(fi); let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < idx) lo = m + 1; else hi = m; } return lo + 1; };
const snippet = (f, line) => redactSecrets((files.get(f)?.lines[line - 1] || '').trim().slice(0, 2000)).slice(0, 140);
const HASH_COMMENT_EXT = /\.(py|rb|ex|exs|sh|bash|zsh|fish|pl|pm|r|ya?ml|toml|conf|cfg|ini|cmake|mk|tf|tfvars|nix|jl|awk|sed)$/i;
const isCommentLine = (l, path = '') => /^\s*(\/\/|\*|\/\*|#!)/.test(l) || (HASH_COMMENT_EXT.test(path) && /^\s*#/.test(l));
const isTest = (p) => /\.(test|spec|stories)\.|__tests__|__mocks__|test-support|\/fixtures?\//.test(p);

// ---------------------------------------------------------------- relation accumulator (leaf node -> leaf node)
const rel = new Map();
function pushEv(r, ev) { if (ev && r.evidence.length < 4 && !r.evidence.some((e) => e[0] === ev[0] && e[1] === ev[1])) r.evidence.push([ev[0], ev[1], snippet(ev[0], ev[1])]); }
function add(from, to, kind, label, ev, weight = 1) {
  if (!from || !to || from === to || !nodes.has(from) || !nodes.has(to)) return null;
  const k = `${from}|${to}|${kind}`;
  let r = rel.get(k);
  if (!r) rel.set(k, (r = { from, to, kind, count: 0, labels: new Map(), evidence: [] }));
  r.count += weight;
  if (label) r.labels.set(label, (r.labels.get(label) || 0) + weight);
  pushEv(r, ev);
  return r;
}

// ---------------------------------------------------------------- workspace packages + import resolution
const pkgByName = new Map();
for (const d of [...wsDirs, '.']) { try { const pj = JSON.parse(readRepo(d === '.' ? 'package.json' : `${d}/package.json`) || '{}'); if (pj.name && !pkgByName.has(pj.name)) pkgByName.set(pj.name, d); } catch {} }
const at = (dir, rest) => (dir === '.' ? rest : `${dir}/${rest}`);
const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const firstFile = (base) => { for (const e of EXTS) if (files.has(base + e)) return base + e; const ts = base.replace(/\.(m?)js$/, '.$1ts'); if (files.has(ts)) return ts; const tsx = base.replace(/\.jsx?$/, '.tsx'); return files.has(tsx) ? tsx : null; };
function resolveSpec(from, spec) {
  if (spec.startsWith('.')) return firstFile(posix.normalize(posix.join(posix.dirname(from), spec)));
  if (spec.startsWith('@/') || spec.startsWith('~/')) { // common app alias for <package>/src
    const pkg = pkgOf(from);
    return firstFile(at(pkg, `src/${spec.slice(2)}`)) || firstFile(at(pkg, spec.slice(2)));
  }
  const parts = spec.split('/'); const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const dir = pkgByName.get(name); if (dir == null) return null;
  const sub = spec.slice(name.length + 1);
  if (sub) return firstFile(at(dir, `src/${sub}`)) || firstFile(at(dir, sub));
  return firstFile(at(dir, 'src/index')) || firstFile(at(dir, 'index')) || firstFile(at(dir, 'src/main'));
}
const importsOf = new Map(); // file -> Map(localName -> target file)
let nImports = 0;
for (const fi of files.values()) {
  const names = new Map(); importsOf.set(fi.path, names);
  for (const m of fi.text.matchAll(/(?:^|\n)[ \t]*import\s+(type\s+)?([^'";]{0,2000}?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue; // type-only imports are not runtime communication
    const target = resolveSpec(fi.path, m[3]); if (!target || target === fi.path) continue;
    const syms = [];
    const named = m[2].match(/\{([^}]*)\}/);
    if (named) for (const part of named[1].split(',')) { const p = part.trim(); if (!p || p.startsWith('type ')) continue; const [orig, alias] = p.split(/\s+as\s+/); syms.push(orig.trim()); names.set((alias || orig).trim(), target); }
    const def = m[2].replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (def) { const ns = def.match(/\*\s+as\s+(\w+)/); const nm = ns ? ns[1] : def.split(/\s+/)[0]; if (nm && nm !== 'type') { names.set(nm, target); syms.push(nm); } }
    if (named && !syms.length && !def) continue; // only types inside braces
    const line = lineAt(fi, m.index + (m[0].startsWith('\n') ? 1 : 0));
    const label = syms.length ? `uses ${syms.slice(0, 3).join(', ')}${syms.length > 3 ? ` +${syms.length - 3}` : ''}` : 'imports';
    add(fi.node, files.get(target).node, 'import', label, [fi.path, line]); nImports++;
  }
}
log('imports', nImports);

// ---------------------------------------------------------------- HTTP: server routes -> handler, callers
const routes = [];
const ROUTE_RE = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]/g;
const ROUTER_NAME = /^(app|server|router|api|fastify|instance|hono|routes|r)$|Router$|App$|Routes$/;
for (const fi of files.values()) {
  if (isTest(fi.path)) continue;
  // Express / Fastify / Hono / Koa-router style registrations
  const ms = [...fi.text.matchAll(ROUTE_RE)].filter((m) => ROUTER_NAME.test(m[1]));
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i], end = i + 1 < ms.length ? ms[i + 1].index : Math.min(fi.text.length, m.index + 20000);
    const body = fi.text.slice(m.index, end);
    // the handler is the same-package module the route body leans on most, else the file itself
    const refs = new Map();
    for (const [name, target] of importsOf.get(fi.path) || []) {
      if (target === fi.path || files.get(target)?.pkg !== fi.pkg || !/^[\w$]+$/.test(name)) continue;
      const c = (body.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
      if (c) refs.set(target, (refs.get(target) || 0) + c);
    }
    const best = [...refs].sort((a, b) => b[1] - a[1])[0];
    routes.push({ method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: m[3], file: fi.path, line: lineAt(fi, m.index), handler: best && best[1] >= 2 ? best[0] : fi.path, pkg: fi.pkg });
  }
  // Next.js app router: app/**/route.ts exporting GET/POST/...
  const app = fi.path.match(/(?:^|\/)app\/(.*?)\/?route\.(?:ts|js|mjs)$/);
  if (app) {
    const path = '/' + app[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, ':$1*').replace(/^\[(\w+)\]$/, ':$1')).join('/');
    for (const m of fi.text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) routes.push({ method: m[1], path, file: fi.path, line: lineAt(fi, m.index), handler: fi.path, pkg: fi.pkg });
  }
  // Next.js pages router: pages/api/**
  const pages = fi.path.match(/(?:^|\/)pages\/(api\/.*?)(?:\/index)?\.(?:ts|js)$/);
  if (pages) routes.push({ method: 'ANY', path: '/' + pages[1].split('/').map((s) => s.replace(/^\[(\w+)\]$/, ':$1')).join('/'), file: fi.path, line: 1, handler: fi.path, pkg: fi.pkg });
}
log('routes', routes.length);
const segs = (p) => p.split('?')[0].split('/').filter(Boolean);
function matchRoute(lit, method) {
  const ls = segs(lit); if (!ls.length) return null;
  const cands = routes.filter((r) => {
    const rs = segs(r.path); if (rs.length !== ls.length && !(rs.length && rs[rs.length - 1].endsWith('*') && ls.length >= rs.length)) return false;
    return rs.every((s, i) => s.startsWith(':') || ls[i] === ':p' || s === ls[i]) && rs.some((s, i) => !s.startsWith(':') && s === ls[i]);
  });
  const exact = (r) => segs(r.path).filter((s, i) => s === ls[i]).length;
  cands.sort((a, b) => exact(b) - exact(a) || (b.method === method) - (a.method === method));
  return cands[0] || null;
}
const CALL_CTX = /\b(fetch|axios|ky|got|request|ofetch|\$fetch|useSWR|useQuery|useMutation|api|client|http)\b|\.(get|post|put|patch|delete)\s*\(/;
let nHttp = 0;
if (routes.length) for (const fi of files.values()) {
  if (isTest(fi.path)) continue;
  for (const m of fi.text.matchAll(/(["'`])(\/(?:[A-Za-z0-9_\-.:]|\$\{[^}`]*\}|\/)+)(?:\?[^"'`]*)?\1/g)) {
    const raw = m[2]; const line = lineAt(fi, m.index); const L = fi.lines[line - 1] || '';
    if (isCommentLine(L, fi.path) || /\b(to|href|navigate|redirect|Link|src|path)\b\s*[:=(]/.test(L) || /\.(svg|png|jpe?g|webp|gif|css|js|ico|txt|xml|json|woff2?)$/.test(raw)) continue;
    const ctx = fi.lines.slice(Math.max(0, line - 2), line + 1).join('\n');
    if (!CALL_CTX.test(ctx)) continue;
    const lit = raw.replace(/\$\{[^}]*\}/g, ':p');
    const near = fi.lines.slice(line - 1, line + 8).join('\n').match(/method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i);
    const r = matchRoute(lit, near ? near[1].toUpperCase() : 'GET'); if (!r || r.file === fi.path) continue;
    const method = near ? near[1].toUpperCase() : r.method;
    const rr = add(fi.node, files.get(r.handler).node, 'http', `${method} ${r.path}`, [fi.path, line]);
    if (rr) { pushEv(rr, [r.file, r.line]); nHttp++; }
  }
}
log('http calls', nHttp);

// ---------------------------------------------------------------- data: Prisma models, Drizzle tables
const fmt = (s, n = 3) => { const a = [...s]; return a.slice(0, n).join(', ') + (a.length > n ? ` +${a.length - n}` : ''); };
const modelFile = new Map(); // prismaClientName (camel) -> { model, file }
for (const fi of files.values()) if (fi.path.endsWith('.prisma')) for (const m of fi.text.matchAll(/^model\s+(\w+)\s*\{/gm)) modelFile.set(m[1][0].toLowerCase() + m[1].slice(1), { model: m[1], file: fi.path });
const OPS = 'findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany';
const PRISMA_RE = new RegExp(`\\b(?:prisma|tx|db|client|trx|this\\.prisma|ctx\\.prisma|ctx\\.db)\\.(\\w+)\\.(${OPS})\\(`, 'g');
const READ = /^(find|count|aggregate|groupBy)/;
// Drizzle: identifiers imported from a file that declares pgTable/mysqlTable/sqliteTable
const tableFiles = new Set([...files.values()].filter((f) => /\b(pgTable|mysqlTable|sqliteTable)\s*\(/.test(f.text)).map((f) => f.path));
let nDb = 0;
for (const fi of files.values()) {
  if (isTest(fi.path) || fi.path.endsWith('.prisma') || fi.path.endsWith('.sql')) continue;
  const per = new Map(); // target file -> { reads, writes, sites }
  const hit = (file, name, write, idx) => { let d = per.get(file); if (!d) per.set(file, (d = { reads: new Set(), writes: new Set(), sites: [] })); (write ? d.writes : d.reads).add(name); d.sites.push(lineAt(fi, idx)); };
  if (modelFile.size) for (const m of fi.text.matchAll(PRISMA_RE)) { const mf = modelFile.get(m[1]); if (mf) hit(mf.file, mf.model, !READ.test(m[2]), m.index); }
  if (tableFiles.size) {
    const imp = importsOf.get(fi.path) || new Map();
    for (const m of fi.text.matchAll(/\.(from|insert|update|delete|innerJoin|leftJoin)\(\s*([A-Za-z_$][\w$]*)/g)) {
      const t = imp.get(m[2]); if (!t || !tableFiles.has(t)) continue;
      hit(t, m[2], /insert|update|delete/.test(m[1]), m.index);
    }
  }
  for (const [file, d] of per) {
    const rr = add(fi.node, files.get(file).node, 'db', '', [fi.path, d.sites[0]], d.sites.length);
    if (!rr) continue;
    rr.models = rr.models || { reads: new Set(), writes: new Set() }; d.reads.forEach((x) => rr.models.reads.add(x)); d.writes.forEach((x) => rr.models.writes.add(x));
    for (const s of d.sites.slice(1, 4)) pushEv(rr, [fi.path, s]);
    nDb++;
  }
}
log('data edges', nDb, 'prisma models', modelFile.size, 'drizzle table files', tableFiles.size);

// ---------------------------------------------------------------- queues and events: producers -> consumers by name
const PRODUCE = [
  /\b(\w*[Qq]ueue)\s*=\s*new\s+Queue\(\s*["'`]([\w:.\-/]+)["'`]/g,                 // BullMQ queue handle (name captured below)
  /\bnew\s+Queue\(\s*["'`]([\w:.\-/]+)["'`]/g,                                     // BullMQ
  /\b(?:boss|pgBoss|pgboss)\.(?:send|publish|sendAfter|insert)\(\s*["'`]([\w:.\-/]+)["'`]/g, // pg-boss
  /\b(?:inngest)\.send\(\s*\{\s*name:\s*["'`]([\w:.\-/]+)["'`]/g,                  // Inngest
  /\.publish\(\s*["'`]([\w:.\-/]+)["'`]/g,                                         // generic pub/sub
  /\.emit\(\s*["'`]([\w:.\-]+)["'`]/g,                                             // event emitters / sockets
];
const CONSUME = [
  /\bnew\s+Worker\(\s*["'`]([\w:.\-/]+)["'`]/g,                                    // BullMQ worker
  /\b(?:boss|pgBoss|pgboss)\.(?:work|subscribe)\(\s*["'`]([\w:.\-/]+)["'`]/g,
  /\bcreateFunction\([^)]{0,500}?event:\s*["'`]([\w:.\-/]+)["'`]/gs,
  /\.subscribe\(\s*["'`]([\w:.\-/]+)["'`]/g,
  /\.on\(\s*["'`]([\w:.\-]+)["'`]/g,
];
const producers = new Map(), consumers = new Map();
const note = (map, name, fi, idx) => { if (!map.has(name)) map.set(name, []); map.get(name).push([fi.path, lineAt(fi, idx)]); };
const DOM_EVENTS = /^(click|change|input|keydown|keyup|keypress|mousedown|mouseup|mousemove|pointer\w*|touch\w*|wheel|scroll|resize|load|error|message|open|close|focus|blur|submit|data|end|finish|connect|disconnect|connection|ready|exit|SIGINT|SIGTERM|uncaughtException|unhandledRejection|visibilitychange|beforeunload|unload|paste|copy|cut|drop|drag\w*|contextmenu|online|offline|storage|hashchange|popstate)$/;
for (const fi of files.values()) {
  if (isTest(fi.path)) continue;
  for (const re of PRODUCE) for (const m of fi.text.matchAll(re)) { const name = m[m.length - 1]; if (!DOM_EVENTS.test(name)) note(producers, name, fi, m.index); }
  for (const re of CONSUME) for (const m of fi.text.matchAll(re)) { const name = m[1]; if (!DOM_EVENTS.test(name)) note(consumers, name, fi, m.index); }
}
let nQueue = 0;
for (const [name, ps] of producers) {
  const cs = consumers.get(name); if (!cs) continue;
  for (const [pf, pl] of ps) for (const [cf, cl] of cs) {
    if (files.get(pf).node === files.get(cf).node) continue;
    const rr = add(files.get(pf).node, files.get(cf).node, 'queue', name, [pf, pl]);
    if (rr) { pushEv(rr, [cf, cl]); nQueue++; }
  }
}
// web workers: new Worker(new URL("./x.worker.ts", import.meta.url))
for (const fi of files.values()) for (const m of fi.text.matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]/g)) {
  const t = resolveSpec(fi.path, m[1]); if (!t) continue;
  const rr = add(fi.node, files.get(t).node, 'queue', 'posts to a web worker', [fi.path, lineAt(fi, m.index)]); if (rr) nQueue++;
}
log('queue edges', nQueue);

// ---------------------------------------------------------------- external services, webhooks
const EXT = [
  { id: 'github', label: 'GitHub', desc: 'REST/GraphQL API, OAuth and app installations.', re: /api\.github\.com|github\.com\/login\/oauth|from\s+["']@octokit\//, hook: /\/webhooks?\/github/ },
  { id: 'stripe', label: 'Stripe', desc: 'Payments, subscriptions and billing events.', re: /from\s+["']stripe["']|api\.stripe\.com|@stripe\/stripe-js/, hook: /\/webhooks?\/stripe/ },
  { id: 'slack', label: 'Slack', desc: 'Messages, bots and events.', re: /slack\.com\/api|hooks\.slack\.com|from\s+["']@slack\//, hook: /\/webhooks?\/slack/ },
  { id: 'openai', label: 'OpenAI', desc: 'Model APIs.', re: /api\.openai\.com|from\s+["']openai["']|from\s+["']@ai-sdk\/openai["']/ },
  { id: 'anthropic', label: 'Anthropic', desc: 'Model APIs.', re: /api\.anthropic\.com|from\s+["']@anthropic-ai\/sdk["']|from\s+["']@ai-sdk\/anthropic["']/ },
  { id: 'aws', label: 'AWS', desc: 'S3, SQS, SNS and other AWS APIs.', re: /from\s+["']@aws-sdk\/|from\s+["']aws-sdk["']/ },
  { id: 'gcp', label: 'Google Cloud', desc: 'Google Cloud APIs.', re: /from\s+["']@google-cloud\// },
  { id: 'firebase', label: 'Firebase', desc: 'Firestore, Storage and other Firebase services.', re: /from\s+["']firebase(?:-admin)?(?:\/[\w-]+)?["']/ },
  { id: 'supabase', label: 'Supabase', desc: 'Postgres, auth and storage as a service.', re: /from\s+["']@supabase\// },
  { id: 'sentry', label: 'Sentry', desc: 'Error and performance monitoring.', re: /from\s+["']@sentry\// },
  { id: 'posthog', label: 'PostHog', desc: 'Product analytics.', re: /from\s+["']posthog-(?:js|node)["']/ },
  { id: 'segment', label: 'Segment', desc: 'Event tracking.', re: /from\s+["']@segment\// },
  { id: 'twilio', label: 'Twilio', desc: 'SMS and voice.', re: /from\s+["']twilio["']/ },
  { id: 'email', label: 'Email provider', desc: 'Transactional email (Resend, SendGrid, Postmark, Mailgun, SES).', re: /from\s+["'](?:resend|@sendgrid\/mail|postmark|mailgun\.js|nodemailer)["']|api\.resend\.com/ },
  { id: 'auth', label: 'Auth provider', desc: 'Hosted sign-in (Auth0, Clerk, Okta, WorkOS).', re: /from\s+["'](?:@auth0\/|@clerk\/|@okta\/|@workos-inc\/)/ },
  { id: 'algolia', label: 'Algolia', desc: 'Hosted search.', re: /from\s+["'](?:algoliasearch|@algolia\/)/ },
  { id: 'redis', label: 'Redis', desc: 'Cache, queues and pub/sub.', re: /from\s+["'](?:ioredis|redis|@upstash\/redis)["']/, kind: 'db' },
  { id: 'realtime', label: 'Realtime server', desc: 'WebSocket / Socket.IO connections.', re: /from\s+["']socket\.io-client["']|import\(\s*(?:\/\*[^*]*\*\/\s*)?["']socket\.io-client["']\s*\)|new\s+WebSocket\(/ },
];
const extNode = new Map(); // id -> { label, desc }
const extCounts = new Map();
let nExt = 0;
const addExt = (id, label, desc) => { if (!extNode.has(id)) { extNode.set(id, { label, desc }); nodes.set(`ext:${id}`, { id: `ext:${id}`, children: [] }); parentOf.set(`ext:${id}`, 'pkg:external'); } };
parentOf.set('pkg:external', root.id);
for (const fi of files.values()) {
  if (isTest(fi.path)) continue;
  for (const x of EXT) {
    const hits = [];
    fi.lines.forEach((l, i) => { if (!isCommentLine(l, fi.path) && !/^\s*(import|export)\s+type\b/.test(l) && x.re.test(l)) hits.push(i + 1); });
    if (!hits.length) continue;
    addExt(x.id, x.label, x.desc);
    const rr = add(fi.node, `ext:${x.id}`, x.kind || 'external', x.kind === 'db' ? `uses ${x.label}` : `calls ${x.label}`, [fi.path, hits[0]], hits.length);
    for (const h of hits.slice(1, 4)) pushEv(rr, [fi.path, h]);
    extCounts.set(x.id, (extCounts.get(x.id) || 0) + hits.length); nExt++;
  }
  // backends configured by environment: const X = import.meta.env.VITE_APP_BACKEND_URL; fetch(`${X}/...`)
  const envAlias = new Map();
  for (const m of fi.text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]*)/g)) envAlias.set(m[1], m[2]);
  for (const m of fi.text.matchAll(/\b(fetch|axios(?:\.\w+)?|ky(?:\.\w+)?|io|socketIOClient|new\s+WebSocket|new\s+EventSource)\s*\(\s*([^,)]{0,160})/g)) {
    const arg = m[2];
    let env = (arg.match(/(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]*)/) || [])[1];
    if (!env) for (const [a, e] of envAlias) if (new RegExp(`\\b${a.replace(/\$/g, '\\$')}\\b`).test(arg)) { env = e; break; }
    const host = (arg.match(/["'`]https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/i) || [])[1];
    if (!env && !host) continue;
    if (env && (!/(URL|URI|BACKEND|HOST|ENDPOINT|SERVER|API)/.test(env) || /^(BASE_URL|PUBLIC_URL|BASE_PATH|ASSET_PREFIX|ASSET_URL|.*_BASE_PATH)$/.test(env))) continue; // the app's own origin
    const base = env ? env.replace(/^(VITE_APP_|VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)/, '').replace(/_(URL|URI|ENDPOINT)$/, '').replace(/_(GET|POST|PUT|READ|WRITE)$/, '') : host.replace(/^(www|api)\./, '');
    const id = 'cfg-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const label = env ? base.split('_').filter(Boolean).map((w) => (w.length <= 3 ? w.toUpperCase() : w[0] + w.slice(1).toLowerCase())).join(' ') : base;
    addExt(id, label, env ? `A backend configured by ${env}.` : `Called at ${host}.`);
    const line = lineAt(fi, m.index);
    const rr = add(fi.node, `ext:${id}`, 'external', /^io$|socket|EventSource/i.test(m[1]) ? `connects to ${label}` : `calls ${label}`, [fi.path, line]);
    if (rr) { extCounts.set(id, (extCounts.get(id) || 0) + 1); nExt++; }
  }
}
// a socket SDK plus a configured socket server are the same thing: fold the generic node into the named one
{
  const named = [...extNode.keys()].find((id) => id.startsWith('cfg-') && /(^|-)(ws|wss|socket|realtime|collab)(-|$)/.test(id));
  if (named && extNode.has('realtime')) {
    for (const [k, r] of [...rel]) if (r.to === 'ext:realtime') {
      rel.delete(k);
      const rr = add(r.from, `ext:${named}`, 'external', `connects to ${extNode.get(named).label}`, r.evidence[0], r.count);
      if (rr) for (const e of r.evidence.slice(1)) pushEv(rr, e);
      extCounts.set(named, (extCounts.get(named) || 0) + (extCounts.get('realtime') || 0));
    }
    extCounts.delete('realtime');
  }
}
for (const r of routes) {
  if (!/\/webhooks?(\/|$)/.test(r.path)) continue;
  const x = EXT.find((e) => e.hook && e.hook.test(r.path));
  const id = x ? x.id : 'webhook-senders';
  if (!x) addExt(id, 'Webhook senders', 'Third parties that call this system’s webhook routes.'); else addExt(x.id, x.label, x.desc);
  add(`ext:${id}`, files.get(r.handler).node, 'webhook', `${r.method} ${r.path}`, [r.file, r.line]);
  extCounts.set(id, (extCounts.get(id) || 0) + 1); nExt++;
}
log('external edges', nExt);

const totalW = root.children.reduce((a, c) => a + c.weight, 0);
const used = [...extNode].filter(([id]) => extCounts.get(id));
if (used.length) {
  const extGroup = { id: 'pkg:external', label: 'External services', kind: 'package', external: true, path: 'outside the repo',
    weight: Math.round(totalW * 0.07), shortDescription: `Third-party services and backends ${root.label} talks to.`,
    longDescription: `Detected from SDK imports, API hosts, *_URL settings and webhook routes: ${used.map(([, x]) => x.label).join(', ')}.`,
    children: used.map(([id, x]) => ({ id: `ext:${id}`, label: x.label, kind: 'external', path: 'external service', weight: Math.max(30, Math.round(Math.sqrt(extCounts.get(id)) * 40)), shortDescription: x.desc, longDescription: '', functions: [], children: [], edges: [] })), edges: [] };
  root.children.push(extGroup);
  nodes.set(extGroup.id, extGroup);
  for (const c of extGroup.children) nodes.set(c.id, c);
}
for (const [id] of extNode) if (!extCounts.get(id)) nodes.delete(`ext:${id}`);

// ---------------------------------------------------------------- finalise leaf relations
const KIND_ORDER = ['http', 'queue', 'db', 'external', 'webhook', 'sandbox', 'import'];
const relations = [...rel.values()].filter((r) => nodes.has(r.from) && nodes.has(r.to)).map((r) => {
  const labels = [...r.labels].sort((a, b) => b[1] - a[1]);
  let label = labels[0]?.[0] || r.kind;
  if (r.kind === 'http' && labels.length > 1) label = `${labels.length} routes`;
  if (r.kind === 'db' && r.models) label = [r.models.reads.size ? `reads ${fmt(r.models.reads)}` : '', r.models.writes.size ? `writes ${fmt(r.models.writes)}` : ''].filter(Boolean).join(' · ');
  if (r.kind === 'queue' && labels.length > 1) label = labels.map((l) => l[0]).slice(0, 2).join(', ');
  const details = r.kind === 'db' && r.models ? [...[...r.models.writes].map((m) => `writes ${m}`), ...[...r.models.reads].map((m) => `reads ${m}`)].slice(0, 10) : labels.slice(0, 8).map((l) => l[0]);
  return { id: '', from: r.from, to: r.to, kind: r.kind, label, count: r.count, details, evidence: r.evidence };
});
relations.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.count - a.count);
relations.forEach((r, i) => (r.id = `r${i}`));
const byKind = {}; for (const r of relations) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
const countByKind = {}; for (const r of relations) countByKind[r.kind] = (countByKind[r.kind] || 0) + r.count;
log('relations', relations.length, JSON.stringify(byKind), 'sites', JSON.stringify(countByKind));

// ---------------------------------------------------------------- roll-ups (module and package level) + Claude labels
const levelOf = (id) => ancestors(id).length - 1;
const atDepth = (id, d) => { const a = ancestors(id).reverse(); return a[Math.min(d, a.length - 1)]; };
function rollup(depth) {
  const m = new Map();
  for (const r of relations) {
    const a = atDepth(r.from, depth), b = atDepth(r.to, depth);
    if (a === b || ancestors(a).includes(b) || ancestors(b).includes(a)) continue;
    const k = `${a}|${b}`;
    let e = m.get(k); if (!e) m.set(k, (e = { from: a, to: b, kinds: {}, count: 0, samples: [] }));
    e.kinds[r.kind] = (e.kinds[r.kind] || 0) + r.count; e.count += r.count;
    if (e.samples.length < 10) e.samples.push(`${r.kind}: ${r.label}`);
  }
  return [...m.values()];
}
const pkgPairs = rollup(1), modPairs = rollup(2);
log('rollups', pkgPairs.length, 'package pairs,', modPairs.length, 'module pairs');

const untrustedCache = !!process.env.LOUPE_UNTRUSTED_CACHE || hasTrackedFiles(REPO, CACHE);
if (!process.env.LOUPE_UNTRUSTED_CACHE && untrustedCache) {
  console.error(`loupe: warning: cache directory ${CACHE} has files tracked by git; ignoring cached answers.`);
}
const llm = createLlm({ cache: CACHE, log, nollm: NOLLM, onFail: 'empty', trustCache: !untrustedCache });
const nodeLine = (id) => { const n = nodes.get(id); return `${id} = "${n.label}" (${n.shortDescription || ''})`; };
const pairLine = (p) => `${p.from} -> ${p.to} | ${Object.entries(p.kinds).map(([k, v]) => `${k}×${v}`).join(', ')} | e.g. ${p.samples.slice(0, 6).join('; ')}`;
const LABEL_RULES = `For each relationship write "label": 2-5 lowercase words saying what flows or what the caller does (e.g. "renders the scene", "reads user records", "posts alerts"), and "summary": one plain sentence, max 16 words. Be concrete, use the evidence, no marketing words. Answer with ONLY a JSON object, no prose, no code fences.`;
const rollups = {};
async function labelPairs(tag, pairs, ctxIds) {
  if (!pairs.length) return;
  const prompt = `You are labelling relationships on an architecture map of the "${root.label}" codebase. Kinds: import (code dependency/direct call), http (client -> API route), queue (async: job queues, pub/sub events, web workers), db (ORM/SQL reads and writes), external (outbound call to a third party or configured backend), webhook (third party calls in), sandbox (code run in a sandbox).
Nodes:
${ctxIds.map(nodeLine).join('\n')}
Relationships (from -> to | kinds with counts | evidence labels):
${pairs.map(pairLine).join('\n')}

${LABEL_RULES}
Schema: {"pairs":{"<from> -> <to>":{"label":"...","summary":"..."}}}`;
  const out = await llm(tag, prompt);
  const got = out && typeof out.pairs === 'object' && out.pairs ? out.pairs : {};
  for (const p of pairs) { const v = got[`${p.from} -> ${p.to}`]; if (v && typeof v === 'object') rollups[`${p.from}|${p.to}`] = { label: String(v.label || '').slice(0, 48), summary: String(v.summary || '').slice(0, 160) }; }
}
const pkgIds = root.children.map((c) => c.id);
const jobs = [labelPairs('rel-packages', pkgPairs, pkgIds)];
for (const pid of pkgIds) {
  const pairs = modPairs.filter((p) => atDepth(p.from, 1) === pid).sort((a, b) => b.count - a.count).slice(0, 60);
  const ids = [...new Set(pairs.flatMap((p) => [p.from, p.to]))];
  jobs.push(labelPairs(`rel-mods-${pid}`, pairs, ids));
}
await Promise.all(jobs);
log('rollup labels', Object.keys(rollups).length);

// ---------------------------------------------------------------- flows (Claude, validated against the map)
const modIds = [...nodes.keys()].filter((id) => levelOf(id) === 2);
const topMod = modPairs.filter((p) => p.count >= 2 || !p.kinds.import).sort((a, b) => b.count - a.count).slice(0, 140);
const flowPrompt = `You are explaining how the "${root.label}" codebase works end to end, for an interactive architecture map.
System: ${root.shortDescription}
Map nodes (module level, plus external services):
${modIds.map(nodeLine).join('\n')}
Detected relationships between them (from -> to | kinds | evidence; each one is real, statically detected):
${topMod.map((p) => `${pairLine(p)}${rollups[`${p.from}|${p.to}`] ? ` | "${rollups[`${p.from}|${p.to}`].label}"` : ''}`).join('\n') || '(none detected statically)'}
Some HTTP routes: ${routes.slice(0, 120).map((r) => `${r.method} ${r.path}`).join(', ') || '(none detected)'}

Task: describe the 4 most important end-to-end flows a new engineer should understand (what happens when a user does the main things this system is for). Each flow is 3-7 steps; each step moves from one node to another node using the ids above, and should use a pair from the relationships list whenever one fits. Step text: max 9 words, present tense.
Answer with ONLY a JSON object, no prose, no code fences.
Schema: {"flows":[{"id":"kebab","title":"2-5 words","summary":"one sentence, max 18 words","steps":[{"from":"<node id>","to":"<node id>","kind":"http|queue|db|external|webhook|sandbox|import","text":"..."}]}]}`;
const flowOut = await llm('rel-flows', flowPrompt);
const KINDS = new Set(KIND_ORDER);
const pairSet = new Set(modPairs.map((p) => `${p.from}|${p.to}`));
const flows = (Array.isArray(flowOut?.flows) ? flowOut.flows : []).map((f, i) => {
  const steps = (Array.isArray(f?.steps) ? f.steps : []).filter((s) => s && nodes.has(s.from) && nodes.has(s.to) && s.from !== s.to)
    .map((s) => ({ from: s.from, to: s.to, kind: KINDS.has(s.kind) ? s.kind : 'import', text: String(s.text || '').slice(0, 80), detected: pairSet.has(`${s.from}|${s.to}`) || pairSet.has(`${s.to}|${s.from}`) }));
  return { id: String(f?.id || `flow-${i}`).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || `flow-${i}`, title: String(f?.title || `Flow ${i + 1}`).slice(0, 40), summary: String(f?.summary || '').slice(0, 160), steps };
}).filter((f) => f.steps.length >= 2).slice(0, 5);
log('flows', flows.map((f) => `${f.title} (${f.steps.length} steps, ${f.steps.filter((s) => s.detected).length} detected)`).join('; '));

// ---------------------------------------------------------------- write
root.relations = relations; root.rollups = rollups; root.flows = flows;
doc.meta.relationCount = relations.length; doc.meta.relationKinds = byKind; doc.meta.relationSites = countByKind; doc.meta.routeCount = routes.length; doc.meta.flowCount = flows.length;
let nodeCount = 0; const perLevel = [];
(function walk(n, d) { nodeCount++; perLevel[d] = (perLevel[d] || 0) + 1; n.children.forEach((c) => walk(c, d + 1)); })(root, 0);
doc.meta.nodeCount = nodeCount; doc.meta.nodesPerLevel = perLevel;
try { safeWriteFile(TREE, JSON.stringify(doc, null, 2), { withinDir: within(REPO, TREE) ? REPO : null }); }
catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }
log(llm.summary());
log('wrote', TREE, JSON.stringify({ relations: relations.length, byKind, routes: routes.length, flows: flows.length, nodes: nodeCount }));
