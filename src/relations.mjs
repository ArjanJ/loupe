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
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { createLlm, git, hasTrackedFiles, redactSecrets } from './llm.mjs';
import { SafeFsError, within, checkSafePath, safeDir, safeWriteFile, repoReader } from './fs-safe.mjs';
import { SRC_EXT, SECRET_FILE, isMinified, gitSourceFilters, gitIgnoredTracked } from './source.mjs';

if (!process.argv[2] || !process.argv[3]) { console.error('usage: loupe relations <repoDir> <tree.json>'); process.exit(2); }
const REPO = resolve(process.argv[2]);
const TREE = resolve(process.argv[3]);
const CACHE = resolve(process.env.LOUPE_CACHE || join(dirname(TREE), '.loupe-cache'));
const NOLLM = !!process.env.LOUPE_NOLLM;
let IGNORE = null;
try { IGNORE = process.env.LOUPE_IGNORE ? new RegExp(process.env.LOUPE_IGNORE) : null; } catch (e) { console.error(`loupe: invalid LOUPE_IGNORE: ${e.message}`); process.exit(2); }
const log = (...a) => console.error('[rel]', ...a);

try {
  checkSafePath(TREE, { withinDir: within(REPO, TREE) ? REPO : null });
  safeDir(CACHE, { withinDir: within(REPO, CACHE) ? REPO : null });
} catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }

