#!/usr/bin/env node
// Loupe: repo -> zoom tree.
// Usage: loupe scan <repoDir> [out.json]   (or node src/generate.mjs <repoDir> [out.json])
// Stages: 1) scan workspace packages + source files + imports (real structure)
//         2) LLM (Claude Code headless) groups each package's files into modules and writes package/module summaries
//         3) LLM writes short/long descriptions for key files, per module
//         4) LLM writes the system-level summary; assemble tree with sibling edges at every level
// LLM answers are cached next to the output in .loupe-cache/ (LOUPE_CACHE), keyed by prompt hash, so reruns are cheap.
// The LLM is your local Claude Code CLI, the Anthropic API or the OpenAI API: see src/llm.mjs (LOUPE_BACKEND).
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, posix } from 'node:path';
import { createLlm, BackendError, git, hasTrackedFiles } from './llm.mjs';
import { SafeFsError, within, lst, checkSafePath, safeDir, safeWriteFile } from './fs-safe.mjs';
import { SRC_EXT, JS_TS_EXT, SECRET_FILE, EXCLUDE, isMinified, gitSourceFilters, extractExports } from './source.mjs';

if (!process.argv[2]) { console.error('usage: loupe scan <repoDir> [out.json]'); process.exit(2); }
const REPO = resolve(process.argv[2]);
const OUT = resolve(process.argv[3] || 'loupe-tree.json');
const FILES_OUT = OUT.replace(/\.json$/, '') + '.files.json';
const CACHE = resolve(process.env.LOUPE_CACHE || join(dirname(OUT), '.loupe-cache'));
const KEY_FILES_PER_MODULE = Math.max(1, Number(process.env.LOUPE_KEY_FILES) || 12);
// LOUPE_IGNORE: a regex of workspace dirs or files to leave out (e.g. "^examples/")
const IGNORE = process.env.LOUPE_IGNORE ? new RegExp(process.env.LOUPE_IGNORE) : null;

const log = (...a) => console.error('[gen]', ...a);
// Untrusted repo: only read regular files that resolve (after symlinks) inside REPO, up to MAX_BYTES.
const REAL_REPO = realpathSync(REPO);
const MAX_BYTES = 1024 * 1024;
const insideRepo = (p) => { if (!within(REPO, resolve(REPO, p))) return false; try { return within(REAL_REPO, realpathSync(join(REPO, p))); } catch { return true; /* does not exist yet: nothing to read */ } };
const isRegularFile = (p) => { try { if (!insideRepo(p)) return false; const s = statSync(join(REPO, p)); return s.isFile() && s.size <= MAX_BYTES; } catch { return false; } };
const readRepo = (p) => (isRegularFile(p) ? readFileSync(join(REPO, p), 'utf8') : '');
const readJson = (p) => { const t = readRepo(p); if (!t) return null; try { return JSON.parse(t); } catch { log(`skipping ${p}: invalid JSON`); return null; } };

// Refuse symlink/non-regular output targets or an existing symlinked cache dir before any work.
try {
  checkSafePath(OUT, { withinDir: within(REPO, OUT) ? REPO : null });
  checkSafePath(FILES_OUT, { withinDir: within(REPO, FILES_OUT) ? REPO : null });
  if (lst(CACHE)) safeDir(CACHE, { withinDir: within(REPO, CACHE) ? REPO : null });
} catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }

