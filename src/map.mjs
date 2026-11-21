#!/usr/bin/env node
// Loupe, one command: scan -> relations -> render a repo, then open the map.
// Usage: loupe map [repoDir] [--out file.html] [--no-open] [--backend claude|anthropic|openai] [--verbose]
// Output: <repoDir>/architecture.html (or --out, relative to cwd). Intermediate files live in <repoDir>/.loupe/:
// tree.json + tree.files.json, and the answer cache in .loupe/cache/ (LOUPE_CACHE overrides). .loupe/ ignores itself.
import { existsSync, mkdirSync, writeFileSync, statSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBackend, BackendError, findOnPath, git } from './llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (msg, code = 1) => { console.error(`loupe: ${msg}`); process.exit(code); };

// ---------- args ----------
const opts = { repo: '', out: '', open: true, backend: '', verbose: !!process.env.LOUPE_VERBOSE };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = (name) => { const eq = a.indexOf('='); const v = eq > 0 ? a.slice(eq + 1) : argv[++i]; if (!v || (eq < 0 && v.startsWith('-'))) fail(`${name} needs a value`, 2); return v; };
  if (a === '--help' || a === '-h') { spawnSync(process.execPath, [join(here, '..', 'bin', 'loupe.mjs'), '--help'], { stdio: 'inherit' }); process.exit(0); }
  else if (a === '--no-open') opts.open = false;
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--out' || a.startsWith('--out=') || a === '-o') opts.out = val('--out');
  else if (a === '--backend' || a.startsWith('--backend=')) opts.backend = val('--backend');
  else if (a.startsWith('-')) fail(`unknown option ${a} (see loupe --help)`, 2);
  else if (!opts.repo) opts.repo = a;
  else fail(`unexpected argument ${a} (see loupe --help)`, 2);
}
const REPO = resolve(opts.repo || '.');
const OUT = resolve(opts.out || join(REPO, 'architecture.html'));
const WORK = join(REPO, '.loupe');
const TREE = join(WORK, 'tree.json');
const show = (p) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') && !isAbsolute(r) ? r : p; };

// ---------- preflight: a git repo with a commit, and a model ----------
if (!existsSync(REPO) || !statSync(REPO).isDirectory()) fail(`${REPO} is not a directory`, 2);
try { git(REPO, ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }); }
catch (e) { fail(e.code === 'ENOENT' ? 'git is not installed: Loupe lists your source files with `git ls-files`.' : `${REPO} is not inside a git repository.\nLoupe maps the files git tracks: run it inside a git checkout (or \`git init && git add -A && git commit -m init\` first).`, 2); }
try { git(REPO, ['rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }); }
catch { fail(`${REPO} has no commits yet: commit your files first (Loupe records the commit it mapped).`, 2); }

if (opts.backend) process.env.LOUPE_BACKEND = opts.backend;
let backend;
try { backend = resolveBackend(); } catch (e) { if (e instanceof BackendError) { console.error(e.message); process.exit(2); } throw e; }

console.log(`loupe · mapping ${REPO}`);
console.log(`backend: ${backend.name} (${backend.label}${backend.model ? `, ${backend.model}` : ''})`);

// The repo is untrusted: it may commit `.loupe`, `.loupe/cache`, `.loupe/tree.json` or `architecture.html` as symlinks
// (or `.loupe` as a file) to make us write elsewhere. Our directories must be real directories inside the repo and the
// files we write must not be symlinks; otherwise stop rather than write through them.
const REAL_REPO = realpathSync(REPO);
const inRepo = (p) => { const r = relative(REPO, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const lst = (p) => { try { return lstatSync(p); } catch { return null; } };
const refuse = (p, what) => fail(`refusing to use ${show(p)}: it is ${what}. Remove it (it may come from the repo) and run loupe again.`, 2);
function ownDir(p) {
  const st = lst(p);
  if (st && st.isSymbolicLink()) refuse(p, 'a symlink');
  if (st && !st.isDirectory()) refuse(p, 'not a directory');
  if (!st) mkdirSync(p);
  const r = relative(REAL_REPO, realpathSync(p));
  if (r.startsWith('..') || isAbsolute(r)) refuse(p, 'outside the repo');
}
const ownFile = (p) => { const st = lst(p); if (st && !st.isFile()) refuse(p, st.isSymbolicLink() ? 'a symlink' : 'not a regular file'); };
const CACHE = process.env.LOUPE_CACHE ? resolve(process.env.LOUPE_CACHE) : join(WORK, 'cache');
ownDir(WORK);
if (!process.env.LOUPE_CACHE) ownDir(CACHE);
for (const f of [join(WORK, '.gitignore'), TREE, join(WORK, 'tree.files.json')]) ownFile(f);
if (inRepo(OUT)) ownFile(OUT); // an --out outside the repo is the user's own choice
writeFileSync(join(WORK, '.gitignore'), '# written by loupe: keep the map cache out of git\n*\n');
const env = { ...process.env, LOUPE_BACKEND: backend.name, LOUPE_CACHE: CACHE, ...(opts.verbose ? { LOUPE_VERBOSE: '1' } : { LOUPE_QUIET: '1' }) };
const step = (n, label, script, args, stdout = 'inherit') => {
  console.log(`[${n}/3] ${label} …`);
  const r = spawnSync(process.execPath, [join(here, script), ...args], { stdio: ['ignore', stdout, 'inherit'], env });
  if (r.status !== 0) fail(`${label.split(' ')[0]} failed${r.status != null ? ` (exit ${r.status})` : ''}; rerun with --verbose for details`, r.status || 1);
};

// ---------- run ----------
step(1, 'scanning structure + describing code', 'generate.mjs', [REPO, TREE]);
step(2, 'finding relationships + flows', 'relations.mjs', [REPO, TREE]);
mkdirSync(dirname(OUT), { recursive: true });
step(3, 'rendering', 'render.mjs', [TREE, OUT], 'ignore');

let nodes = '?';
try { nodes = JSON.parse(readFileSync(TREE, 'utf8')).meta?.nodeCount ?? '?'; } catch {}
const kib = (statSync(OUT).size / 1024).toFixed(1);
const truthy = (v) => !!v && !/^(0|false|no)$/i.test(v);
// no browser over SSH or in a container without a display (xdg-open would fall back to a terminal browser)
const hasDisplay = process.platform === 'darwin' || process.platform === 'win32' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const willOpen = opts.open && !truthy(process.env.CI) && !truthy(process.env.LOUPE_NO_OPEN) && !!process.stdout.isTTY && hasDisplay;
console.log(`✓ wrote ${show(OUT)} (${kib} KiB, ${nodes} nodes)${willOpen ? ' — opening in your browser' : ''}`);
if (willOpen) openInBrowser(OUT);

// Default browser, no shell, opener by absolute path (the cwd is often the untrusted repo, and Windows searches the cwd
// first); failures are ignored (the path is printed above).
function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? '/usr/bin/open'
    : process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    : findOnPath('xdg-open');
  if (!cmd || !existsSync(cmd)) return;
  try { const p = spawn(cmd, [file], { detached: true, stdio: 'ignore', cwd: dirname(file) }); p.on('error', () => {}); p.unref(); } catch {}
}