// Untrusted repo: the same rules as `loupe scan` for every file read: tracked by git, not secret-looking, a regular
// file of at most 1 MiB, and no symlink on the way. Source files are also not LOUPE_IGNOREd (tracked files matching
// .gitignore are left to gitSourceFilters, where .gitattributes can re-include them); config files (package.json,
// tsconfig, go.mod, Cargo.toml, ...) must not match .gitignore. The sidecar file map is only a list of candidates.
let tracked, ignoredTracked;
try {
  tracked = new Set(git(REPO, ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean));
  ignoredTracked = gitIgnoredTracked(REPO, git);
} catch (e) {
  console.error(e.code === 'ENOENT' ? 'loupe: git is not installed: Loupe only reads the files git tracks.' : `loupe: ${REPO} is not inside a git repository (or git failed there): Loupe only reads the files git tracks.`);
  process.exit(2);
}
const baseRule = (p) => tracked.has(p) && !SECRET_FILE.test(p);
const source = repoReader(REPO, { allow: (p) => baseRule(p) && !(IGNORE && IGNORE.test(p)) });
const config = repoReader(REPO, { allow: (p) => baseRule(p) && !ignoredTracked.has(p) });
const isRegularFile = config.isRegularFile;
const readRepo = config.read;

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
const filters = gitSourceFilters(REPO, mapPaths, git, mapPaths, wsDirs, ignoredTracked);
for (const [f, node] of mapEntries) {
  if (filters.isSkippedPath(f)) continue;
  const text = source.read(f); if (!text) continue;
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
// tsconfig/jsconfig path aliases ("paths" + "baseUrl"), from the nearest config above the importing file.
// Configs are JSONC; local "extends" chains are followed, package ones (node_modules) are not.
function parseJsonc(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
function loadTsconfig(file, depth = 0) {
  let cfg; try { cfg = parseJsonc(readRepo(file) || ''); } catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;
  const dir = posix.dirname(file);
  const own = cfg.compilerOptions || {};
  let base = { paths: null, baseUrl: null };
  for (const ext of [].concat(cfg.extends || [])) {
    if (depth > 4 || typeof ext !== 'string' || !ext.startsWith('.')) continue;
    let p = posix.normalize(posix.join(dir, ext)); if (!p.endsWith('.json')) p += '.json';
    const parent = loadTsconfig(p, depth + 1); if (parent) base = { paths: parent.paths || base.paths, baseUrl: parent.baseUrl || base.baseUrl };
  }
  const baseUrl = typeof own.baseUrl === 'string' ? posix.normalize(posix.join(dir, own.baseUrl)) : base.baseUrl;
  // "paths" entries resolve against baseUrl when set, else against the config that declares them
  const paths = own.paths && typeof own.paths === 'object' ? { map: own.paths, root: baseUrl || dir } : base.paths;
  return { paths, baseUrl };
}
const tsconfigCache = new Map(); // dir -> config | null
function tsconfigFor(from) {
  const chain = [];
  let dir = posix.dirname(from);
  for (;;) {
    if (tsconfigCache.has(dir)) { const hit = tsconfigCache.get(dir); chain.forEach((d) => tsconfigCache.set(d, hit)); return hit; }
    chain.push(dir);
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = dir === '.' ? name : `${dir}/${name}`;
      if (isRegularFile(file)) { const cfg = loadTsconfig(file); chain.forEach((d) => tsconfigCache.set(d, cfg)); return cfg; }
    }
    if (dir === '.' || dir === '') { chain.forEach((d) => tsconfigCache.set(d, null)); return null; }
    dir = posix.dirname(dir);
  }
}
function resolveAlias(from, spec) {
  const cfg = tsconfigFor(from); if (!cfg) return null;
  if (cfg.paths) {
    let best = null; // longest matching prefix wins, as in TypeScript
    for (const [pattern, targets] of Object.entries(cfg.paths.map)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf('*');
      const prefix = star < 0 ? pattern : pattern.slice(0, star), suffix = star < 0 ? '' : pattern.slice(star + 1);
      const hit = star < 0 ? spec === pattern : spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length;
      if (hit && (!best || prefix.length > best.prefix.length)) best = { prefix, targets, rest: star < 0 ? '' : spec.slice(prefix.length, spec.length - suffix.length) };
    }
    if (best) for (const t of best.targets) {
      if (typeof t !== 'string') continue;
      const p = firstFile(posix.normalize(posix.join(cfg.paths.root, t.replace('*', best.rest))));
      if (p) return p;
    }
  }
  return cfg.baseUrl ? firstFile(posix.normalize(posix.join(cfg.baseUrl, spec))) : null;
}
function resolveSpec(from, spec) {
  if (spec.startsWith('.')) return firstFile(posix.normalize(posix.join(posix.dirname(from), spec)));
  const aliased = resolveAlias(from, spec); if (aliased) return aliased;
  if (spec.startsWith('@/') || spec.startsWith('~/')) { // common app alias for <package>/src
    const pkg = pkgOf(from);
    return firstFile(at(pkg, `src/${spec.slice(2)}`)) || firstFile(at(pkg, spec.slice(2)));
  }
  if (spec === '$lib' || spec.startsWith('$lib/')) return firstFile(at(pkgOf(from), `src/lib${spec.slice(4)}`)); // SvelteKit
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
  // CommonJS: `const x = require('./a')`, `const { a, b: c } = require('./a')`, `require('./a').x`, bare `require('./a')`
  if (!/\.[cm]?[jt]sx?$/.test(fi.path)) continue;
  for (const m of fi.text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)(\s*\.\s*[\w$]+)?/g)) {
    const line = lineAt(fi, m.index);
    if (isCommentLine(fi.lines[line - 1] || '', fi.path)) continue;
    const target = resolveSpec(fi.path, m[1]); if (!target || target === fi.path) continue;
    const syms = [];
    const bind = fi.text.slice(Math.max(0, m.index - 2000), m.index).match(/\b(?:const|let|var)\s+(\{[^{}]*\}|[\w$]+)\s*=\s*$/);
    if (bind && bind[1].startsWith('{')) {
      for (const part of bind[1].slice(1, -1).split(',')) {
        const [key, local] = part.replace(/=.*$/s, '').split(':').map((s) => s.trim());
        if (!key || key.startsWith('...')) continue;
        syms.push(key); names.set(local || key, target);
      }
    } else if (bind) {
      names.set(bind[1], target);
      syms.push(m[2] ? m[2].replace(/[\s.]/g, '') : bind[1]);
    }
    add(fi.node, files.get(target).node, 'import', usesLabel(syms), [fi.path, line]); nImports++;
  }
}
function usesLabel(syms) { return syms.length ? `uses ${syms.slice(0, 3).join(', ')}${syms.length > 3 ? ` +${syms.length - 3}` : ''}` : 'imports'; }
nImports += pythonImports() + goImports() + javaImports() + phpImports() + rustImports();
log('imports', nImports);