// ---------- 1. structure ----------
const gitFiles = git(REPO, ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
const commit = git(REPO, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const rootPkg = readJson('package.json') || {};
// "@acme/shop-monorepo" -> "shop": scope and workspace-ish suffixes say nothing on a map
const ROOT_NAME = (typeof rootPkg.name === 'string' && rootPkg.name ? rootPkg.name : basename(REPO)).replace(/^@[^/]+\//, '').replace(/[-_ ](monorepo|workspace|workspaces|root)$/i, '') || basename(REPO);

function workspaceGlobs() {
  const pnpm = readRepo('pnpm-workspace.yaml');
  if (pnpm) {
    const globs = [];
    let inPk = false;
    for (const line of pnpm.split('\n')) {
      if (/^packages:/.test(line)) { inPk = true; continue; }
      if (inPk) { const m = line.match(/^\s*-\s*["']?([^"']+)["']?/); if (m) globs.push(m[1]); else if (/^\S/.test(line)) inPk = false; }
    }
    return globs;
  }
  const ws = rootPkg.workspaces; return Array.isArray(ws) ? ws : ws?.packages || [];
}
const packages = [];
for (const g of workspaceGlobs()) {
  const base = g.slice(0, -2);
  const dirs = g.endsWith('/*') ? (insideRepo(base) && existsSync(join(REPO, base)) && statSync(join(REPO, base)).isDirectory() ? readdirSync(join(REPO, base)).map((d) => posix.join(base, d)) : []) : [posix.normalize(g)];
  for (const d of dirs) {
    if (!insideRepo(d) || packages.some((p) => p.dir === d) || (IGNORE && IGNORE.test(d + '/'))) continue;
    const pj = readJson(posix.join(d, 'package.json'));
    if (pj) packages.push({ dir: d, name: typeof pj.name === 'string' && pj.name ? pj.name : d });
  }
}
// not a workspace: the repo root is the one package
if (!packages.length) packages.push({ dir: '.', name: ROOT_NAME });
log('packages:', packages.map((p) => p.name).join(', '));

const pkgOwner = new Map();
for (const pkg of packages) {
  const inPkg = pkg.dir === '.' ? (f) => !packages.some((q) => q.dir !== '.' && f.startsWith(q.dir + '/')) : (f) => f.startsWith(pkg.dir + '/');
  for (const f of gitFiles) if (!pkgOwner.has(f) && inPkg(f)) pkgOwner.set(f, pkg);
  pkg.files = [];
}
const candidates = [...pkgOwner.keys()].filter((f) => SRC_EXT.test(f) && !EXCLUDE.test(f) && !SECRET_FILE.test(f) && !(IGNORE && IGNORE.test(f)) && isRegularFile(f));
const filters = gitSourceFilters(REPO, candidates, git, gitFiles);
let skippedVendored = 0;
const files = new Map(); // path -> info
for (const f of candidates) {
  if (filters.isSkippedPath(f)) { skippedVendored++; continue; }
  const text = readRepo(f);
  if (!filters.isIncludedByAttr(f) && isMinified(text)) { skippedVendored++; continue; }
  const pkg = pkgOwner.get(f);
  pkg.files.push(f);
  const loc = text.split('\n').filter((l) => l.trim()).length;
  const exportsList = extractExports(f, text);
  const specs = [];
  if (JS_TS_EXT.test(f)) {
    for (const m of text.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s[^;'"]{0,2000}?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of text.matchAll(/(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  }
  files.set(f, { path: f, pkg: pkg.dir, loc, exports: exportsList, specs, text, imports: new Set() });
}
if (skippedVendored > 0) log(`skipped ${skippedVendored} vendored/generated ${skippedVendored === 1 ? 'file' : 'files'} (see .gitattributes to include)`);
const activePackages = packages.filter((p) => p.files.length > 0);
if (!files.size || !activePackages.length) {
  console.error(`loupe: no supported source files found in ${REPO}.\nLoupe maps git-tracked source files (JS/TS, Python, Go, Rust, Ruby, Java, Kotlin, Swift, PHP, C#, C/C++, Objective-C, Scala, Elixir, Vue, Svelte, SQL, Prisma), excluding tests, vendored, build and generated output.${IGNORE ? ' Check LOUPE_IGNORE if it filtered everything out.' : ''}`);
  process.exit(2);
}
try { safeDir(CACHE, { withinDir: within(REPO, CACHE) ? REPO : null }); }
catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }
const pkgByName = new Map(packages.map((p) => [p.name, p]));
function resolveSpec(from, spec) {
  if (spec.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const cands = [base, base.replace(/\.(m?)js$/, '.$1ts'), base.replace(/\.js$/, '.tsx'), base + '.ts', base + '.tsx', base + '.mjs', base + '.js', base + '.jsx', base + '/index.ts', base + '/index.tsx', base + '/index.js'];
    for (const c of cands) if (files.has(c)) return { file: c };
    return null;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const pkg = pkgByName.get(name);
  if (pkg) {
    const sub = spec.slice(name.length + 1);
    const at = (rest) => (pkg.dir === '.' ? rest : `${pkg.dir}/${rest}`);
    if (sub) for (const c of [`src/${sub}.ts`, `src/${sub}/index.ts`, `${sub}.ts`, `src/${sub}.tsx`, `${sub}.tsx`, `${sub}/index.ts`, `${sub}/index.tsx`].map(at)) if (files.has(c)) return { file: c, pkg: pkg.dir };
    for (const c of ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx', 'src/main.ts'].map(at)) if (files.has(c)) return { file: c, pkg: pkg.dir };
    return { pkg: pkg.dir };
  }
  return null;
}
const pkgEdges = new Map();
const inbound = new Map();
for (const info of files.values()) {
  for (const s of info.specs) {
    const r = resolveSpec(info.path, s);
    if (!r) continue;
    const targetPkg = r.file ? files.get(r.file).pkg : r.pkg;
    if (targetPkg !== info.pkg) { const k = `${info.pkg}\0${targetPkg}`; pkgEdges.set(k, (pkgEdges.get(k) || 0) + 1); }
    if (r.file && r.file !== info.path) { info.imports.add(r.file); inbound.set(r.file, (inbound.get(r.file) || 0) + 1); }
  }
}

// ---------- LLM helper ----------
const untrustedCache = !!process.env.LOUPE_UNTRUSTED_CACHE || hasTrackedFiles(REPO, CACHE);
if (!process.env.LOUPE_UNTRUSTED_CACHE && untrustedCache) {
  console.error(`loupe: warning: cache directory ${CACHE} has files tracked by git; ignoring cached answers.`);
}
const llm = createLlm({ cache: CACHE, log, onFail: 'throw', trustCache: !untrustedCache });
const repoKind = activePackages.length > 1 ? 'monorepo' : 'repository';
const readSnippet = (p, n) => readRepo(p).slice(0, n);
const fileLine = (f) => { const i = files.get(f); return `${f} (${i.loc} loc${i.exports.length ? '; exports: ' + i.exports.slice(0, 8).join(', ') : ''})`; };
const STYLE = `Descriptions are for an architecture map that gets more detailed as the reader zooms in. shortDescription: one plain sentence, max ~15 words, says what it does. longDescription: 2-4 sentences, max ~70 words, concrete: responsibilities, key collaborators, notable design choices. No marketing words, no "This module". Answer with ONLY a JSON object, no prose, no code fences.`;

// ---------- 2. modules per package ----------
async function planPackage(pkg) {
  const docs = ['README.md', 'readme.md', 'CONTEXT.md'].map((d) => readSnippet(pkg.dir === '.' ? d : `${pkg.dir}/${d}`, 2500)).filter(Boolean).join('\n---\n');
  const minMods = Math.min(3, pkg.files.length);
  const maxMods = Math.min(9, Math.max(minMods, pkg.files.length));
  const prompt = `You are mapping the architecture of the "${ROOT_NAME}" ${repoKind}, package "${pkg.name}" at ${pkg.dir}.
Package docs (may be empty):
<<<
${docs}
>>>
Source files (path, non-empty lines, exports):
${pkg.files.map(fileLine).join('\n')}

Task: group ALL of these files into between ${minMods} and ${maxMods} cohesive modules (the zoom level below the package). Prefer existing folders as modules (a big folder may be split by subfolder or theme); for flat folders cluster by responsibility (filename prefixes and exports are strong hints). Every file must be in exactly one module; use exact paths.
${STYLE}
Schema: {"package":{"label":"short human label","shortDescription":"...","longDescription":"..."},"modules":[{"key":"kebab-id","label":"Title Case 1-3 words","shortDescription":"...","longDescription":"...","files":["exact/path", ...]}]}`;
  return llm(`pkg-${pkg.dir}`, prompt);
}

// ---------- 3. key files per module ----------
function keyFileScore(f) { const i = files.get(f); return Math.sqrt(i.loc) + 3 * (inbound.get(f) || 0) + i.exports.length * 0.5; }
async function describeFiles(pkg, mod, keyFiles) {
  const blocks = keyFiles.map((f) => { const i = files.get(f); return `### ${f} (${i.loc} loc)\nexports: ${i.exports.slice(0, 15).join(', ') || '(none)'}\n${i.text.slice(0, 1800)}`; }).join('\n\n');
  const prompt = `You are mapping the architecture of the "${ROOT_NAME}" ${repoKind}. Package "${pkg.name}", module "${mod.label}" (${mod.shortDescription}).
Key files with the start of their source:
${blocks}

Task: describe each file for the deepest zoom level of the map. Also pick up to 6 of its most important functions/classes/exports (use real names from the source, add "()" for functions).
${STYLE}
Schema: {"files":{"exact/path":{"label":"filename without extension or a 1-3 word name","shortDescription":"...","longDescription":"...","functions":["name()", ...]}}}`;
  return llm(`files-${pkg.dir}-${mod.key}`, prompt);
}

// ---------- assemble ----------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function edgesBetween(children, ownerOf) {
  // ownerOf(file) -> child id or undefined; aggregate file imports into child->child edges
  const m = new Map();
  for (const info of files.values()) {
    const a = ownerOf(info.path); if (!a) continue;
    for (const t of info.imports) { const b = ownerOf(t); if (b && b !== a) { const k = `${a}\0${b}`; m.set(k, (m.get(k) || 0) + 1); } }
  }
  return [...m].map(([k, w]) => { const [from, to] = k.split('\0'); return { from, to, weight: w }; }).sort((x, y) => y.weight - x.weight);
}

async function main() {
  log(`files: ${files.size}, package edges: ${pkgEdges.size}`);
  const plans = await Promise.all(activePackages.map(async (pkg) => [pkg, await planPackage(pkg)]));
  const pkgNodes = [];
  const fileJobs = [];
  for (const [pkg, plan] of plans) {
    const assigned = new Set();
    const usedKeys = new Set();
    const uniqKey = (k) => { let key = k || 'module', i = 2; while (usedKeys.has(key)) key = `${k || 'module'}-${i++}`; usedKeys.add(key); return key; };
    const mods = (Array.isArray(plan.modules) ? plan.modules : []).filter((m) => m && typeof m === 'object')
      .map((m) => ({ ...m, label: m.label || m.key || 'Module', files: (Array.isArray(m.files) ? m.files : []).filter((f) => pkg.files.includes(f) && !assigned.has(f) && assigned.add(f)) }))
      .filter((m) => m.files.length).map((m) => ({ ...m, key: uniqKey(slug(m.key || m.label)) }));
    const leftover = pkg.files.filter((f) => !assigned.has(f));
    if (leftover.length) mods.push({ key: uniqKey('other'), label: 'Other', shortDescription: 'Supporting files not grouped elsewhere.', longDescription: `Remaining files: ${leftover.map((f) => posix.basename(f)).join(', ')}.`, files: leftover });
    for (const mod of mods) {
      mod.files.sort((a, b) => keyFileScore(b) - keyFileScore(a));
      mod.keyFiles = mod.files.slice(0, KEY_FILES_PER_MODULE);
      mod.rest = mod.files.slice(KEY_FILES_PER_MODULE);
      fileJobs.push(describeFiles(pkg, mod, mod.keyFiles).then((r) => (mod.fileDesc = r.files && typeof r.files === 'object' ? r.files : {})));
    }
    pkg.mods = mods; pkg.plan = plan;
  }
  await Promise.all(fileJobs);

  for (const pkg of activePackages) {
    const pkgId = `pkg:${pkg.dir}`;
    const modNodes = pkg.mods.map((mod) => {
      const modId = `mod:${pkg.dir}:${mod.key}`;
      const fileNodes = mod.keyFiles.map((f) => {
        const d = mod.fileDesc[f] && typeof mod.fileDesc[f] === 'object' ? mod.fileDesc[f] : {}; const i = files.get(f);
        return { id: `file:${f}`, label: d.label || posix.basename(f).replace(/\.\w+$/, ''), kind: 'file', path: f, weight: i.loc,
          shortDescription: d.shortDescription || '', longDescription: d.longDescription || '', functions: (Array.isArray(d.functions) && d.functions.length ? d.functions : i.exports).slice(0, 8), children: [], edges: [] };
      });
      if (mod.rest.length) {
        const loc = mod.rest.reduce((a, f) => a + files.get(f).loc, 0);
        fileNodes.push({ id: `more:${pkg.dir}:${mod.key}`, label: `+${mod.rest.length} more ${mod.rest.length === 1 ? 'file' : 'files'}`, kind: 'file', path: posix.dirname(mod.rest[0]), weight: Math.max(1, Math.round(loc / 5)),
          shortDescription: `${mod.rest.length} smaller ${mod.rest.length === 1 ? 'file' : 'files'} in this module.`, longDescription: mod.rest.map((f) => posix.basename(f)).join(', '), functions: [], children: [], edges: [] });
      }
      const keySet = new Set(mod.keyFiles);
      return { id: modId, label: mod.label, kind: 'module', path: commonDir(mod.files), weight: mod.files.reduce((a, f) => a + files.get(f).loc, 0),
        shortDescription: mod.shortDescription, longDescription: mod.longDescription, children: fileNodes,
        edges: edgesBetween(fileNodes, (f) => (keySet.has(f) ? `file:${f}` : mod.rest.includes(f) ? `more:${pkg.dir}:${mod.key}` : undefined)) };
    });
    const ownerMod = new Map(); for (const mod of pkg.mods) for (const f of mod.files) ownerMod.set(f, `mod:${pkg.dir}:${mod.key}`);
    pkgNodes.push({ id: pkgId, label: pkg.plan.package?.label || pkg.name, kind: 'package', path: pkg.dir, packageName: pkg.name, weight: modNodes.reduce((a, m) => a + m.weight, 0),
      shortDescription: pkg.plan.package?.shortDescription || '', longDescription: pkg.plan.package?.longDescription || '', children: modNodes,
      edges: edgesBetween(modNodes, (f) => ownerMod.get(f)) });
  }

  const sysPrompt = `You are mapping the architecture of the "${ROOT_NAME}" ${repoKind} (top zoom level).
Root README (truncated):
<<<
${readSnippet('README.md', 3000) || readSnippet('readme.md', 3000)}
>>>
Context map:
<<<
${readSnippet('CONTEXT-MAP.md', 3000) || readSnippet('ARCHITECTURE.md', 3000)}
>>>
Packages: ${pkgNodes.map((p) => `${p.packageName} (${p.path}): ${p.shortDescription}`).join('; ')}
${STYLE}
Schema: {"label":"${ROOT_NAME[0].toUpperCase() + ROOT_NAME.slice(1)}","shortDescription":"...","longDescription":"..."}`;
  const sys = await llm('system', sysPrompt);
  const root = { id: 'system', label: sys.label || ROOT_NAME, kind: 'system', path: '.', weight: pkgNodes.reduce((a, p) => a + p.weight, 0),
    shortDescription: sys.shortDescription || '', longDescription: sys.longDescription || '', children: pkgNodes,
    edges: [...pkgEdges].map(([k, w]) => { const [a, b] = k.split('\0'); return { from: `pkg:${a}`, to: `pkg:${b}`, weight: w }; }).sort((x, y) => y.weight - x.weight) };

  let nodeCount = 0, edgeCount = 0; const perLevel = [];
  (function walk(n, d) { nodeCount++; edgeCount += n.edges.length; perLevel[d] = (perLevel[d] || 0) + 1; n.children.forEach((c) => walk(c, d + 1)); })(root, 0);
  const meta = { source: repoSource(), commit, generatedAt: new Date().toISOString(), backend: llm.backend()?.name || '', model: llm.backend()?.model || process.env.LOUPE_MODEL || '', levels: perLevel.length, levelNames: ['system', 'packages', 'modules', 'files'], nodesPerLevel: perLevel, nodeCount, edgeCount, sourceFiles: files.size };
  safeWriteFile(OUT, JSON.stringify({ meta, root }, null, 2), { withinDir: within(REPO, OUT) ? REPO : null });
  // ids must be unique across the whole tree; the viewer relies on it
  // sidecar for scripts/relations.mjs: every source file -> the deepest tree node that holds it
  const fileMap = {};
  for (const pkg of activePackages) for (const mod of pkg.mods) {
    for (const f of mod.keyFiles) fileMap[f] = `file:${f}`;
    for (const f of mod.rest) fileMap[f] = `more:${pkg.dir}:${mod.key}`;
  }
  safeWriteFile(FILES_OUT, JSON.stringify(fileMap, null, 1), { withinDir: within(REPO, FILES_OUT) ? REPO : null });
  log(llm.summary());
  log('wrote', OUT, JSON.stringify(meta));
}
// "github.com/owner/repo" from the origin remote, without credentials; falls back to the folder name
function repoSource() {
  try {
    const url = git(REPO, ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.replace(/[?#].*$/, '').match(/^(?:https?:\/\/(?:[^/]+@)?|ssh:\/\/(?:[^/]+@)?|git@)([^/:@]+)(?::\d+)?[/:](.+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return basename(REPO);
}
function commonDir(paths) {
  let parts = posix.dirname(paths[0]).split('/');
  for (const p of paths) { const q = posix.dirname(p).split('/'); let i = 0; while (i < parts.length && parts[i] === q[i]) i++; parts = parts.slice(0, i); }
  return parts.join('/') || '.';
}
main().catch((e) => { if (e instanceof BackendError || e instanceof SafeFsError) { console.error(e instanceof SafeFsError ? `loupe: ${e.message}` : e.message); process.exit(2); } console.error(e); process.exit(1); });
