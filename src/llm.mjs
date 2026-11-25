// Loupe: the model backends shared by `scan` (generate.mjs) and `relations` (relations.mjs).
//   claude     your local Claude Code CLI, headless, no tools, prompt on stdin (LOUPE_CLAUDE_BIN, default `claude`)
//   anthropic  the Anthropic Messages API (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
//   openai     the OpenAI Chat Completions API (OPENAI_API_KEY, OPENAI_BASE_URL)
// Not forced (--backend / LOUPE_BACKEND): the first of claude on PATH, ANTHROPIC_API_KEY, OPENAI_API_KEY.
// The model is --model / LOUPE_MODEL (validated by validateModel), else the backend's default (DEFAULT_MODEL).
// Answers are cached as JSON in a directory, keyed by tag + backend + model + prompt hash.
// API keys never appear in logs or errors: HTTP errors carry the status and a truncated, redacted body.
import { readFileSync, writeFileSync, lstatSync, statSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, delimiter, isAbsolute, resolve, relative, extname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { within } from './fs-safe.mjs';

export const BACKENDS = {
  claude: 'Claude Code CLI',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
};
export const DEFAULT_MODEL = { claude: '', anthropic: 'claude-opus-5-5', openai: 'gpt-4.1' }; // claude: the CLI's default
const TIMEOUT_MS = 5 * 60 * 1000;

export const NO_BACKEND = `Loupe needs a model to describe your code. Pick one:

  1. Claude Code (uses your Claude subscription or Console login):
       npm install -g @anthropic-ai/claude-code && claude      # install, then sign in once
  2. Anthropic API:
       export ANTHROPIC_API_KEY=sk-ant-...
  3. OpenAI API:
       export OPENAI_API_KEY=sk-...

Then run loupe again. Force one with --backend claude|anthropic|openai.`;

export class BackendError extends Error {}

// `cmd` on PATH (plus PATHEXT on Windows), or an explicit path; returns the absolute path or null. No shell.
// Relative PATH entries (and so the current directory) are never searched: a cloned repo can't plant a `git` or `claude`.
export function findOnPath(cmd) {
  const win = process.platform === 'win32';
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  // Windows only runs files with a PATHEXT extension; an extensionless `claude` there is npm's sh shim
  const exts = win ? (pathext.some((e) => extname(cmd).toLowerCase() === e.toLowerCase()) ? [''] : pathext) : [''];
  const ok = (p) => { try { const st = statSync(p); if (!st.isFile()) return false; if (win) return true; return (st.mode & 0o111) !== 0; } catch { return false; } };
  if (cmd.includes('/') || (win && cmd.includes('\\'))) { for (const e of exts) if (ok(cmd + e)) return resolve(cmd + e); return null; }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const e of exts) { const p = join(dir, cmd + e); if (ok(p)) return p; }
  }
  return null;
}

// git by absolute path (never a repo-planted git: Windows searches the cwd first, and an empty PATH entry is the cwd
// on POSIX), with fsmonitor off so a hostile .git/config in an untrusted checkout can't run a command.
export function git(cwd, args, opts = {}) {
  const bin = findOnPath('git');
  if (!bin) { const e = new Error('git is not installed'); e.code = 'ENOENT'; throw e; }
  return execFileSync(bin, ['-c', 'core.fsmonitor=false', ...args], { cwd, ...opts });
}