// Python: `import a.b`, `from a.b import c`, relative `from ..x import y`; skips docstrings and `if TYPE_CHECKING:` blocks.
// Absolute modules resolve by path suffix (so src/ layouts work) when the directory above the top package is not itself a package.
function pythonImports() {
  const py = [...files.keys()].filter((f) => f.endsWith('.py'));
  if (!py.length) return 0;
  const initCache = new Map();
  const hasInit = (dir) => { if (!initCache.has(dir)) initCache.set(dir, isRegularFile(dir === '' ? '__init__.py' : `${dir}/__init__.py`)); return initCache.get(dir); };
  const modKey = (f) => f.replace(/(^|\/)__init__\.py$/, '').replace(/\.py$/, '');
  const byLast = new Map(); // last path segment -> [[modKey, file]]
  for (const f of py) { const k = modKey(f); if (!k) continue; const last = k.split('/').pop(); if (!byLast.has(last)) byLast.set(last, []); byLast.get(last).push([k, f]); }
  const exact = (rel) => (files.has(`${rel}.py`) ? `${rel}.py` : files.has(`${rel}/__init__.py`) ? `${rel}/__init__.py` : null);
  function resolve(from, mod, level) {
    if (level > 0) {
      let base = posix.dirname(from); for (let i = 1; i < level; i++) base = posix.dirname(base);
      if (!mod) return exact(base === '.' ? '' : base) || (files.has(`${base}/__init__.py`) ? `${base}/__init__.py` : null);
      return exact(posix.normalize(`${base}/${mod.replace(/\./g, '/')}`).replace(/^\.\//, ''));
    }
    const rel = mod.replace(/\./g, '/');
    const cands = (byLast.get(rel.split('/').pop()) || []).filter(([k]) => {
      if (k !== rel && !k.endsWith(`/${rel}`)) return false;
      const prefix = k.slice(0, k.length - rel.length).replace(/\/$/, '');
      return !hasInit(prefix);
    });
    if (!cands.length) return null;
    const pkg = pkgOf(from);
    cands.sort((a, b) => (pkgOf(b[1]) === pkg) - (pkgOf(a[1]) === pkg) || a[0].length - b[0].length);
    return cands[0][1];
  }
  let n = 0;
  for (const fi of files.values()) {
    if (!fi.path.endsWith('.py')) continue;
    const names = importsOf.get(fi.path) || new Map(); importsOf.set(fi.path, names);
    const lines = fi.lines;
    let inStr = null, tcIndent = -1;
    const edges = new Map(); // target -> { syms, line }
    const hit = (target, sym, line) => { if (!target || target === fi.path) return; let e = edges.get(target); if (!e) edges.set(target, (e = { syms: [], line })); if (sym && !e.syms.includes(sym)) e.syms.push(sym); };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (inStr) { const j = raw.indexOf(inStr); if (j < 0) continue; const rest = raw.slice(j + 3); inStr = null; const t = rest.match(/"""|'''/g); if (t && t.length % 2) inStr = t[t.length - 1]; continue; }
      const indent = raw.match(/^\s*/)[0].length;
      if (tcIndent >= 0 && raw.trim() && indent <= tcIndent && !/^\s*#/.test(raw)) tcIndent = -1;
      if (/^\s*if\s+(?:typing\.)?TYPE_CHECKING\s*:\s*(#.*)?$/.test(raw)) { tcIndent = indent; continue; }
      const m = tcIndent < 0 && raw.match(/^\s*(?:from\s+(\.*)([\w.]*)\s+import\s+(.*)|import\s+(.*))$/);
      if (m) {
        let rest = (m[3] ?? m[4]).replace(/#.*$/, '').trim();
        let j = i;
        if (rest.startsWith('(')) { while (!rest.includes(')') && j + 1 < lines.length) rest += ' ' + lines[++j].replace(/#.*$/, '').trim(); rest = rest.replace(/[()]/g, ''); }
        else while (rest.endsWith('\\') && j + 1 < lines.length) rest = rest.slice(0, -1) + ' ' + lines[++j].replace(/#.*$/, '').trim();
        const parts = rest.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [orig, alias] = s.split(/\s+as\s+/); return [orig.trim(), (alias || orig).trim()]; });
        const line = i + 1;
        if (m[4] !== undefined) { // import a.b.c [as d]
          for (const [orig, alias] of parts) {
            const segs = orig.split('.'); let target = null;
            for (let k = segs.length; k > 0 && !target; k--) target = resolve(fi.path, segs.slice(0, k).join('.'), 0);
            if (target) { hit(target, null, line); names.set(alias.split('.')[0], target); }
          }
        } else {
          const level = m[1].length, mod = m[2];
          const base = resolve(fi.path, mod, level);
          for (const [orig, alias] of parts) {
            if (orig === '*') { hit(base, null, line); continue; }
            const sub = resolve(fi.path, mod ? `${mod}.${orig}` : orig, level);
            if (sub) { hit(sub, null, line); names.set(alias, sub); } else if (base) { hit(base, orig, line); names.set(alias, base); }
          }
        }
        i = j; continue;
      }
      const t = raw.replace(/#.*$/, '').match(/"""|'''/g);
      if (t && t.length % 2) inStr = t[t.length - 1];
    }
    for (const [target, e] of edges) { add(fi.node, files.get(target).node, 'import', usesLabel(e.syms), [fi.path, e.line]); n++; }
  }
  return n;
}

// Go: imports of packages inside the repo's own module(s) (go.mod), attributed to the file that declares each `pkg.Symbol`
// used; plus references between files of the same package, which share names without importing each other.
function goImports() {
  const goFiles = [...files.values()].filter((f) => f.path.endsWith('.go'));
  if (!goFiles.length) return 0;
  const strip = (l) => l.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/\/.*$/, '');
  // modules: go.mod in any ancestor directory of a .go file
  const modOfDir = new Map(), modules = new Map(); // module path -> dir
  const findMod = (dir) => {
    if (modOfDir.has(dir)) return modOfDir.get(dir);
    const txt = readRepo(dir === '.' ? 'go.mod' : `${dir}/go.mod`); const mm = txt.match(/^module\s+(\S+)/m);
    const out = mm ? (modules.set(mm[1], dir), dir) : dir === '.' ? null : findMod(posix.dirname(dir));
    modOfDir.set(dir, out); return out;
  };
  // packages: dir -> { files, name, decls: ident -> file (null when declared in more than one file) }
  const pkgs = new Map();
  for (const fi of goFiles) {
    const dir = posix.dirname(fi.path); findMod(dir);
    let p = pkgs.get(dir); if (!p) pkgs.set(dir, (p = { files: [], name: null, decls: new Map() }));
    p.files.push(fi);
    const pm = fi.text.match(/^package\s+(\w+)/m); if (pm && !p.name) p.name = pm[1];
    const decl = (id) => { if (id === '_' || id === 'init' || id === 'main') return; p.decls.set(id, p.decls.has(id) && p.decls.get(id) !== fi.path ? null : fi.path); };
    let block = null;
    for (const l of fi.lines) {
      if (block) { if (/^\)/.test(l)) { block = null; continue; } const bm = l.match(/^\t([A-Za-z_]\w*)\b/); if (bm) decl(bm[1]); continue; }
      const bo = l.match(/^(var|const|type)\s*\(\s*$/); if (bo) { block = bo[1]; continue; }
      const dm = l.match(/^func\s+([A-Za-z_]\w*)\s*[[(]/) || l.match(/^(?:type|var|const)\s+([A-Za-z_]\w*)\b/); if (dm) decl(dm[1]);
    }
  }
  const pkgDirFor = (path) => {
    let best = null;
    for (const [mod, dir] of modules) if ((path === mod || path.startsWith(mod + '/')) && (!best || mod.length > best[0].length)) best = [mod, dir];
    if (!best) return null;
    const sub = path.slice(best[0].length + 1); const d = !sub ? best[1] : best[1] === '.' ? sub : `${best[1]}/${sub}`;
    return pkgs.has(d) ? d : null;
  };
  const repFile = (p) => (p.files.find((f) => posix.basename(f.path, '.go') === p.name || posix.basename(f.path, '.go') === posix.basename(posix.dirname(f.path))) || p.files[0]).path;
  let n = 0;
  for (const fi of goFiles) {
    const dir = posix.dirname(fi.path), own = pkgs.get(dir);
    const edges = new Map(); // target -> { syms, line }
    const hit = (target, sym, line) => { if (!target || target === fi.path) return; let e = edges.get(target); if (!e) edges.set(target, (e = { syms: [], line })); if (sym && !e.syms.includes(sym)) e.syms.push(sym); };
    // imports
    const imports = []; // { alias, dir, line }
    let inBlock = false;
    fi.lines.forEach((l, i) => {
      if (inBlock) { if (/^\s*\)/.test(l)) { inBlock = false; return; } }
      else if (/^import\s*\(\s*$/.test(l)) { inBlock = true; return; }
      const im = inBlock ? l.match(/^\s*([\w.]+\s+)?"([^"]+)"/) : l.match(/^import\s+([\w.]+\s+)?"([^"]+)"/);
      if (!im) return;
      const target = pkgDirFor(im[2]); if (!target) return;
      const alias = im[1]?.trim() || pkgs.get(target).name || posix.basename(im[2]);
      imports.push({ alias, dir: target, line: i + 1 });
    });
    for (const imp of imports) {
      const p = pkgs.get(imp.dir); let found = false;
      if (/^\w+$/.test(imp.alias) && imp.alias !== '_') {
        const re = new RegExp(`(?<![\\w.])${imp.alias}\\.([A-Za-z_]\\w*)`, 'g');
        fi.lines.forEach((l, i) => { if (i + 1 === imp.line || isCommentLine(l, fi.path)) return; for (const m of strip(l).matchAll(re)) { const f = p.decls.get(m[1]); if (f) { hit(f, m[1], i + 1); found = true; } } });
      }
      if (!found) hit(repFile(p), null, imp.line);
    }
    // same-package references (only names declared in exactly one other file of this package)
    if (own && own.files.length > 1) {
      const ID = /(?<![\w.])([A-Za-z_]\w+)\b/g;
      fi.lines.forEach((l, i) => {
        if (/^\s*(import\b|"[^"]*"\s*$|package\s)/.test(l) || isCommentLine(l, fi.path)) return;
        for (const m of strip(l).matchAll(ID)) { const f = own.decls.get(m[1]); if (f && f !== fi.path) hit(f, m[1], i + 1); }
      });
    }
    for (const [target, e] of edges) { add(fi.node, files.get(target).node, 'import', usesLabel(e.syms), [fi.path, e.line]); n++; }
  }
  return n;
}

// shared by the Java/Kotlin, PHP and Rust detectors: per-file edge collector and comment/string stripping
function edgeCollector(fi) {
  const edges = new Map(); // target -> { syms, line }
  return {
    hit(target, sym, line) { if (!target || target === fi.path || !files.has(target)) return; let e = edges.get(target); if (!e) edges.set(target, (e = { syms: [], line })); if (sym && !e.syms.includes(sym)) e.syms.push(sym); },
    flush() { let n = 0; for (const [target, e] of edges) { add(fi.node, files.get(target).node, 'import', usesLabel(e.syms), [fi.path, e.line]); n++; } return n; },
  };
}
// single-char quotes only for '…' unless multiChar (PHP), so Rust lifetimes ('a) are not read as strings
function stripCode(l, { multiChar = false, hash = false } = {}) {
  const s = l.replace(multiChar ? /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g : /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, '""').replace(/\/\/.*$/, '');
  return hash ? s.replace(/#(?!\[).*$/, '') : s;
}
// names declared in one file of a package/namespace, used bare from another file of the same package/namespace
function sameGroupRefs(fi, decls, hit, strip) {
  fi.lines.forEach((l, i) => {
    if (isCommentLine(l, fi.path) || /^\s*(import|package|namespace|use)\b/.test(l)) return;
    for (const m of strip(l).matchAll(/(?<![\w$\\.>:])([A-Za-z_]\w*)\b/g)) { const f = decls.get(m[1]); if (f && f !== fi.path) hit(f, m[1], i + 1); }
  });
}
// group -> Map(name -> file, or null when more than one file declares it)
function declare(groups, group, name, file) { let g = groups.get(group); if (!g) groups.set(group, (g = new Map())); g.set(name, g.has(name) && g.get(name) !== file ? null : file); }

// Java / Kotlin: `import a.b.C;`, `import static a.b.C.m;`, `import a.b.*;` resolved through each file's
// `package` + declared types; plus types of the same package used without an import.
function javaImports() {
  const jv = [...files.values()].filter((f) => /\.(java|kt)$/.test(f.path));
  if (!jv.length) return 0;
  const fqn = new Map(); const byPkg = new Map(); const pkgOfFile = new Map();
  const DECL = /^\s*(?:(?:public|protected|private|internal|abstract|final|sealed|non-sealed|static|strictfp|open|data|enum|annotation|inner|value)\s+)*(?:class|interface|enum|record|@interface|object)\s+([A-Z]\w*)/gm;
  for (const fi of jv) {
    const pkg = fi.text.match(/^\s*package\s+([\w.]+)/m)?.[1] || ''; pkgOfFile.set(fi.path, pkg);
    for (const m of fi.text.matchAll(DECL)) { const k = pkg ? `${pkg}.${m[1]}` : m[1]; if (!fqn.has(k)) fqn.set(k, fi.path); declare(byPkg, pkg, m[1], fi.path); }
  }
  let n = 0;
  for (const fi of jv) {
    const c = edgeCollector(fi); const strip = (l) => stripCode(l);
    const used = (name) => fi.lines.some((l, i) => !/^\s*(import|package)\b/.test(l) && !isCommentLine(l, fi.path) && new RegExp(`(?<![\\w.])${name}\\b`).test(strip(l)));
    fi.lines.forEach((l, i) => {
      const m = l.match(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/); if (!m) return;
      if (m[3] && !m[1]) { for (const [name, f] of byPkg.get(m[2]) || []) if (f && used(name)) c.hit(f, name, i + 1); return; }
      const segs = m[2].split('.');
      for (let k = segs.length; k > 0; k--) { const f = fqn.get(segs.slice(0, k).join('.')); if (f) { c.hit(f, segs[k - 1], i + 1); break; } }
    });
    sameGroupRefs(fi, byPkg.get(pkgOfFile.get(fi.path)) || new Map(), c.hit, strip);
    n += c.flush();
  }
  return n;
}

// PHP: top-level `use A\B\C [as D];` and group `use A\B\{C, D};` resolved through each file's `namespace` + declared
// classes/interfaces/traits/enums (case-insensitive, like PHP); plus classes of the same namespace used without `use`.
function phpImports() {
  const php = [...files.values()].filter((f) => f.path.endsWith('.php'));
  if (!php.length) return 0;
  const fqn = new Map(); const byNs = new Map(); const nsOfFile = new Map();
  for (const fi of php) {
    const ns = fi.text.match(/^\s*namespace\s+([\w\\]+)\s*[;{]/m)?.[1] || ''; nsOfFile.set(fi.path, ns);
    for (const m of fi.text.matchAll(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm)) {
      const k = (ns ? `${ns}\\${m[1]}` : m[1]).toLowerCase(); if (!fqn.has(k)) fqn.set(k, fi.path); declare(byNs, ns, m[1], fi.path);
    }
  }
  let n = 0;
  for (const fi of php) {
    const c = edgeCollector(fi); const strip = (l) => stripCode(l, { multiChar: true, hash: true });
    for (let i = 0; i < fi.lines.length; i++) {
      if (!/^use\s/.test(fi.lines[i])) continue; // column 0 only: indented `use` is a trait use or a closure
      let stmt = fi.lines[i]; let j = i;
      while (!stmt.includes(';') && j + 1 < fi.lines.length) stmt += ' ' + fi.lines[++j];
      const body = stmt.replace(/^use\s+/, '').replace(/;.*$/, '').trim();
      if (/^(function|const)\s/.test(body)) { i = j; continue; }
      const g = body.match(/^([\w\\]+)\\\{([^}]*)\}/);
      const names = g ? g[2].split(',').map((s) => `${g[1]}\\${s.trim()}`) : body.split(',');
      for (const raw of names) {
        const name = raw.trim().replace(/^\\/, '').split(/\s+as\s+/i)[0].trim(); if (!name) continue;
        const f = fqn.get(name.toLowerCase()); if (f) c.hit(f, name.split('\\').pop(), i + 1);
      }
      i = j;
    }
    sameGroupRefs(fi, byNs.get(nsOfFile.get(fi.path)) || new Map(), c.hit, strip);
    n += c.flush();
  }
  return n;
}

// Rust: `use` trees (`crate::`, `self::`, `super::`, workspace crate names, `{a, b::{c}}` groups) and inline
// `crate::a::b(...)` paths, resolved over each crate's module files (a.rs, a/mod.rs) under src/ and src/bin/.
function rustImports() {
  const rs = [...files.values()].filter((f) => f.path.endsWith('.rs'));
  if (!rs.length) return 0;
  // crates: nearest ancestor with Cargo.toml
  const crateOfDir = new Map(), crateNames = new Map(); // crate name -> lib ctx id
  const findCrate = (dir) => {
    if (crateOfDir.has(dir)) return crateOfDir.get(dir);
    const toml = readRepo(dir === '.' ? 'Cargo.toml' : `${dir}/Cargo.toml`);
    let out;
    if (/^\s*\[package\]/m.test(toml)) {
      out = dir;
      const names = {}; let section = '';
      for (const line of toml.split('\n')) { const h = line.match(/^\s*\[([^\]]+)\]\s*$/); if (h) { section = h[1].trim(); continue; } const nm = line.match(/^\s*name\s*=\s*"([^"]+)"/); if (nm && !names[section]) names[section] = nm[1]; }
      const lib = names.lib || names.package;
      if (lib) crateNames.set(lib.replace(/-/g, '_'), `${dir}::src`);
    } else out = dir === '.' ? null : findCrate(posix.dirname(dir));
    crateOfDir.set(dir, out); return out;
  };
  // module context: { ctx, path[] } for each file; ctx is the directory whose files form one module tree
  const modFile = new Map(); // `${ctx}|a::b` -> file
  const info = new Map(); // file -> { ctx, path }
  for (const fi of rs) {
    const crate = findCrate(posix.dirname(fi.path)); if (crate == null) continue;
    const src = crate === '.' ? 'src' : `${crate}/src`;
    if (!fi.path.startsWith(src + '/')) continue;
    let rel = fi.path.slice(src.length + 1), ctx = `${crate}::src`;
    const bin = rel.match(/^bin\/([^/]+?)(?:\.rs$|\/(.*)$)/);
    if (bin) { ctx = `${crate}::bin/${bin[1]}`; rel = bin[2] ?? 'main.rs'; }
    let path = rel.replace(/\.rs$/, '').split('/');
    if (path[path.length - 1] === 'mod') path.pop();
    if (path.length === 1 && (path[0] === 'lib' || path[0] === 'main')) path = [];
    info.set(fi.path, { ctx, path });
    const key = `${ctx}|${path.join('::')}`;
    if (!modFile.has(key) || /(^|\/)lib\.rs$/.test(fi.path)) modFile.set(key, fi.path); // src/lib.rs wins the root over src/main.rs
  }
  const expand = (tree) => { // "a::{b, c::{d}}" -> ["a::b", "a::c::d"]
    const t = tree.replace(/\s*([{},]|::)\s*/g, '$1').trim(); const open = t.indexOf('{');
    if (open < 0) return [t];
    const prefix = t.slice(0, open); const inner = t.slice(open + 1, t.lastIndexOf('}'));
    const parts = []; let depth = 0, cur = '';
    for (const ch of inner) { if (ch === '{') depth++; if (ch === '}') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
    parts.push(cur);
    return parts.filter(Boolean).flatMap((p) => expand(p).map((x) => (x === 'self' ? prefix.replace(/::$/, '') : prefix + x)));
  };
  const resolve = (segs, me) => { // -> { file, sym } or null
    let ctx = me.ctx, base;
    if (segs[0] === 'crate') { base = []; segs = segs.slice(1); }
    else if (segs[0] === 'self') { base = me.path; segs = segs.slice(1); }
    else if (segs[0] === 'super') { base = me.path; while (segs[0] === 'super') { base = base.slice(0, -1); segs = segs.slice(1); } }
    else if (crateNames.has(segs[0])) { ctx = crateNames.get(segs[0]); base = []; segs = segs.slice(1); }
    else {
      for (const b of [me.path, []]) if (modFile.has(`${ctx}|${[...b, segs[0]].join('::')}`)) { base = b; break; }
      if (!base) return null;
    }
    let k = segs.length;
    while (k >= 0 && !modFile.has(`${ctx}|${[...base, ...segs.slice(0, k)].join('::')}`)) k--;
    if (k < 0) return null;
    const sym = segs[k] && segs[k] !== '*' && !/^(self|super|crate)$/.test(segs[k]) ? segs[k] : null;
    return { file: modFile.get(`${ctx}|${[...base, ...segs.slice(0, k)].join('::')}`), sym };
  };
  const crateRe = () => new RegExp(`(?<![\\w:])((?:crate|super|self${[...crateNames.keys()].map((c) => `|${c}`).join('')})(?:::[A-Za-z_]\\w*)+)`, 'g');
  let n = 0;
  for (const fi of rs) {
    const me = info.get(fi.path); if (!me) continue;
    const c = edgeCollector(fi); const PATH = crateRe();
    for (let i = 0; i < fi.lines.length; i++) {
      const l = fi.lines[i];
      if (isCommentLine(l, fi.path)) continue;
      if (/^\s*(pub(\([^)]*\))?\s+)?use\s/.test(l)) {
        let stmt = l; let j = i;
        while (!stmt.includes(';') && j + 1 < fi.lines.length) stmt += ' ' + fi.lines[++j];
        const tree = stmt.replace(/^\s*(pub(\([^)]*\))?\s+)?use\s+/, '').replace(/;.*$/, '').replace(/^::/, '');
        for (const p of expand(tree)) { const r = resolve(p.replace(/\s+as\s+\w+$/, '').split('::').filter(Boolean), me); if (r) c.hit(r.file, r.sym, i + 1); }
        i = j; continue;
      }
      for (const m of stripCode(l).matchAll(PATH)) { const r = resolve(m[1].split('::'), me); if (r) c.hit(r.file, r.sym, i + 1); }
    }
    n += c.flush();
  }
  return n;
}

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
