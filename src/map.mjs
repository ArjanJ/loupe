#!/usr/bin/env node
// Loupe, one command: scan -> relations -> render a repo, then open the map.
// Usage: loupe map [repoDir] [--out file.html] [--no-open] [--backend claude|anthropic|openai] [--model name] [--verbose]
// In a terminal with no --backend/--model (or LOUPE_BACKEND/LOUPE_MODEL) it first asks which model to use (src/picker.mjs)
// and remembers the answer in <repoDir>/.loupe/config.json as the next run's preselection.
// Output: <repoDir>/loupe.html (or --out, relative to cwd). Intermediate files live in <repoDir>/.loupe/:
// tree.json + tree.files.json, and the answer cache in .loupe/cache/ (LOUPE_CACHE overrides). .loupe/ ignores itself.
import { existsSync, statSync, readFileSync, openSync, fstatSync, closeSync, constants as fsc } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBackend, BackendError, findOnPath, git, validateModel, validateEffort, hasTrackedFiles } from './llm.mjs';
import { detectOptions, initialIndex, pick } from './picker.mjs';
import { SafeFsError, within, lst, assertSafeFile, checkSafePath, safeDir, safeWriteFile } from './fs-safe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (msg, code = 1) => { console.error(`loupe: ${msg}`); process.exit(code); };

// ---------- args ----------
const opts = { repo: '', out: '', open: true, backend: '', model: '', verbose: !!process.env.LOUPE_VERBOSE };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = (name) => { const eq = a.indexOf('='); const v = eq > 0 ? a.slice(eq + 1) : argv[++i]; if (!v || (eq < 0 && v.startsWith('-'))) fail(`${name} needs a value`, 2); return v; };
  if (a === '--help' || a === '-h') { spawnSync(process.execPath, [join(here, '..', 'bin', 'loupe.mjs'), '--help'], { stdio: 'inherit' }); process.exit(0); }
  else if (a === '--no-open') opts.open = false;
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--out' || a.startsWith('--out=') || a === '-o') opts.out = val('--out');
  else if (a === '--backend' || a.startsWith('--backend=')) opts.backend = val('--backend');
  else if (a === '--model' || a.startsWith('--model=')) opts.model = val('--model');
  else if (a.startsWith('-')) fail(`unknown option ${a} (see loupe --help)`, 2);
  else if (!opts.repo) opts.repo = a;
  else fail(`unexpected argument ${a} (see loupe --help)`, 2);
}
// the flag wins over LOUPE_MODEL; either way a bad name or effort stops here, before any work and long before any spawn
if (opts.model) process.env.LOUPE_MODEL = opts.model;
if (process.env.LOUPE_MODEL) try { validateModel(process.env.LOUPE_MODEL); } catch (e) { fail(e.message.replace(/^loupe: /, ''), 2); }
if (process.env.LOUPE_EFFORT) try { validateEffort(process.env.LOUPE_EFFORT); } catch (e) { fail(e.message.replace(/^loupe: /, ''), 2); }
const REPO = resolve(opts.repo || '.');
const OUT = resolve(opts.out || join(REPO, 'loupe.html'));
const WORK = join(REPO, '.loupe');
const TREE = join(WORK, 'tree.json');
const show = (p) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') && !isAbsolute(r) ? r : p; };