// True if `dirPath` lies inside `repo` and git tracks at least one file under it.
export function hasTrackedFiles(repo, dirPath) {
  const base = resolve(repo), target = resolve(dirPath);
  if (!within(base, target)) return false;
  const rel = relative(base, target).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  try {
    return git(base, ['ls-files', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { return false; }
}

// Windows .cmd/.bat shims can only run through cmd.exe, which re-parses the whole command line. Only allow that when
// the path and every argument are free of anything cmd.exe would interpret; otherwise refuse.
const isBatch = (p) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(p);
const SAFE_BATCH_ARG = /^[A-Za-z0-9._:\/\\\[\]=+-]*$/;
export function spawnArgs(bin, args) {
  if (!isBatch(bin)) return [bin, args, {}];
  if (/["%!^&|<>\r\n]/.test(bin) || !args.every((a) => SAFE_BATCH_ARG.test(a))) throw new BackendError(`refusing to run ${bin} through cmd.exe: its path or arguments (LOUPE_MODEL, LOUPE_EFFORT) contain characters cmd.exe would interpret. Point LOUPE_CLAUDE_BIN at an .exe, or simplify them.`);
  const line = [bin, ...args].map((a) => `"${a}"`).join(' ');
  // never a bare `cmd.exe`: Windows would look for it in the cwd first
  const comspec = process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return [comspec, ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
}

// A model name (--model / LOUPE_MODEL) ends up in `claude --model <name>` argv or an API body: allow only a plain id
// (no leading `-` that claude could read as a flag, no whitespace or control chars). Returns it or throws BackendError.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]*$/;
export function validateModel(m) {
  const s = String(m ?? '');
  if (!s) throw new BackendError('loupe: --model needs a value, e.g. sonnet, opus, claude-sonnet-5-5 or gpt-4.1');
  if (s.length > 200 || !MODEL_RE.test(s)) throw new BackendError(`loupe: invalid model name ${JSON.stringify(s.slice(0, 60))}${s.length > 60 ? '…' : ''}: use a plain model id or alias (letters, digits and . _ : / @ [ ] -), e.g. sonnet or claude-sonnet-5-5`);
  return s;
}
// the model a backend will use: LOUPE_MODEL (validated) or the backend's default ('' = claude's own default)
export const modelFor = (name) => (process.env.LOUPE_MODEL ? validateModel(process.env.LOUPE_MODEL) : DEFAULT_MODEL[name]);

// LOUPE_EFFORT ends up in `claude --effort <level>` argv or Anthropic's `output_config.effort`: allow-list only.
export const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function validateEffort(e) {
  const s = String(e ?? '').trim().toLowerCase();
  if (!s) return '';
  if (!EFFORTS.has(s)) throw new BackendError(`loupe: invalid LOUPE_EFFORT ${JSON.stringify(String(e).slice(0, 60))}: use one of ${[...EFFORTS].join(', ')}`);
  return s;
}

// ANTHROPIC_BASE_URL / OPENAI_BASE_URL receive the API key and the source code: https only, except a server on this
// machine (a local proxy or compatible model server), or any http host once LOUPE_ALLOW_HTTP=1 says the network is
// trusted (a model server on your LAN or Docker host). Returns the URL without trailing slashes or throws BackendError.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
export function checkBaseUrl(envName, value) {
  const raw = String(value).replace(/\/+$/, '');
  let u; try { u = new URL(raw); } catch { throw new BackendError(`loupe: ${envName} is not a valid URL`); }
  if (u.username || u.password) throw new BackendError(`loupe: ${envName} must not contain credentials; use the API key variable instead`);
  const allowHttp = /^(1|true|yes)$/i.test(String(process.env.LOUPE_ALLOW_HTTP || '').trim());
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (allowHttp || LOOPBACK.test(u.hostname)))) return raw;
  if (u.protocol !== 'http:') throw new BackendError(`loupe: ${envName} must be an https:// URL`);
  throw new BackendError(`loupe: ${envName} uses plain http://, which would send your API key and code unencrypted. Use https://, or set LOUPE_ALLOW_HTTP=1 if this server is on a network you trust (http://localhost is always allowed).`);
}
const BASE_URL = {
  anthropic: () => checkBaseUrl('ANTHROPIC_BASE_URL', process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
  openai: () => checkBaseUrl('OPENAI_BASE_URL', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
};

// -> { name, label, model, bin? } or throws BackendError with a message fit to show as-is.
export function resolveBackend(forced = process.env.LOUPE_BACKEND || '') {
  forced = String(forced).trim().toLowerCase();
  modelFor('claude'); // an invalid LOUPE_MODEL fails first, whichever backend
  validateEffort(process.env.LOUPE_EFFORT);
  if (forced && !Object.hasOwn(BACKENDS, forced)) throw new BackendError(`unknown backend "${forced}": use claude, anthropic or openai`);
  const claudeBin = process.env.LOUPE_CLAUDE_BIN || 'claude';
  const make = (name, extra = {}) => { if (BASE_URL[name]) BASE_URL[name](); return { name, label: BACKENDS[name], model: modelFor(name), ...extra }; };
  if (forced === 'claude') { const bin = findOnPath(claudeBin); if (!bin) throw new BackendError(`--backend claude: \`${claudeBin}\` was not found on PATH. Install Claude Code and sign in (https://docs.anthropic.com/en/docs/claude-code), or set LOUPE_CLAUDE_BIN.`); return make('claude', { bin }); }
  if (forced === 'anthropic') { if (!process.env.ANTHROPIC_API_KEY) throw new BackendError('--backend anthropic: ANTHROPIC_API_KEY is not set.'); return make('anthropic'); }
  if (forced === 'openai') { if (!process.env.OPENAI_API_KEY) throw new BackendError('--backend openai: OPENAI_API_KEY is not set.'); return make('openai'); }
  const bin = findOnPath(claudeBin);
  if (bin) return make('claude', { bin });
  if (process.env.ANTHROPIC_API_KEY) return make('anthropic');
  if (process.env.OPENAI_API_KEY) return make('openai');
  throw new BackendError(NO_BACKEND);
}

// ---------- the three ways to ask ----------
// claude runs in an empty private temp dir, never in the repo or its cache: Claude Code loads .claude/settings.json
// (hooks run commands), .mcp.json and CLAUDE.md from its working directory, and `-p` skips the trust prompt.
let claudeCwd;
function claudeDir() {
  if (!claudeCwd) {
    claudeCwd = mkdtempSync(join(tmpdir(), 'loupe-claude-'));
    process.on('exit', () => { try { rmSync(claudeCwd, { recursive: true, force: true }); } catch {} });
  }
  return claudeCwd;
}
const claudeSafeModeCache = new Map(); // bin -> boolean
function supportsSafeMode(bin) {
  if (claudeSafeModeCache.has(bin)) return claudeSafeModeCache.get(bin);
  let ok = false;
  try {
    const [cmd, args, extra] = spawnArgs(bin, ['--help']);
    const r = spawnSync(cmd, args, { cwd: claudeDir(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    ok = /--safe-mode\b/.test(`${r.stdout || ''}\n${r.stderr || ''}`);
  } catch {}
  claudeSafeModeCache.set(bin, ok);
  return ok;
}
function runClaude(b, prompt) {
  const cwd = claudeDir();
  const effort = validateEffort(process.env.LOUPE_EFFORT);
  const [cmd, args, extra] = spawnArgs(b.bin, [
    '-p',
    ...(b.model ? ['--model', b.model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--tools', '',
    '--strict-mcp-config',
    ...(supportsSafeMode(b.bin) ? ['--safe-mode'] : []),
    '--output-format', 'text',
  ]);
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...extra });
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.on('error', rej); p.stdin.on('error', () => {});
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))));
    p.stdin.end(prompt);
  });
}
// Best-effort secret redaction for error messages and stored evidence snippets:
// URL userinfo (up to the last @ before the host) and query strings, Slack webhook paths, and common token shapes.
export function redactSecrets(s) {
  return String(s)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/"'`<>]+@/gi, '$1***@')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>?#]+)\?[^\s"'`<>#)]+/gi, '$1?***')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>?#]+)#[^\s"'`<>)]+/gi, '$1#***')
    .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'`<>?#)]+/gi, '$1***')
    .replace(/\b(Bearer\s+)(?!\$\{)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}\b/g, '***')
    .replace(/\bwhsec_[A-Za-z0-9]{8,}\b/g, '***')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, '***')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '***')
    .replace(/\bxox[abpers]-[A-Za-z0-9-]{8,}\b/g, '***')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '***');
}
// strip secrets from anything we print: the API key, and credentials, query strings, or token shapes
const redact = (s, key) => {
  let t = redactSecrets(s);
  if (key) t = t.split(key).join('***');
  return t;
};
async function post(url, headers, body, key) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) {
    let host = '?'; try { host = new URL(url).host; } catch {}
    const why = [e.name, e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(': ');
    const err = new Error(redact(`request to ${host} failed: ${why}`, key));
    err.retry = e.name === 'TimeoutError' || !!e.cause; // network trouble; a malformed URL won't get better
    throw err;
  }
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(redact(`HTTP ${r.status}: ${text.slice(0, 300)}`, key));
    err.retry = r.status === 408 || r.status === 429 || r.status >= 500; err.retryAfter = Number(r.headers.get('retry-after')) || 0;
    throw err;
  }
  try { return JSON.parse(text); } catch { throw new Error(redact(`HTTP ${r.status}: response is not JSON: ${text.slice(0, 200)}`, key)); }
}
async function runAnthropic(b, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  const base = BASE_URL.anthropic();
  const effort = validateEffort(process.env.LOUPE_EFFORT);
  const j = await post(`${base}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: b.model, max_tokens: 16000, ...(effort ? { output_config: { effort } } : {}), messages: [{ role: 'user', content: prompt }] }, key);
  if (j.stop_reason === 'refusal') throw new Error('the model declined this request');
  return (Array.isArray(j.content) ? j.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
}
async function runOpenAI(b, prompt) {
  const key = process.env.OPENAI_API_KEY;
  const base = BASE_URL.openai();
  const j = await post(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, { model: b.model, messages: [{ role: 'user', content: prompt }] }, key);
  return String(j.choices?.[0]?.message?.content ?? '');
}
const RUN = { claude: runClaude, anthropic: runAnthropic, openai: runOpenAI };

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no JSON in LLM output: ' + text.slice(0, 200));
  return JSON.parse(text.slice(s, e + 1));
}
// The cache may sit inside the (untrusted) repo: only regular files count, never symlinks, and a bad entry is a miss.
function readCache(cp) {
  try { if (!lstatSync(cp).isFile()) return null; const j = JSON.parse(readFileSync(cp, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
function writeCache(cp, json) {
  try { unlinkSync(cp); } catch {}
  // 'wx' never follows a symlink; EEXIST means a parallel identical call just wrote the same answer
  try { writeFileSync(cp, JSON.stringify(json, null, 2), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// createLlm({ cache, log, nollm, onFail }) -> llm(tag, prompt) => parsed JSON object.
//   onFail 'throw' (scan) rethrows after 3 attempts; 'empty' (relations) returns {}.
// The backend is resolved on the first call that needs it, so fully cached reruns work without one.
// LOUPE_QUIET hides the per-call start/done lines (LOUPE_VERBOSE brings them back); failures always show.
export function createLlm({ cache, log, nollm = false, onFail = 'throw', trustCache = true }) {
  // a bad LOUPE_MODEL / LOUPE_EFFORT stops the step script up front (bin/loupe.mjs and map.mjs already check before any work)
  try { modelFor('claude'); validateEffort(process.env.LOUPE_EFFORT); } catch (e) { console.error(e.message); process.exit(2); }
  const CONCURRENCY = Math.max(1, Number(process.env.LOUPE_CONCURRENCY) || 6);
  const chatty = !process.env.LOUPE_QUIET || !!process.env.LOUPE_VERBOSE;
  let backend, backendErr;
  const getBackend = () => { if (backend === undefined && !backendErr) { try { backend = resolveBackend(); } catch (e) { backendErr = e; } } return backend; };
  // no usable backend: look up answers under the forced backend's key if there is one, else claude's
  const fallback = () => { const f = String(process.env.LOUPE_BACKEND || '').trim().toLowerCase(); const name = Object.hasOwn(BACKENDS, f) ? f : 'claude'; return { name, model: modelFor(name) }; };
  const stats = { cached: 0, fresh: 0, failed: 0 };
  let running = 0; const queue = [];
  const limit = (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); pump(); });
  function pump() { while (running < CONCURRENCY && queue.length) { const { fn, res, rej } = queue.shift(); running++; fn().then(res, rej).finally(() => { running--; pump(); }); } }
  // claude keeps the original key (model + prompt) so existing caches stay valid; API backends also hash in their name
  const keyFor = (b, prompt) => createHash('sha256').update((b.name === 'claude' ? '' : `${b.name}:`) + (b.model || 'default') + prompt).digest('hex').slice(0, 16);
  async function llm(tag, prompt) {
    const b = getBackend() || fallback(); // unresolved: still look in the cache
    // tags carry repo-derived names: keep them short enough for a file name
    const cp = join(cache, `${tag.replace(/[^a-z0-9]+/gi, '_').slice(0, 100)}-${keyFor(b, prompt)}.json`);
    const hit = trustCache ? readCache(cp) : null;
    if (hit) { stats.cached++; return hit; }
    if (nollm) return {};
    if (backendErr) { stats.failed++; log('llm fail', tag, backendErr.message.split('\n')[0]); if (onFail === 'empty') return {}; throw backendErr; }
    return limit(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const t0 = Date.now(); if (chatty) log('llm start', tag);
          const json = parseJson(await RUN[b.name](b, prompt));
          if (trustCache) writeCache(cp, json);
          stats.fresh++;
          if (chatty) log('llm done', tag, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
          return json;
        } catch (e) {
          log('llm fail', tag, attempt, String(e.message).slice(0, 200));
          if (attempt === 3 || e.retry === false) { stats.failed++; if (onFail === 'empty') return {}; throw e; }
          if (e.retry) await sleep(Math.min(60_000, (e.retryAfter || 2 ** attempt) * 1000));
        }
      }
    });
  }
  llm.stats = stats;
  llm.backend = getBackend;
  llm.summary = () => `llm answers: ${stats.cached} cached, ${stats.fresh} new${stats.failed ? `, ${stats.failed} failed` : ''}`;
  return llm;
}
