// One-command pipeline (`loupe map`) end to end, against fake models only: a local stub HTTP server stands in
// for the Anthropic and OpenAI APIs, and a tiny node script stands in for the `claude` CLI. Never touches the network.
// Usage: node test/pipeline.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOnPath } from '../src/llm.mjs';
import { answer } from './_stub-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'loupe.mjs');
const KEY = 'sk-test-SECRET-6f1d0c9e';
const TMP = mkdtempSync(join(tmpdir(), 'loupe-pipe-'));
let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { failures++; if (extra) console.log(String(extra).slice(0, 3000)); } };

// ---------- stub HTTP server (Anthropic + OpenAI shapes) ----------
const seen = { count: 0, auth: [], models: [], badKeyRequests: 0 };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key.startsWith('sk-bad')) { seen.badKeyRequests++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `invalid x-api-key: ${key}` } })); }
    seen.count++; seen.auth.push(req.headers['x-api-key'] ? `x-api-key:${key}` : `bearer:${key}`);
    seen.models.push(JSON.parse(body).model);
    const prompt = JSON.parse(body).messages[0].content;
    const text = JSON.stringify(answer(prompt));
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/messages') res.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
    else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    else { res.writeHead(404); res.end('{}'); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- PATH with git but no claude; a fake claude in its own dir ----------
const gitBin = findOnPath('git');
if (!gitBin) { console.error('git not found'); process.exit(2); }
const noClaudeDir = join(TMP, 'bin-plain'); mkdirSync(noClaudeDir); symlinkSync(gitBin, join(noClaudeDir, 'git'));
const fakeClaudeDir = join(TMP, 'bin-claude'); mkdirSync(fakeClaudeDir);
const fakeClaudeLog = join(TMP, 'claude-calls.log');
// plain CommonJS (no extension, no package.json): read the prompt from stdin, answer like the stub model
writeFileSync(join(fakeClaudeDir, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
import(${JSON.stringify(pathToFileURL(join(ROOT, 'test', '_stub-model.mjs')).href)}).then(({ answer }) => process.stdout.write('Here you go:\\n' + JSON.stringify(answer(prompt))));
`);
chmodSync(join(fakeClaudeDir, 'claude'), 0o755);

// a child env with every real credential and loupe setting removed
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|OPENAI_|LOUPE_|CLAUDE)/.test(k)) env[k] = v;
  return { ...env, PATH: noClaudeDir, LOUPE_NO_OPEN: '1', CI: '1', ...extra };
}
// keys: written to a piped stdin (null: stdin ignored; "": a piped stdin left open and silent); timeout kills a hang
function run(args, env, { keys = null, timeout = 60_000 } = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, stdio: [keys === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '', hung = false;
    const t = setTimeout(() => { hung = true; p.kill(); }, timeout);
    if (keys !== null && keys !== '') p.stdin.write(keys); // '' keeps stdin open and silent
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); res({ code, out, err, all: out + err, hung }); });
  });
}
const claudeCalls = () => (existsSync(fakeClaudeLog) ? readFileSync(fakeClaudeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const modelArg = (c) => { const i = c.argv.indexOf('--model'); return i < 0 ? null : c.argv[i + 1]; };
function fixture(name) {
  const dir = join(TMP, name); mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', type: 'module' }));
  writeFileSync(join(dir, 'src', 'util.js'), `export function helper() {\n  return [{ id: 1 }];\n}\n`);
  writeFileSync(join(dir, 'src', 'server.js'), `import express from 'express';\nimport { helper } from './util.js';\n\nconst app = express();\napp.get('/api/items', (req, res) => res.json(helper()));\napp.listen(3000);\n`);
  mkdirSync(join(dir, 'test')); writeFileSync(join(dir, 'test', 'spec.js'), `import { helper } from '../src/util.js';\nhelper();\n`);
  writeFileSync(join(dir, 'src', 'client.js'), `import { helper } from './util.js';\n\nexport async function loadItems() {\n  const r = await fetch('/api/items');\n  return (await r.json()).concat(helper());\n}\n`);
  const git = (...a) => execFileSync(gitBin, a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return dir;
}
function st0() { return join(TMP, 'none'); }
function checkMap(dir, r, what) {
  check(r.code === 0, `${what}: exits 0`, r.all);
  const html = join(dir, 'architecture.html');
  check(existsSync(html), `${what}: wrote architecture.html`);
  const text = existsSync(html) ? readFileSync(html, 'utf8') : '';
  check(text.includes('"id":"system"') && text.includes('Stub System') && !text.includes('/*__ZOOM_TREE__*/null'), `${what}: html has the inlined tree`);
  check(existsSync(join(dir, '.loupe', 'tree.json')) && existsSync(join(dir, '.loupe', 'tree.files.json')), `${what}: .loupe/tree.json + sidecar`);
  check(readFileSync(join(dir, '.loupe', '.gitignore'), 'utf8').includes('*'), `${what}: .loupe/.gitignore`);
  check(existsSync(join(dir, '.loupe', 'cache')), `${what}: cache in .loupe/cache`);
  check(/\[1\/3\][\s\S]*\[2\/3\][\s\S]*\[3\/3\][\s\S]*✓ wrote/.test(r.out), `${what}: progress output`, r.out);
  check(!r.all.includes('llm start'), `${what}: per-call lines hidden`, r.err);
  check(!r.all.includes(KEY), `${what}: key never printed`);
  const tree = JSON.parse(readFileSync(join(dir, '.loupe', 'tree.json'), 'utf8'));
  check(Array.isArray(tree.root.relations) && tree.root.relations.some((x) => x.kind === 'http'), `${what}: relations found the http route`, JSON.stringify(tree.root.relations));
}

try {
  // help / version / argument errors
  let r = await run(['--help'], childEnv());
  check(r.code === 0 && ['map', '--out', '--no-open', '--backend', '--model', '--verbose'].every((s) => r.out.includes(s)), '--help lists map and its flags', r.all);
  r = await run(['--version'], childEnv());
  check(r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out.trim()), '--version');

  // no backend at all: exit 2 with the friendly message, before any work
  const none = fixture('none');
  r = await run(['map', none, '--no-open'], childEnv());
  check(r.code === 2 && r.all.includes('ANTHROPIC_API_KEY') && r.all.includes('OPENAI_API_KEY') && r.all.includes('Claude Code'), 'no backend: exit 2 + friendly message', r.all);
  check(!existsSync(join(none, '.loupe')), 'no backend: nothing written');
  r = await run(['--backend', 'nope', none], childEnv());
  check(r.code === 2 && r.all.includes('unknown backend'), 'unknown backend rejected', r.all);
  r = await run(['map', none, '--backend', 'openai'], childEnv());
  check(r.code === 2 && r.all.includes('OPENAI_API_KEY is not set'), 'forced backend without key rejected', r.all);
  const notGit = join(TMP, 'not-git'); mkdirSync(notGit);
  r = await run([notGit, '--no-open'], childEnv({ OPENAI_API_KEY: KEY }));
  check(r.code === 2 && r.all.includes('not inside a git repository'), 'not a git repo: friendly error', r.all);

  // openai, via cwd default + flags-only invocation, then rerun for the cache
  const oa = fixture('openai');
  const oaEnv = childEnv({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `${BASE}/v1` });
  r = await new Promise((res) => { const p = spawn(process.execPath, [BIN, '--no-open', '--backend', 'openai'], { cwd: oa, env: oaEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', (code) => res({ code, out, err, all: out + err })); });
  checkMap(oa, r, 'openai');
  check(r.out.includes('backend: openai'), 'openai: backend line', r.out);
  const after1 = seen.count;
  check(after1 > 0 && seen.auth.every((a) => a === `bearer:${KEY}`), 'openai: stub saw Authorization: Bearer', seen.auth.join(' '));
  r = await run(['map', oa, '--no-open', '--backend', 'openai'], oaEnv);
  check(r.code === 0 && seen.count === after1, 'openai: second run is served from the cache', `requests ${after1} -> ${seen.count}\n${r.all}`);
  check(/0 new/.test(r.err), 'openai: cache summary says 0 new', r.err);

  // anthropic: picked automatically from ANTHROPIC_API_KEY (no claude on PATH), --out elsewhere
  const an = fixture('anthropic');
  seen.auth = [];
  const outFile = join(TMP, 'out', 'map.html');
  r = await run(['map', an, '--out', outFile], childEnv({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE }));
  check(r.code === 0 && existsSync(outFile) && !existsSync(join(an, 'architecture.html')) && existsSync(join(an, '.loupe', 'tree.json')), 'anthropic: --out honoured, .loupe/ in repo', r.all);
  check(r.out.includes('backend: anthropic'), 'anthropic: auto-selected', r.out);
  check(seen.auth.length > 0 && seen.auth.every((a) => a === `x-api-key:${KEY}`), 'anthropic: stub saw x-api-key', seen.auth.join(' '));
  check(!r.all.includes(KEY), 'anthropic: key never printed');

  // a rejected key: the error is shown, the key is redacted, no retries on 401
  const bad = fixture('bad');
  const BAD = 'sk-bad-0123456789abcdef';
  r = await run(['map', bad, '--no-open'], childEnv({ ANTHROPIC_API_KEY: BAD, ANTHROPIC_BASE_URL: BASE }));
  check(r.code !== 0 && r.all.includes('HTTP 401') && r.all.includes('***') && !r.all.includes(BAD), 'bad key: HTTP 401 shown, key redacted', r.all);

  // claude: the fake CLI on PATH wins over API keys
  const cl = fixture('claude');
  const before = seen.count;
  r = await run(['map', cl, '--no-open'], childEnv({ PATH: [fakeClaudeDir, noClaudeDir].join(delimiter), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE }));
  checkMap(cl, r, 'claude');
  check(r.out.includes('backend: claude (Claude Code CLI, default model)'), 'claude: auto-selected over ANTHROPIC_API_KEY, default model', r.out);
  check(seen.count === before, 'claude: no HTTP requests');
  const calls = claudeCalls();
  check(calls.length > 0 && calls.every((c) => JSON.stringify(c.argv) === JSON.stringify(['-p', '--tools', '', '--output-format', 'text'])), 'claude: CLI called headless with tools off', JSON.stringify(calls[0]));
  // the repo could plant .claude/settings.json (hooks) or CLAUDE.md: claude must never run inside it
  check(calls.length > 0 && calls.every((c) => !c.cwd.startsWith(cl)), 'claude: runs outside the repo', JSON.stringify(calls[0]));
  const tree = JSON.parse(readFileSync(join(cl, '.loupe', 'tree.json'), 'utf8'));
  check(!JSON.stringify(tree).includes('test/spec.js'), 'top-level test/ is not mapped as source');

  // ---------- --model / LOUPE_MODEL ----------
  const clEnv = (extra = {}) => childEnv({ PATH: [fakeClaudeDir, noClaudeDir].join(delimiter), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `${BASE}/v1`, ...extra });
  let n0 = claudeCalls().length, h0 = seen.count;
  r = await run(['map', cl, '--no-open', '--model', 'sonnet'], clEnv());
  let fresh = claudeCalls().slice(n0);
  check(r.code === 0 && r.out.includes('backend: claude (Claude Code CLI, model sonnet)'), 'claude --model: backend line shows the model', r.all);
  check(fresh.length > 0 && fresh.every((c) => modelArg(c) === 'sonnet' && c.argv[0] === '-p'), 'claude --model: a new model misses the cache, CLI gets --model sonnet', JSON.stringify(fresh[0]));
  n0 = claudeCalls().length;
  r = await run(['map', cl, '--no-open', '--model=sonnet'], clEnv());
  check(r.code === 0 && claudeCalls().length === n0, 'claude --model=sonnet again: served from the cache', r.all);
  r = await run(['map', cl, '--no-open'], clEnv());
  check(r.code === 0 && claudeCalls().length === n0 && /0 new/.test(r.err), 'claude default model: still its own cache entries', r.all);
  r = await run(['map', cl, '--no-open'], clEnv({ LOUPE_MODEL: 'haiku' }));
  fresh = claudeCalls().slice(n0);
  check(r.code === 0 && r.out.includes('model haiku') && fresh.length > 0 && fresh.every((c) => modelArg(c) === 'haiku'), 'LOUPE_MODEL alone reaches claude', JSON.stringify(fresh[0]) + r.all);
  n0 = claudeCalls().length;
  r = await run(['map', cl, '--no-open', '--model', 'opus'], clEnv({ LOUPE_MODEL: 'haiku' }));
  fresh = claudeCalls().slice(n0);
  check(r.code === 0 && r.out.includes('model opus') && fresh.length > 0 && fresh.every((c) => modelArg(c) === 'opus'), '--model wins over LOUPE_MODEL', JSON.stringify(fresh[0]) + r.all);
  check(seen.count === h0, 'claude --model runs: no HTTP requests');

  // API backends: body.model is the flag, else the unchanged default
  const anM = fixture('anthropic-model');
  seen.models = [];
  r = await run(['map', anM, '--no-open', '--backend', 'anthropic'], clEnv());
  check(r.code === 0 && r.out.includes('backend: anthropic (Anthropic API, model claude-opus-5-5)') && seen.models.length > 0 && seen.models.every((m) => m === 'claude-opus-5-5'), 'anthropic default model in body + backend line', seen.models.join(' ') + r.all);
  seen.models = [];
  r = await run(['map', anM, '--no-open', '--backend', 'anthropic', '--model', 'claude-haiku-5-5'], clEnv());
  check(r.code === 0 && r.out.includes('model claude-haiku-5-5') && seen.models.length > 0 && seen.models.every((m) => m === 'claude-haiku-5-5'), 'anthropic --model: body.model, new requests', seen.models.join(' ') + r.all);
  seen.models = [];
  r = await run(['map', anM, '--no-open', '--backend=openai', '--model=gpt-6-luna'], clEnv());
  check(r.code === 0 && r.out.includes('backend: openai (OpenAI API, model gpt-6-luna)') && seen.models.length > 0 && seen.models.every((m) => m === 'gpt-6-luna'), 'openai --model: body.model', seen.models.join(' ') + r.all);
  seen.models = [];
  r = await run(['map', anM, '--no-open', '--backend=openai', '--model=gpt-6-luna'], clEnv());
  check(r.code === 0 && seen.models.length === 0, 'openai --model again: cache hit', r.all);

  // rejected model names: exit 2, nothing spawned, no request, nothing written
  const rej = fixture('reject-model');
  for (const [args, extra, what] of [
    [['--model', '-x'], {}, '--model -x'],
    [['--model=--dangerously-skip-permissions'], {}, '--model=--dangerously-skip-permissions'],
    [['--model', ''], {}, "--model ''"],
    [['--model='], {}, '--model='],
    [['--model'], {}, '--model without a value'],
    [[], { LOUPE_MODEL: 'a b' }, "LOUPE_MODEL='a b'"],
    [[], { LOUPE_MODEL: 'x'.repeat(201) }, 'LOUPE_MODEL too long'],
    [['--backend', 'anthropic', '--model', 'claude\nopus'], {}, 'a newline in --model'],
  ]) {
    n0 = claudeCalls().length; h0 = seen.count;
    r = await run(['map', rej, '--no-open', ...args], clEnv(extra));
    check(r.code === 2 && /model/.test(r.err) && claudeCalls().length === n0 && seen.count === h0 && !existsSync(join(rej, '.loupe')), `${what}: rejected with exit 2 before any work`, r.all);
  }
  for (const args of [['scan', rej, join(TMP, 'rej.tree.json'), '--model=-x'], ['scan', rej, join(TMP, 'rej.tree.json'), '--model'], ['relations', rej, join(TMP, 'rej.tree.json'), '--model', 'a;b']]) {
    n0 = claudeCalls().length;
    r = await run(args, clEnv());
    check(r.code === 2 && /model/.test(r.err) && claudeCalls().length === n0 && !existsSync(join(TMP, 'rej.tree.json')), `${args[0]} ${args.slice(3).join(' ')}: rejected with exit 2`, r.all);
  }
  r = await run(['scan', rej, join(TMP, 'rej.tree.json')], clEnv({ LOUPE_MODEL: '-p' }));
  check(r.code === 2 && claudeCalls().length === n0, "scan with LOUPE_MODEL='-p': rejected", r.all);

  // ---------- the picker: never without a terminal; LOUPE_FORCE_TTY drives it through a pipe ----------
  const pk = fixture('picker');
  n0 = claudeCalls().length;
  r = await run(['map', pk, '--no-open'], clEnv({ CI: '' }), { keys: '', timeout: 30_000 });
  check(r.code === 0 && !r.hung && !r.all.includes('Which model') && r.out.includes('backend: claude (Claude Code CLI, default model)'), 'piped stdio, no flags: no prompt, automatic choice', r.all);
  check(!existsSync(join(pk, '.loupe', 'config.json')), 'non-interactive run writes no config.json');
  writeFileSync(join(pk, '.loupe', 'config.json'), JSON.stringify({ backend: 'openai', model: 'gpt-6-luna' }));
  seen.models = [];
  r = await run(['map', pk, '--no-open'], clEnv({ CI: '' }), { keys: '' , timeout: 30_000 });
  check(r.code === 0 && seen.models.length === 0 && r.out.includes('default model'), 'non-interactive run ignores config.json', r.all);
  rmSync(join(pk, '.loupe', 'config.json'));

  const ttyEnv = clEnv({ LOUPE_FORCE_TTY: '1', NO_COLOR: '1' });
  n0 = claudeCalls().length;
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\x1b[B\r', timeout: 30_000 });
  fresh = claudeCalls().slice(n0);
  check(r.code === 0 && r.out.includes('Which model') && r.out.includes('Claude Code · your subscription') && r.out.includes('OpenAI API · OPENAI_API_KEY') && r.out.includes('✓ Model  Claude Code · Sonnet'), 'picker: shown, down + enter picks Sonnet', r.all);
  check(r.out.includes('backend: claude (Claude Code CLI, model sonnet)') && fresh.length > 0 && fresh.every((c) => modelArg(c) === 'sonnet'), 'picker: choice reaches the claude CLI', JSON.stringify(fresh[0]) + r.out);
  check(!/\x1b\[[0-9;]*m/.test(r.out), 'picker: NO_COLOR writes no colour codes');
  let cfg = null; try { cfg = JSON.parse(readFileSync(join(pk, '.loupe', 'config.json'), 'utf8')); } catch {}
  check(cfg?.backend === 'claude' && cfg?.model === 'sonnet', 'picker: remembers the choice in .loupe/config.json', JSON.stringify(cfg));
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\r', timeout: 30_000 });
  check(r.code === 0 && r.out.includes('✓ Model  Claude Code · Sonnet') && r.out.includes('model sonnet'), 'picker: remembered choice is preselected', r.all);
  seen.models = [];
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\x1b[A\r', timeout: 30_000 }); // Sonnet -> up -> Default
  check(r.code === 0 && r.out.includes('✓ Model  Claude Code · Default') && r.out.includes('default model') && JSON.parse(readFileSync(join(pk, '.loupe', 'config.json'), 'utf8')).model === '', 'picker: Default claude passes no model', r.all);
  writeFileSync(join(pk, '.loupe', 'config.json'), JSON.stringify({ backend: 'claude', model: '--dangerously-skip-permissions' }));
  n0 = claudeCalls().length;
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\r', timeout: 30_000 });
  check(r.code === 0 && r.out.includes('✓ Model  Claude Code · Default') && claudeCalls().slice(n0).every((c) => !c.argv.includes('--dangerously-skip-permissions')), 'picker: a tampered config.json is ignored', r.all);
  for (const [content, what] of [['{not json', 'malformed'], [JSON.stringify({ backend: 'claude', model: 'sonnet', pad: 'x'.repeat(10_000) }), 'huge'], ['{"__proto__": {"backend": "claude", "model": "sonnet"}}', '__proto__']]) {
    writeFileSync(join(pk, '.loupe', 'config.json'), content);
    r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\r', timeout: 30_000 });
    check(r.code === 0 && r.out.includes('✓ Model  Claude Code · Default'), `picker: a ${what} config.json is ignored`, r.all);
  }
  const keep = join(TMP, 'keep.json'); writeFileSync(keep, 'keep');
  rmSync(join(pk, '.loupe', 'config.json')); symlinkSync(keep, join(pk, '.loupe', 'config.json'));
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\x1b[B\r', timeout: 30_000 });
  check(r.code === 2 && r.all.includes('refusing') && readFileSync(keep, 'utf8') === 'keep', 'picker: a config.json symlink is refused, not written through', r.all);
  rmSync(join(pk, '.loupe', 'config.json'));
  n0 = claudeCalls().length; h0 = seen.count;
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\x1b[B\x03', timeout: 30_000 });
  check(r.code === 130 && r.out.includes('cancelled') && !r.all.includes('at ') && !r.out.includes('[1/3]') && claudeCalls().length === n0 && seen.count === h0, 'picker: ctrl-c exits 130, no work, no stack trace', r.all);
  r = await run(['map', pk, '--no-open'], ttyEnv, { keys: '\x1b', timeout: 30_000 });
  check(r.code === 130 && r.out.includes('cancelled') && !r.out.includes('[1/3]'), 'picker: esc cancels', r.all);
  for (const [extra, args, what] of [[{}, ['--model', 'haiku'], '--model'], [{}, ['--backend', 'claude'], '--backend'], [{ LOUPE_MODEL: 'haiku' }, [], 'LOUPE_MODEL'], [{ LOUPE_BACKEND: 'claude' }, [], 'LOUPE_BACKEND']]) {
    r = await run(['map', pk, '--no-open', ...args], { ...ttyEnv, ...extra }, { keys: '', timeout: 30_000 });
    check(r.code === 0 && !r.hung && !r.out.includes('Which model'), `picker: not shown with ${what}`, r.all);
  }
  r = await run(['map', pk, '--no-open'], { ...ttyEnv, PATH: noClaudeDir, OPENAI_API_KEY: '' }, { keys: '\x1b[B\r', timeout: 30_000 });
  check(r.code === 0 && r.out.includes('✓ Model  Anthropic API · claude-haiku-5-5') && r.out.includes('model claude-haiku-5-5'), 'picker: API-only options start at the backend default', r.all);

  // a hostile repo: committed symlinks for .loupe/, .loupe/cache, .loupe/tree.json or architecture.html are refused
  const victim = join(TMP, 'victim'); mkdirSync(victim); writeFileSync(join(victim, 'precious'), 'keep');
  const symEnv = childEnv({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `${BASE}/v1` });
  for (const [name, setup] of [
    ['.loupe -> elsewhere', (d) => symlinkSync(victim, join(d, '.loupe'))],
    ['.loupe/cache -> elsewhere', (d) => { mkdirSync(join(d, '.loupe')); symlinkSync(victim, join(d, '.loupe', 'cache')); }],
    ['.loupe/tree.json -> file', (d) => { mkdirSync(join(d, '.loupe')); symlinkSync(join(victim, 'precious'), join(d, '.loupe', 'tree.json')); }],
    ['architecture.html -> file', (d) => symlinkSync(join(victim, 'precious'), join(d, 'architecture.html'))],
  ]) {
    const d = fixture('sym-' + name.replace(/\W+/g, '_')); setup(d);
    r = await run(['map', d, '--no-open'], symEnv);
    check(r.code === 2 && r.all.includes('refusing') && readFileSync(join(victim, 'precious'), 'utf8') === 'keep' && !existsSync(join(victim, '.gitignore')), `symlink ${name}: refused, nothing written through it`, r.all);
  }
  r = await run(['scan', st0(), '--backend'], symEnv);
  check(r.code === 2 && r.all.includes('--backend needs a value'), 'scan --backend without a value rejected', r.all);

  // the step-by-step subcommands still work, with --backend
  const st = fixture('steps');
  const stEnv = childEnv({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `${BASE}/v1` });
  const treePath = join(TMP, 'steps-out', 'steps.tree.json'); mkdirSync(dirname(treePath));
  r = await run(['scan', st, treePath, '--backend', 'openai'], stEnv);
  check(r.code === 0 && existsSync(treePath) && existsSync(join(TMP, 'steps-out', '.loupe-cache')), 'scan subcommand (cache next to output)', r.all);
  r = await run(['relations', st, treePath, '--backend=openai'], stEnv);
  check(r.code === 0, 'relations subcommand', r.all);
  seen.models = [];
  r = await run(['scan', st, treePath, '--backend', 'openai', '--model', 'gpt-6.2-sol'], stEnv);
  check(r.code === 0 && seen.models.length > 0 && seen.models.every((m) => m === 'gpt-6.2-sol'), 'scan --model reaches the API', seen.models.join(' ') + r.all);
  seen.models = [];
  r = await run(['relations', st, treePath, '--backend=openai', '--model=gpt-6.2-sol'], { ...stEnv, LOUPE_MODEL: 'gpt-4.1' });
  check(r.code === 0 && seen.models.length > 0 && seen.models.every((m) => m === 'gpt-6.2-sol'), 'relations --model reaches the API, over LOUPE_MODEL', seen.models.join(' ') + r.all);
  const n1 = claudeCalls().length;
  r = await run(['relations', st, treePath, '--model', 'haiku'], { ...stEnv, PATH: [fakeClaudeDir, noClaudeDir].join(delimiter) });
  check(r.code === 0 && claudeCalls().length > n1 && claudeCalls().slice(n1).every((c) => modelArg(c) === 'haiku'), 'relations --model reaches the claude CLI', r.all);
  r = await run(['render', treePath], stEnv);
  check(r.code === 0 && existsSync(join(TMP, 'steps-out', 'steps.html')), 'render subcommand', r.all);
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.error(failures ? `FAIL (${failures})` : 'PASS');
process.exitCode = failures ? 1 : 0;