// ---------- preflight: a git repo with a commit, and a model ----------
if (!existsSync(REPO) || !statSync(REPO).isDirectory()) fail(`${REPO} is not a directory`, 2);
try { git(REPO, ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }); }
catch (e) { fail(e.code === 'ENOENT' ? 'git is not installed: Loupe lists your source files with `git ls-files`.' : `${REPO} is not inside a git repository.\nLoupe maps the files git tracks: run it inside a git checkout (or \`git init && git add -A && git commit -m init\` first).`, 2); }
try { git(REPO, ['rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }); }
catch { fail(`${REPO} has no commits yet: commit your files first (Loupe records the commit it mapped).`, 2); }

// The repo is untrusted: it may commit `.loupe`, `.loupe/cache`, `.loupe/tree.json`, `loupe.html` or a parent
// dir of `--out` as symlinks to make us write elsewhere, or track `.loupe/` to pre-seed cached answers.
const inRepo = (p) => within(REPO, p);
const truthy = (v) => !!v && !/^(0|false|no)$/i.test(v);
const loupeTracked = hasTrackedFiles(REPO, WORK);
if (loupeTracked) console.error('loupe: warning: .loupe/ has files tracked by git; ignoring its cache and saved config.');

// ---------- which model: ask in a terminal, unless the backend or model was given ----------
// Never prompts in CI, when stdin or stdout isn't a terminal, or with --backend/--model/LOUPE_BACKEND/LOUPE_MODEL.
// LOUPE_FORCE_TTY=1 (undocumented, for tests) asks anyway, reading keys from a piped stdin.
const CONFIG = join(WORK, 'config.json');
const interactive = !opts.backend && !process.env.LOUPE_BACKEND && !process.env.LOUPE_MODEL
  && (truthy(process.env.LOUPE_FORCE_TTY) || (!!process.stdin.isTTY && !!process.stdout.isTTY && !truthy(process.env.CI) && process.env.TERM !== 'dumb'));
let chosen = null, announced = false;
const announce = () => { if (!announced) console.log(`loupe · mapping ${REPO}`); announced = true; };
if (interactive) {
  const options = detectOptions();
  if (options.length > 1) {
    // the remembered choice comes from the repo dir: read it only when .loupe/ is not tracked by git, as a plain
    // small file in a real .loupe/, and only ever compare it against the offered options (initialIndex)
    let remembered = null;
    // (O_NOFOLLOW + O_NONBLOCK + fstat: no symlink, FIFO or device even if it is swapped in after the lstat)
    if (!loupeTracked) try {
      if (lst(WORK)?.isDirectory() && lst(CONFIG)?.isFile()) {
        const fd = openSync(CONFIG, fsc.O_RDONLY | (fsc.O_NOFOLLOW || 0) | (fsc.O_NONBLOCK || 0));
        try { const st = fstatSync(fd); if (st.isFile() && st.size < 4096) remembered = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
      }
    } catch {}
    announce();
    try { chosen = await pick(options, { initial: initialIndex(options, remembered) }); }
    catch (e) { if (e.code === 'CANCELLED') process.exit(130); throw e; }
    process.stdin.destroy(); // done with the keyboard: a paused stdin (a pipe especially) would keep the process alive
    process.env.LOUPE_BACKEND = chosen.backend;
    if (chosen.model) process.env.LOUPE_MODEL = chosen.model; // "Default" claude: no --model at all
  }
}

if (opts.backend) process.env.LOUPE_BACKEND = opts.backend;
let backend;
try { backend = resolveBackend(); } catch (e) { if (e instanceof BackendError) { console.error(e.message); process.exit(2); } throw e; }

announce();
console.log(`backend: ${backend.name} (${backend.label}, ${backend.model ? `model ${backend.model}` : 'default model'})`);

const CACHE = process.env.LOUPE_CACHE ? resolve(process.env.LOUPE_CACHE) : join(WORK, 'cache');
const untrustedCache = loupeTracked && (!process.env.LOUPE_CACHE || within(WORK, CACHE));
try {
  safeDir(WORK, { withinDir: REPO });
  safeDir(CACHE, { withinDir: inRepo(CACHE) ? REPO : null });
  for (const f of [join(WORK, '.gitignore'), TREE, join(WORK, 'tree.files.json'), ...(chosen ? [CONFIG] : [])]) checkSafePath(f, { withinDir: REPO });
  if (inRepo(OUT)) checkSafePath(OUT, { withinDir: REPO }); else assertSafeFile(OUT);
  safeWriteFile(join(WORK, '.gitignore'), '# written by loupe: keep the map cache out of git\n*\n', { withinDir: REPO });
  if (chosen) safeWriteFile(CONFIG, JSON.stringify({ backend: chosen.backend, model: chosen.model }) + '\n', { withinDir: REPO }); // the next picker's preselection
} catch (e) { if (e instanceof SafeFsError) fail(e.message, 2); throw e; }
const env = { ...process.env, LOUPE_BACKEND: backend.name, LOUPE_CACHE: CACHE, ...(untrustedCache ? { LOUPE_UNTRUSTED_CACHE: '1' } : {}), ...(opts.verbose ? { LOUPE_VERBOSE: '1' } : { LOUPE_QUIET: '1' }) };
const step = (n, label, script, args, stdout = 'inherit') => {
  console.log(`[${n}/3] ${label} …`);
  const r = spawnSync(process.execPath, [join(here, script), ...args], { stdio: ['ignore', stdout, 'inherit'], env });
  if (r.status === 2) process.exit(2); // step already printed a friendly user-facing error
  if (r.status !== 0) fail(`${label.split(' ')[0]} failed${r.status != null ? ` (exit ${r.status})` : ''}; rerun with --verbose for details`, r.status || 1);
};

// ---------- run ----------
step(1, 'scanning structure + describing code', 'generate.mjs', [REPO, TREE]);
step(2, 'finding relationships + flows', 'relations.mjs', [REPO, TREE]);
try { safeDir(dirname(OUT), { withinDir: inRepo(OUT) ? REPO : null }); } catch (e) { if (e instanceof SafeFsError) fail(e.message, 2); throw e; }
step(3, 'rendering', 'render.mjs', [TREE, OUT], 'ignore');

let nodes = '?';
try { nodes = JSON.parse(readFileSync(TREE, 'utf8')).meta?.nodeCount ?? '?'; } catch {}
const kib = (statSync(OUT).size / 1024).toFixed(1);
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
