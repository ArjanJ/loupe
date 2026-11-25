// One-command pipeline (`loupe map`) end to end, against fake models only: a local stub HTTP server stands in
// for the Anthropic and OpenAI APIs, and a tiny node script stands in for the `claude` CLI. Never touches the network.
// Usage: node test/pipeline.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOnPath, redactSecrets, checkBaseUrl } from '../src/llm.mjs';
import { answer } from './_stub-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'loupe.mjs');
const KEY = 'sk-test-SECRET-6f1d0c9e';
const TMP = mkdtempSync(join(tmpdir(), 'loupe-pipe-'));
let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { failures++; if (extra) console.log(String(extra).slice(0, 3000)); } };

// ---------- stub HTTP server (Anthropic + OpenAI shapes) ----------
const seen = { count: 0, auth: [], models: [], prompts: [], badKeyRequests: 0 };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key.startsWith('sk-bad')) { seen.badKeyRequests++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `invalid x-api-key: ${key}` } })); }
    seen.count++; seen.auth.push(req.headers['x-api-key'] ? `x-api-key:${key}` : `bearer:${key}`);
    seen.models.push(JSON.parse(body).model);
    const prompt = JSON.parse(body).messages[0].content;
    seen.prompts.push(prompt);
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
// plain CommonJS (no extension, no package.json): answer --help, else read the prompt from stdin and answer like the stub model
const writeFakeClaude = (dir, helpText) => {
  writeFileSync(join(dir, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--help')) { process.stdout.write(${JSON.stringify(helpText)}); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
import(${JSON.stringify(pathToFileURL(join(ROOT, 'test', '_stub-model.mjs')).href)}).then(({ answer }) => process.stdout.write('Here you go:\\n' + JSON.stringify(answer(prompt))));
`);
  chmodSync(join(dir, 'claude'), 0o755);
};
writeFakeClaude(fakeClaudeDir, 'Usage: claude [options]\n  --strict-mcp-config\n  --safe-mode\n');
const fakeClaudeOldDir = join(TMP, 'bin-claude-old'); mkdirSync(fakeClaudeOldDir);
writeFakeClaude(fakeClaudeOldDir, 'Usage: claude [options]\n  --strict-mcp-config\n');

// a child env with every real credential and loupe setting removed
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|OPENAI_|LOUPE_|CLAUDE)/.test(k)) env[k] = v;
  return { ...env, PATH: noClaudeDir, LOUPE_NO_OPEN: '1', CI: '1', ...extra };
}
// keys: written to a piped stdin (null: stdin ignored; "": a piped stdin left open and silent); timeout kills a hang
function run(args, env, { keys = null, timeout = 60_000, cwd } = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: [keys === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
  check(r.code !== 0 && r.all.includes('HTTP 401') && r.all.includes('***') && !r.all.includes(BAD) && /scanning failed \(exit 1\)/.test(r.err), 'bad key: HTTP 401 shown, key redacted, keeps scanning failed line', r.all);

  // claude: the fake CLI on PATH wins over API keys
  const cl = fixture('claude');
  const before = seen.count;
  r = await run(['map', cl, '--no-open'], childEnv({ PATH: [fakeClaudeDir, noClaudeDir].join(delimiter), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: BASE }));
  checkMap(cl, r, 'claude');
  check(r.out.includes('backend: claude (Claude Code CLI, default model)'), 'claude: auto-selected over ANTHROPIC_API_KEY, default model', r.out);
  check(seen.count === before, 'claude: no HTTP requests');
  const calls = claudeCalls();
  check(calls.length > 0 && calls.every((c) => JSON.stringify(c.argv) === JSON.stringify(['-p', '--tools', '', '--strict-mcp-config', '--safe-mode', '--output-format', 'text'])), 'claude: CLI called headless with tools off, --strict-mcp-config and --safe-mode', JSON.stringify(calls[0]));
  // older claude CLI without --safe-mode in --help: passes --strict-mcp-config but omits --safe-mode
  const clOld = fixture('claude-old');
  const nOld = claudeCalls().length;
  r = await run(['map', clOld, '--no-open'], childEnv({ PATH: [fakeClaudeOldDir, noClaudeDir].join(delimiter) }));
  const oldCalls = claudeCalls().slice(nOld);
  check(r.code === 0 && oldCalls.length > 0 && oldCalls.every((c) => JSON.stringify(c.argv) === JSON.stringify(['-p', '--tools', '', '--strict-mcp-config', '--output-format', 'text'])), 'claude (older CLI): omits --safe-mode when not in --help', JSON.stringify(oldCalls[0]) + r.all);
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

  // ---------- standalone scan / relations / render / manifest refuse symlinks ----------
  {
    const b1Victim = join(TMP, 'b1-victim'); mkdirSync(b1Victim);
    const b1File = join(b1Victim, 'precious'); writeFileSync(b1File, 'keep');

    // scan: loupe-tree.json symlink
    const s1 = fixture('b1-scan-tree');
    symlinkSync(b1File, join(s1, 'loupe-tree.json'));
    r = await run(['scan', '.', '--backend', 'openai'], stEnv, { cwd: s1 });
    check(r.code === 2 && r.all.includes('refusing') && readFileSync(b1File, 'utf8') === 'keep', 'symlinks: scan refuses loupe-tree.json symlink', r.all);

    // scan: .loupe-cache symlink
    const s2 = fixture('b1-scan-cache');
    symlinkSync(b1Victim, join(s2, '.loupe-cache'));
    r = await run(['scan', '.', '--backend', 'openai'], stEnv, { cwd: s2 });
    check(r.code === 2 && r.all.includes('refusing') && !existsSync(join(s2, 'loupe-tree.json')), 'symlinks: scan refuses .loupe-cache symlink', r.all);

    // render: loupe-tree.html symlink
    const s3 = fixture('b1-render-html');
    writeFileSync(join(s3, 'loupe-tree.json'), readFileSync(treePath, 'utf8'));
    symlinkSync(b1File, join(s3, 'loupe-tree.html'));
    r = await run(['render', 'loupe-tree.json'], stEnv, { cwd: s3 });
    check(r.code === 2 && r.all.includes('refusing') && readFileSync(b1File, 'utf8') === 'keep', 'symlinks: render refuses loupe-tree.html symlink', r.all);

    // relations: tree symlink and .loupe-cache symlink
    const s4 = fixture('b1-rel-cache');
    writeFileSync(join(s4, 'loupe-tree.json'), readFileSync(treePath, 'utf8'));
    writeFileSync(join(s4, 'loupe-tree.files.json'), readFileSync(treePath.replace(/\.json$/, '.files.json'), 'utf8'));
    symlinkSync(b1Victim, join(s4, '.loupe-cache'));
    r = await run(['relations', '.', 'loupe-tree.json', '--backend', 'openai'], stEnv, { cwd: s4 });
    check(r.code === 2 && r.all.includes('refusing'), 'symlinks: relations refuses .loupe-cache symlink', r.all);

    const s5 = fixture('b1-rel-tree');
    symlinkSync(b1File, join(s5, 'loupe-tree.json'));
    r = await run(['relations', '.', 'loupe-tree.json', '--backend', 'openai'], stEnv, { cwd: s5 });
    check(r.code === 2 && r.all.includes('refusing') && readFileSync(b1File, 'utf8') === 'keep', 'symlinks: relations refuses tree.json symlink', r.all);

    // manifest: output symlink
    const manDir = join(TMP, 'b1-manifest'); mkdirSync(manDir);
    writeFileSync(join(manDir, 'sys.yaml'), 'system:\n  name: Demo\nservices:\n  - id: api\n    description: Main API.\n');
    symlinkSync(b1File, join(manDir, 'sys.tree.json'));
    r = await run(['manifest', join(manDir, 'sys.yaml')], stEnv);
    check(r.code === 2 && r.all.includes('refusing') && readFileSync(b1File, 'utf8') === 'keep', 'symlinks: manifest refuses output symlink', r.all);
  }

  // ---------- --out parent dir realpath-confined when inside the repo ----------
  {
    const f5Victim = join(TMP, 'f5-victim'); mkdirSync(f5Victim);
    const f5 = fixture('f5-out-dir');
    symlinkSync(f5Victim, join(f5, 'docs'));
    r = await run(['map', f5, '--out', join(f5, 'docs', 'map.html'), '--no-open', '--backend', 'openai'], stEnv);
    check(r.code === 2 && r.all.includes('refusing') && !existsSync(join(f5Victim, 'map.html')), '--out confinement: --out through symlinked dir inside repo is refused', r.all);
  }

  // ---------- secret redaction in evidence snippets (unit + end-to-end) ----------
  {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const samples = [
      ['https://user:p@ss@api.example.com/v1?api_key=TOPSECRET', ['user:p@ss', 'TOPSECRET']],
      ['https://hooks.slack.com/services/T0001/B0001/SLACKWEBHOOKSECRET', ['SLACKWEBHOOKSECRET']],
      ['Authorization: "Bearer supersecrettoken1234"', ['supersecrettoken1234']],
      ['const a = "sk-ant-api03-1234567890abcdef";', ['1234567890abcdef']],
      ['const b = "sk_live_STRIPESECRET123";', ['STRIPESECRET123']],
      ['const c = "ghp_1234567890abcdefghij";', ['1234567890abcdefghij']],
      ['const d = "github_pat_11ABCDEFGH_1234567890";', ['11ABCDEFGH_1234567890']],
      ['const e = "xoxb-1234567890-abcdef";', ['1234567890-abcdef']],
      ['const f = "AKIAIOSFODNN7EXAMPLE";', ['AKIAIOSFODNN7EXAMPLE']],
      ['const g = "AIzaSyFAKE0FAKE0FAKE0FAKE0FAKE0FAKE0FAK";', ['AIzaSyFAKE0FAKE0']],
      [`const h = "${jwt}";`, ['SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c']],
    ];
    for (const [input, leaks] of samples) {
      const out = redactSecrets(input);
      check(leaks.every((l) => !out.includes(l)) && out.includes('***'), `evidence redaction: ${leaks[0]}`, out);
    }
    const f1 = fixture('f1-secrets');
    writeFileSync(join(f1, 'src', 'server.js'), [
      `import express from 'express';`,
      `const SLACK = "https://hooks.slack.com/services/T0001/B0001/SLACKWEBHOOKSECRET";`,
      `export async function bill() {`,
      `  await fetch("https://api.stripe.com/v1/charges?api_key=sk_live_STRIPESECRET", { headers: { Authorization: "Bearer sk_live_STRIPESECRET" } });`,
      `  return SLACK;`,
      `}`,
      `const app = express();`,
      `app.get('/api/items', (req, res) => res.json([]));`,
    ].join('\n'));
    execFileSync(gitBin, ['add', '-A'], { cwd: f1, stdio: 'pipe' });
    execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'secrets'], { cwd: f1, stdio: 'pipe' });
    r = await run(['map', f1, '--no-open', '--backend', 'openai'], stEnv);
    const htmlF1 = readFileSync(join(f1, 'architecture.html'), 'utf8');
    const treeF1 = readFileSync(join(f1, '.loupe', 'tree.json'), 'utf8');
    check(r.code === 0 && !htmlF1.includes('SLACKWEBHOOKSECRET') && !htmlF1.includes('STRIPESECRET') && !treeF1.includes('SLACKWEBHOOKSECRET') && !treeF1.includes('STRIPESECRET'), 'evidence redaction e2e: secrets redacted from evidence in tree.json and architecture.html', treeF1.slice(0, 1500));
  }

  // ---------- tracked .loupe/ cache is warned and ignored ----------
  {
    const f4 = fixture('f4-tracked-cache');
    // first map once to discover exact cache filenames, then tamper + commit .loupe/cache/
    r = await run(['map', f4, '--no-open', '--backend', 'openai'], stEnv);
    check(r.code === 0, 'tracked cache: setup run', r.all);
    const cacheDir = join(f4, '.loupe', 'cache');
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(cacheDir)) {
      if (f.startsWith('system-')) writeFileSync(join(cacheDir, f), JSON.stringify({ label: 'POISONED SYSTEM', shortDescription: 'Poisoned.', longDescription: 'Poisoned.' }));
    }
    rmSync(join(f4, '.loupe', '.gitignore'));
    execFileSync(gitBin, ['add', '-f', '.loupe/cache'], { cwd: f4, stdio: 'pipe' });
    execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'track cache'], { cwd: f4, stdio: 'pipe' });
    const cBefore = seen.count;
    r = await run(['map', f4, '--no-open', '--backend', 'openai'], stEnv);
    const treeF4 = readFileSync(join(f4, '.loupe', 'tree.json'), 'utf8');
    check(r.code === 0 && /tracked by git/i.test(r.err) && seen.count > cBefore && !treeF4.includes('POISONED SYSTEM'), 'tracked cache: tracked .loupe/ warns and ignores pre-seeded cache', r.all);
  }

  // ---------- secret-file deny-list + LOUPE_IGNORE in relations.mjs ----------
  {
    const f6 = fixture('f6-secret-files');
    writeFileSync(join(f6, '.env.js'), 'export const SECRET = "top-secret";\n');
    writeFileSync(join(f6, 'src', 'secrets.ts'), 'export const KEY = "secret-key";\n');
    writeFileSync(join(f6, 'src', 'credentials.js'), 'export const PASS = "cred-pass";\n');
    writeFileSync(join(f6, 'src', 'private_key.py'), 'KEY = "priv"\n');
    writeFileSync(join(f6, 'cert.pem'), '-----BEGIN PRIVATE KEY-----\n');
    execFileSync(gitBin, ['add', '-A'], { cwd: f6, stdio: 'pipe' });
    execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'secret files'], { cwd: f6, stdio: 'pipe' });
    r = await run(['map', f6, '--no-open', '--backend', 'openai'], stEnv);
    const treeF6 = readFileSync(join(f6, '.loupe', 'tree.json'), 'utf8');
    const filesF6 = readFileSync(join(f6, '.loupe', 'tree.files.json'), 'utf8');
    const blocked = ['.env.js', 'secrets.ts', 'credentials.js', 'private_key.py', 'cert.pem'];
    check(r.code === 0 && blocked.every((b) => !treeF6.includes(b) && !filesF6.includes(b)), 'secret files: secret-looking files excluded from scan', filesF6);
    // LOUPE_IGNORE in relations.mjs: ignoring src/client.js removes the HTTP relation from client.js
    const relTree = join(f6, '.loupe', 'tree.json');
    r = await run(['relations', f6, relTree, '--backend', 'openai'], { ...stEnv, LOUPE_IGNORE: '^src/client\\.js$', LOUPE_NOLLM: '1' });
    const afterIgn = JSON.parse(readFileSync(relTree, 'utf8'));
    check(r.code === 0 && !afterIgn.root.relations.some((x) => x.kind === 'http'), 'secret files: LOUPE_IGNORE works in relations.mjs', JSON.stringify(afterIgn.root.relations));
  }

  // ---------- every file used in a prompt follows the source inclusion rules; symlinks are never read ----------
  {
    const f12 = fixture('f12-inclusion');
    const commitAll = (msg) => { execFileSync(gitBin, ['add', '-A'], { cwd: f12, stdio: 'pipe' }); execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg], { cwd: f12, stdio: 'pipe' }); };
    writeFileSync(join(f12, '.gitignore'), 'CONTEXT.md\n.env.local\nsrc/ignored-but-tracked.js\n');
    writeFileSync(join(f12, 'ARCHITECTURE.md'), '# EXCLUDED-NOTE-3\n');
    writeFileSync(join(f12, '.env.local'), 'export const TOKEN = "ENV-SECRET-4";\n');
    symlinkSync('../.env.local', join(f12, 'src', 'config.js'));
    writeFileSync(join(f12, 'src', 'keys.js'), 'export const ANTHROPIC = "sk-ant-abcdefghijklmnopqrstuv";\n');
    commitAll('inclusion');
    writeFileSync(join(f12, 'src', 'ignored-but-tracked.js'), 'export const NOTE = "TRACKED-IGNORED-5";\n');
    execFileSync(gitBin, ['add', '-f', 'src/ignored-but-tracked.js'], { cwd: f12, stdio: 'pipe' });
    execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'force-add'], { cwd: f12, stdio: 'pipe' });
    writeFileSync(join(f12, 'README.md'), '# UNTRACKED-NOTE-1\n'); // untracked
    writeFileSync(join(f12, 'CONTEXT.md'), '# IGNORED-NOTE-2\n'); // ignored
    check(execFileSync(gitBin, ['ls-files', '-s', 'src/config.js'], { cwd: f12, encoding: 'utf8' }).startsWith('120000'), 'inclusion: src/config.js is a tracked symlink');
    const p0 = seen.prompts.length;
    r = await run(['map', f12, '--no-open', '--backend', 'openai'], { ...stEnv, LOUPE_IGNORE: '^ARCHITECTURE\\.md$' });
    const sent = seen.prompts.slice(p0).join('\n');
    const files12 = existsSync(join(f12, '.loupe', 'tree.files.json')) ? readFileSync(join(f12, '.loupe', 'tree.files.json'), 'utf8') : '';
    check(r.code === 0 && sent.length > 0, 'inclusion: map runs', r.all);
    for (const [needle, what] of [['UNTRACKED-NOTE-1', 'untracked README'], ['IGNORED-NOTE-2', 'gitignored CONTEXT.md'], ['EXCLUDED-NOTE-3', 'LOUPE_IGNOREd ARCHITECTURE.md'], ['ENV-SECRET-4', 'tracked symlink to an ignored .env.local'], ['TRACKED-IGNORED-5', 'tracked file matching .gitignore'], ['sk-ant-abcdefghijklmnopqrstuv', 'token-shaped secret in tracked source']]) {
      check(!sent.includes(needle), `inclusion: ${what} never reaches a prompt`);
    }
    check(!files12.includes('src/config.js'), 'inclusion: symlinked source left out of the map', files12);
    // relations reads only tracked files, whatever the sidecar lists
    writeFileSync(join(f12, 'src', 'extra.js'), `export async function sneak() {\n  return fetch('/api/items');\n}\n`);
    const side = JSON.parse(files12); side['src/extra.js'] = Object.values(side)[0];
    writeFileSync(join(f12, '.loupe', 'tree.files.json'), JSON.stringify(side));
    r = await run(['relations', f12, join(f12, '.loupe', 'tree.json'), '--backend', 'openai'], { ...stEnv, LOUPE_NOLLM: '1' });
    const relText = readFileSync(join(f12, '.loupe', 'tree.json'), 'utf8');
    check(r.code === 0 && !relText.includes('src/extra.js'), 'inclusion: relations ignores untracked files listed in the sidecar', r.all);
    r = await run(['map', f12, '--no-open', '--backend', 'openai'], { ...stEnv, LOUPE_IGNORE: '(' });
    check(r.code === 2 && /invalid LOUPE_IGNORE/.test(r.err), 'inclusion: invalid LOUPE_IGNORE is a friendly error', r.all);
  }

  // ---------- review regressions: .gitattributes re-include, LOUPE_IGNORE vs config files, relations without git ----------
  {
    const f14 = fixture('f14-reinclude');
    const c14 = (msg) => execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg], { cwd: f14, stdio: 'pipe' });
    writeFileSync(join(f14, '.gitignore'), 'src/sdk.js\nsrc/plain-ignored.js\n');
    writeFileSync(join(f14, '.gitattributes'), 'src/sdk.js linguist-generated=false\n');
    writeFileSync(join(f14, 'src', 'sdk.js'), 'export function sdkCall() {\n  return 1;\n}\n');
    writeFileSync(join(f14, 'src', 'plain-ignored.js'), 'export function hidden() {\n  return 2;\n}\n');
    execFileSync(gitBin, ['add', '-A', '-f'], { cwd: f14, stdio: 'pipe' }); c14('re-include');
    r = await run(['map', f14, '--no-open', '--backend', 'openai'], { ...stEnv, LOUPE_IGNORE: '\\.(json|ya?ml)$' });
    const files14 = existsSync(join(f14, '.loupe', 'tree.files.json')) ? JSON.parse(readFileSync(join(f14, '.loupe', 'tree.files.json'), 'utf8')) : {};
    const tree14 = existsSync(join(f14, '.loupe', 'tree.json')) ? JSON.parse(readFileSync(join(f14, '.loupe', 'tree.json'), 'utf8')) : null;
    check(r.code === 0 && Object.hasOwn(files14, 'src/sdk.js') && !Object.hasOwn(files14, 'src/plain-ignored.js'), 'review: gitignored file re-included by .gitattributes is mapped, a plain ignored one is not', JSON.stringify(files14) + r.all);
    check(tree14?.root?.children?.[0]?.packageName === 'fixture-app', 'review: LOUPE_IGNORE matching *.json still reads package.json for the layout', JSON.stringify(tree14?.root?.children?.map((c) => c.packageName)));

    const noGit = join(TMP, 'f14-nogit'); mkdirSync(join(noGit, 'src'), { recursive: true });
    writeFileSync(join(noGit, 'src', 'util.js'), 'export const x = 1;\n');
    writeFileSync(join(noGit, 't.tree.json'), JSON.stringify({ meta: {}, root: { id: 'system', label: 'S', children: [], edges: [] } }));
    writeFileSync(join(noGit, 't.tree.files.json'), '{}');
    r = await run(['relations', noGit, join(noGit, 't.tree.json'), '--backend', 'openai'], { ...stEnv, LOUPE_NOLLM: '1', GIT_CEILING_DIRECTORIES: TMP });
    check(r.code === 2 && /not inside a git repository/.test(r.err) && !/at .*node:/.test(r.err), 'review: relations outside a git repo is a friendly error, not a stack trace', r.all);
  }

  // ---------- API base URLs must be https (or loopback http) ----------
  {
    const f13 = fixture('f13-base-url');
    for (const [env, val] of [['OPENAI_BASE_URL', 'http://api.example.com/v1'], ['OPENAI_BASE_URL', 'https://user:pw@api.example.com/v1'], ['OPENAI_BASE_URL', 'not a url']]) {
      const cBefore = seen.count;
      r = await run(['map', f13, '--no-open', '--backend', 'openai'], { ...stEnv, [env]: val });
      check(r.code === 2 && r.err.includes(env) && seen.count === cBefore && !r.all.includes(KEY), `base url: ${env}=${val} refused before any request`, r.all);
    }
    r = await run(['map', f13, '--no-open', '--backend', 'anthropic'], { ...stEnv, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://10.0.0.5:8080' });
    check(r.code === 2 && r.err.includes('ANTHROPIC_BASE_URL'), 'base url: plain http to a non-loopback host refused', r.all);
    check(r.err.includes('LOUPE_ALLOW_HTTP'), 'base url: the refusal names the opt-in', r.err);
    // the opt-in, checked directly so the test never opens a connection
    const tryUrl = (v) => { try { return checkBaseUrl('OPENAI_BASE_URL', v); } catch (e) { return e.message; } };
    process.env.LOUPE_ALLOW_HTTP = '1';
    const allowed = tryUrl('http://192.0.2.1:9/v1/'), stillBad = tryUrl('ftp://192.0.2.1/v1');
    delete process.env.LOUPE_ALLOW_HTTP;
    check(allowed === 'http://192.0.2.1:9/v1' && /https/.test(stillBad) && /plain http/.test(tryUrl('http://192.0.2.1:9/v1')) && tryUrl('http://localhost:1234/v1') === 'http://localhost:1234/v1', 'base url: LOUPE_ALLOW_HTTP=1 allows plain http, and only http', `${allowed} | ${stillBad}`);
  }

  // ---------- LOUPE_EFFORT allow-list ----------
  {
    const f7 = fixture('f7-effort');
    for (const badEffort of ['--dangerously-skip-permissions', 'ultra', 'low high']) {
      const cBefore = seen.count;
      r = await run(['map', f7, '--no-open', '--backend', 'openai'], { ...stEnv, LOUPE_EFFORT: badEffort });
      check(r.code === 2 && /LOUPE_EFFORT/.test(r.err) && seen.count === cBefore, `LOUPE_EFFORT: rejects invalid LOUPE_EFFORT=${badEffort}`, r.all);
    }
    const nEff = claudeCalls().length;
    r = await run(['map', f7, '--no-open'], clEnv({ LOUPE_EFFORT: 'low' }));
    const effCalls = claudeCalls().slice(nEff);
    check(r.code === 0 && effCalls.length > 0 && effCalls.every((c) => c.argv.includes('--effort') && c.argv[c.argv.indexOf('--effort') + 1] === 'low'), 'LOUPE_EFFORT: valid LOUPE_EFFORT=low passes --effort low', JSON.stringify(effCalls[0]));
  }

  // ---------- repoSource strips up to the last @ before the host ----------
  {
    const f11 = fixture('f11-remote');
    execFileSync(gitBin, ['remote', 'add', 'origin', 'https://user:p@ss@example.com/org/my-repo.git'], { cwd: f11, stdio: 'pipe' });
    r = await run(['map', f11, '--no-open', '--backend', 'openai'], stEnv);
    const meta11 = JSON.parse(readFileSync(join(f11, '.loupe', 'tree.json'), 'utf8')).meta;
    check(r.code === 0 && meta11.source === 'example.com/org/my-repo', 'repoSource: repoSource strips password containing @', JSON.stringify(meta11));
  }

  // ---------- no supported source files preflight + multi-language support ----------
  {
    const emptyRepo = join(TMP, 'no-source'); mkdirSync(emptyRepo);
    writeFileSync(join(emptyRepo, 'README.md'), '# Docs only\n');
    const g = (...a) => execFileSync(gitBin, a, { cwd: emptyRepo, stdio: 'pipe' });
    g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    const cBefore = seen.count;
    r = await run(['map', emptyRepo, '--no-open', '--backend', 'openai'], stEnv);
    check(r.code === 2 && /no supported source files/i.test(r.err) && !/scanning failed/.test(r.err) && seen.count === cBefore, 'languages: repo with no source files exits 2 without duplicate scanning-failed line', r.all);

    // Multi-language (Python + Go + Rust + C/C++ + Objective-C, no package.json)
    const poly = join(TMP, 'polyglot-app'); mkdirSync(join(poly, 'src'), { recursive: true });
    writeFileSync(join(poly, 'src', 'signer.py'), 'class Signer:\n    pass\n\ndef sign_bytes(data):\n    return data\n');
    writeFileSync(join(poly, 'src', 'server.go'), 'package main\n\ntype Config struct{}\n\nfunc StartServer() {}\n');
    writeFileSync(join(poly, 'src', 'lib.rs'), 'pub struct Token;\npub fn verify() -> bool { true }\n');
    for (const ext of ['cc', 'cxx', 'hh', 'hxx', 'c++', 'h++', 'm', 'mm']) {
      writeFileSync(join(poly, 'src', `native.${ext}`), `int fn_${ext.replace(/\+/g, 'p')}(void) { return 0; }\n`);
    }
    const gp = (...a) => execFileSync(gitBin, a, { cwd: poly, stdio: 'pipe' });
    gp('init', '-q'); gp('add', '-A'); gp('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    r = await run(['map', poly, '--no-open', '--backend', 'openai'], stEnv);
    const polyTree = existsSync(join(poly, '.loupe', 'tree.json')) ? JSON.parse(readFileSync(join(poly, '.loupe', 'tree.json'), 'utf8')) : null;
    const polyFiles = existsSync(join(poly, '.loupe', 'tree.files.json')) ? JSON.parse(readFileSync(join(poly, '.loupe', 'tree.files.json'), 'utf8')) : {};
    const polyText = JSON.stringify(polyTree);
    const cppObjcOk = ['cc', 'cxx', 'hh', 'hxx', 'c++', 'h++', 'm', 'mm'].every((ext) => Object.hasOwn(polyFiles, `src/native.${ext}`));
    check(r.code === 0 && polyTree?.root?.children?.[0]?.packageName === 'polyglot-app' && polyText.includes('class Signer') && polyText.includes('StartServer()') && polyText.includes('struct Token') && cppObjcOk, 'languages: multi-language repo maps Python/Go/Rust/C++/Objective-C + extracts exports', polyText.slice(0, 1500));
  }

  // ---------- Python + Go import relations ----------
  {
    const pg = join(TMP, 'py-go-imports');
    const write = (rel, content) => { const full = join(pg, rel); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); };
    write('src/shop/__init__.py', '');
    write('src/shop/models.py', 'class User:\n    pass\n');
    write('src/shop/db.py', 'def connect():\n    return 1\n');
    write('src/shop/json.py', 'def dumps(x):\n    return str(x)\n'); // shadows the stdlib name: `import json` must not resolve here
    write('src/shop/typehints.py', 'Hint = int\n');
    write('src/shop/service.py', [
      '"""Service.', '', 'Example:', '    from shop.typehints import Hint', '"""', 'import json',
      'from typing import TYPE_CHECKING', 'from .models import (', '    User,', ')', 'from shop import db',
      'if TYPE_CHECKING:', '    from shop.typehints import Hint', '', '', 'def run():', '    return json.dumps(db.connect()), User()', '',
    ].join('\n'));
    write('go.mod', 'module example.com/svc\n\ngo 1.22\n');
    write('main.go', 'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/svc/store"\n)\n\nfunc main() {\n\tfmt.Println(store.Open())\n\trun()\n}\n');
    write('run.go', 'package main\n\nfunc run() {}\n');
    write('store/store.go', 'package store\n\nfunc Open() int { return 1 }\n');
    write('store/other.go', 'package store\n\nfunc Other() {}\n');
    const g = (...a) => execFileSync(gitBin, a, { cwd: pg, stdio: 'pipe' });
    g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    r = await run(['map', pg, '--no-open', '--backend', 'openai'], stEnv);
    const t = existsSync(join(pg, '.loupe', 'tree.json')) ? JSON.parse(readFileSync(join(pg, '.loupe', 'tree.json'), 'utf8')) : { root: {} };
    const fm = existsSync(join(pg, '.loupe', 'tree.files.json')) ? JSON.parse(readFileSync(join(pg, '.loupe', 'tree.files.json'), 'utf8')) : {};
    const rels = t.root.relations || [];
    const edge = (a, b) => rels.find((x) => x.kind === 'import' && x.from === fm[a] && x.to === fm[b]);
    const dump = JSON.stringify(rels.map((x) => [x.from, x.to, x.label]));
    check(r.code === 0 && /uses User/.test(edge('src/shop/service.py', 'src/shop/models.py')?.label || '') && edge('src/shop/service.py', 'src/shop/db.py'), 'python imports: relative and absolute (src layout, parenthesised) imports resolve', dump);
    check(!edge('src/shop/service.py', 'src/shop/json.py') && !edge('src/shop/service.py', 'src/shop/typehints.py'), 'python imports: stdlib names, docstrings and TYPE_CHECKING blocks are skipped', dump);
    check(/uses Open/.test(edge('main.go', 'store/store.go')?.label || '') && !edge('main.go', 'store/other.go'), 'go imports: module import resolves to the file declaring the used symbol', dump);
    check(/uses run/.test(edge('main.go', 'run.go')?.label || ''), 'go imports: same-package references between files', dump);
  }

  // ---------- Java + PHP + Rust import relations ----------
  {
    const jr = join(TMP, 'java-php-rust-imports');
    const write = (rel, content) => { const full = join(jr, rel); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); };
    const J = 'src/main/java/com/acme';
    write(`${J}/model/User.java`, 'package com.acme.model;\n\npublic class User {}\n');
    write(`${J}/repo/UserRepo.java`, 'package com.acme.repo;\n\npublic interface UserRepo {}\n');
    write(`${J}/repo/Unused.java`, 'package com.acme.repo;\n\npublic class Unused {}\n');
    write(`${J}/web/Helper.java`, 'package com.acme.web;\n\nclass Helper {}\n');
    write(`${J}/web/UserController.java`, 'package com.acme.web;\n\nimport com.acme.model.User;\nimport com.acme.repo.*;\n\n/**\n * Unused is mentioned only in this comment.\n */\npublic class UserController {\n  private UserRepo repo;\n  private Helper helper;\n  private User user;\n}\n');
    write('php/Http/Route.php', '<?php\nnamespace App\\Http;\n\nfinal class Route {}\n');
    write('php/Http/Router.php', '<?php\nnamespace App\\Http;\n\nclass Router\n{\n    public function add(): Route { return new Route(); }\n}\n');
    write('php/Support/Str.php', '<?php\nnamespace App\\Support;\n\nclass Str {}\n');
    write('php/Support/Arr.php', '<?php\nnamespace App\\Support;\n\nclass Arr {}\n');
    write('php/App.php', '<?php\nnamespace App;\n\nuse App\\Http\\Router;\nuse App\\Support\\{Str, Arr as A};\n\nclass App\n{\n    public function run(): Router { return new Router(); }\n}\n');
    write('crates/core/Cargo.toml', '[package]\nauthors = ["t"]\nname = "core-lib"\nversion = "0.1.0"\n');
    write('crates/core/src/lib.rs', 'pub mod parser;\npub mod util;\n\npub use parser::Parser;\n');
    write('crates/core/src/parser.rs', "use crate::util::{trim, Pad as P};\n\npub struct Parser;\n\npub fn parse<'a>(s: &'a str) -> &'a str { let _p = P; super::util::trim(s) }\n");
    write('crates/core/src/util.rs', 'pub fn trim(s: &str) -> &str { s }\npub struct Pad;\n');
    write('crates/core/src/bin/tool.rs', 'use core_lib::Parser;\n\nfn main() { let _ = Parser; }\n');
    const g = (...a) => execFileSync(gitBin, a, { cwd: jr, stdio: 'pipe' });
    g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    r = await run(['map', jr, '--no-open', '--backend', 'openai'], stEnv);
    const t = existsSync(join(jr, '.loupe', 'tree.json')) ? JSON.parse(readFileSync(join(jr, '.loupe', 'tree.json'), 'utf8')) : { root: {} };
    const fm = existsSync(join(jr, '.loupe', 'tree.files.json')) ? JSON.parse(readFileSync(join(jr, '.loupe', 'tree.files.json'), 'utf8')) : {};
    const rels = t.root.relations || [];
    const edge = (a, b) => rels.find((x) => x.kind === 'import' && x.from === fm[a] && x.to === fm[b]);
    const dump = JSON.stringify(rels.map((x) => [x.from, x.to, x.label]));
    const ctl = `${J}/web/UserController.java`;
    // small files can share a `more:` node, so check each relation's detail labels rather than its target
    const uses = (from, sym) => rels.some((x) => x.kind === 'import' && x.from === fm[from] && (x.details || []).some((d) => new RegExp(`\\b${sym}\\b`).test(d)));
    check(r.code === 0 && uses(ctl, 'User') && uses(ctl, 'UserRepo') && !rels.some((x) => (x.details || []).some((d) => /Unused/.test(d))), 'java imports: single-type and wildcard imports resolve to used types only', dump);
    check(uses(ctl, 'Helper'), 'java imports: same-package types used without an import', dump);
    check(edge('php/App.php', 'php/Http/Router.php') && edge('php/App.php', 'php/Support/Str.php') && /uses Arr/.test(edge('php/App.php', 'php/Support/Arr.php')?.label || ''), 'php imports: use and group use (with alias) resolve by namespace', dump);
    check(/uses Route/.test(edge('php/Http/Router.php', 'php/Http/Route.php')?.label || ''), 'php imports: same-namespace classes used without use', dump);
    check(/uses trim, Pad/.test(edge('crates/core/src/parser.rs', 'crates/core/src/util.rs')?.label || '') && /uses Parser/.test(edge('crates/core/src/lib.rs', 'crates/core/src/parser.rs')?.label || ''), 'rust imports: crate:: use trees and self-relative re-exports resolve to module files', dump);
    check(/uses Parser/.test(edge('crates/core/src/bin/tool.rs', 'crates/core/src/lib.rs')?.label || ''), 'rust imports: a bin target reaches the library through its crate name (dashes as underscores)', dump);
  }

  // ---------- skip vendored, build, generated, gitignored, .gitattributes & minified files (with re-include) ----------
  {
    const vend = join(TMP, 'vendored-repo');
    const write = (rel, content) => {
      const full = join(vend, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // Real source files that must be mapped (including nested build/out/target/coverage/vendors)
    write('cmd/main.go', 'package main\nfunc Main() {}\n');
    write('internal/app/app.go', 'package app\nfunc Run() {}\n');
    write('other/gen/handwritten.go', 'package gen\nfunc Handwritten() {}\n'); // gen/ without *.pb.* is kept
    write('src/build/index.ts', 'export const buildIndex = 1;\n');
    write('lib/out/writer.js', 'export const writeOut = () => {};\n');
    write('src/target/aim.ts', 'export const aim = 1;\n');
    write('src/coverage/plan.ts', 'export const plan = 1;\n');
    write('src/vendors/list.ts', 'export const vendorList = [];\n');
    // Default excluded directories
    write('vendor/github.com/foo/bar/f1.go', 'package bar\nfunc F1() {}\n');
    write('src/vendor/dep.js', 'export const sv = 1;\n'); // vendor/ still skipped at any depth
    write('vendors/lib/v.js', 'export const v = 1;\n');
    write('third_party/lib/f1.c', 'int f1(void){return 0;}\n');
    write('third-party/lib/f2.h', 'int f2(void);\n');
    write('Pods/AFNetworking/f1.swift', 'func pod() {}\n');
    write('Carthage/Checkouts/x.swift', 'func carthage() {}\n');
    write('bower_components/pkg/a.js', 'export const a = 1;\n');
    write('node_modules/pkg/index.js', 'export const n = 1;\n');
    write('build/app.js', 'export const bRoot = 1;\n');
    write('build/gen/x1_pb2.py', 'def x(): pass\n');
    write('out/app.js', 'export const o = 1;\n');
    write('target/debug/x1.rs', 'pub fn x() {}\n');
    write('dist/index.js', 'export const d = 1;\n');
    write('src/dist/nested.js', 'export const dn = 1;\n'); // dist/ still skipped at any depth
    write('.next/server.js', 'export const nx = 1;\n');
    write('.nuxt/app.js', 'export const nu = 1;\n');
    write('.svelte-kit/out.js', 'export const sk = 1;\n');
    write('coverage/report.js', 'export const cv = 1;\n');
    write('generated/types.ts', 'export type T = string;\n');
    write('__generated__/gql.ts', 'export const q = 1;\n');
    write('gen/proto/x1.pb.go', 'package proto\nfunc X1() {}\n');
    write('gen/proto/helper.go', 'package proto\nfunc Helper() {}\n'); // inside gen/ holding *.pb.*
    write('test-d/types.ts', 'export const t = 1;\n');
    // Default excluded files
    write('public/js/app.min.js', 'export const m = 1;\n');
    write('public/js/app.bundle.js', 'export const b = 1;\n');
    write('api/svc.pb.go', 'package api\nfunc S() {}\n');
    write('api/svc.pb.gw.go', 'package api\nfunc G() {}\n');
    write('py/msg_pb2.py', 'def m(): pass\n');
    write('py/msg_pb2_grpc.py', 'def g(): pass\n');
    write('src/schema.generated.ts', 'export const s = 1;\n');
    write('src/Form.designer.cs', 'class Form {}\n');
    write('docs/conf.py', 'project = "x"\n');
    // Minified files (not matching *.min.js)
    write('src/avg_long.js', 'var a=function(b){return b+1};'.repeat(30) + '\n'); // > 500 avg line len
    write('src/huge_line.js', 'const a = 1;\n'.repeat(20) + 'const big = "' + 'x'.repeat(5100) + '";\n'); // > 5000 single line
    // Force-added .gitignored file
    write('.gitignore', 'ignored_dir/\n');
    write('ignored_dir/tracked_ignored.js', 'export const ign = 1;\n');
    // .gitattributes exclusions and re-includes
    write('src/attr_gen.ts', 'export const ag = 1;\n');
    write('src/attr_vend.ts', 'export const av = 1;\n');
    write('src/attr_nodiff.ts', 'export const an = 1;\n');
    write('src/attr_bin.ts', 'export const ab = 1;\n');
    write('vendor/keep_me.go', 'package keep\nfunc Keep() {}\n');
    write('build/keep_build.js', 'export const keptBuild = 1;\n');
    write('src/keep_me.generated.ts', 'export const keptGen = 1;\n');
    write('src/keep_minified.js', 'var k=function(x){return x+1};'.repeat(30) + '\n');
    write('.gitattributes', [
      'src/attr_gen.ts linguist-generated=true',
      'src/attr_vend.ts linguist-vendored',
      'src/attr_nodiff.ts -diff',
      'src/attr_bin.ts binary',
      'vendor/keep_me.go linguist-vendored=false',
      'build/keep_build.js linguist-generated=false',
      'src/keep_me.generated.ts linguist-generated=false',
      'src/keep_minified.js linguist-generated=false',
    ].join('\n') + '\n');

    const gv = (...a) => execFileSync(gitBin, a, { cwd: vend, stdio: 'pipe' });
    gv('init', '-q');
    gv('add', '-A');
    gv('add', '-f', 'ignored_dir/tracked_ignored.js');
    gv('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');

    r = await run(['map', vend, '--no-open', '--backend', 'openai'], stEnv);
    const vendFiles = existsSync(join(vend, '.loupe', 'tree.files.json')) ? Object.keys(JSON.parse(readFileSync(join(vend, '.loupe', 'tree.files.json'), 'utf8'))).sort() : [];
    const expectedKept = [
      'build/keep_build.js',
      'cmd/main.go',
      'internal/app/app.go',
      'lib/out/writer.js',
      'other/gen/handwritten.go',
      'src/build/index.ts',
      'src/coverage/plan.ts',
      'src/keep_me.generated.ts',
      'src/keep_minified.js',
      'src/target/aim.ts',
      'src/vendors/list.ts',
      'vendor/keep_me.go',
    ];
    check(r.code === 0 && JSON.stringify(vendFiles) === JSON.stringify(expectedKept), 'scan quality: excludes vendored/build/generated/ignored/minified/gitattributes files and honours re-include', JSON.stringify({ vendFiles, expectedKept }) + '\n' + r.all);
    check(/skipped \d+ vendored\/generated files \(see \.gitattributes to include\)/.test(r.err), 'scan quality: logs skipped vendored/generated count without --verbose', r.err);

    // Workspace monorepo: output dirs anchored to package roots (keep packages/x/src/build/foo.ts, skip packages/x/build/)
    const ws = join(TMP, 'ws-anchored-repo');
    const writeWs = (rel, content) => {
      const full = join(ws, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    writeWs('package.json', JSON.stringify({ name: 'ws-anchored', private: true, workspaces: ['packages/*', 'packages/angular/build'] }));
    writeWs('packages/x/package.json', JSON.stringify({ name: '@ws/x', version: '1.0.0', type: 'module' }));
    writeWs('packages/x/src/index.ts', `import { runBuild } from './build/foo';\nexport const out = runBuild();\n`);
    writeWs('packages/x/src/build/foo.ts', `export function runBuild() {\n  return fetch('https://hooks.slack.com/services/T0/B0/XYZ');\n}\n`);
    writeWs('packages/x/build/compiled.js', `export function leaked() { return fetch('https://api.github.com/repos/org/app'); }\n`);
    writeWs('packages/x/build/keep_me.js', `export const keptPkgBuild = 1;\n`);
    writeWs('packages/x/out/app.js', `export const o = 1;\n`);
    writeWs('packages/x/target/debug.rs', `pub fn d() {}\n`);
    writeWs('packages/x/coverage/lcov.js', `export const cv = 1;\n`);
    writeWs('packages/x/vendors/dep.js', `export const v = 1;\n`);
    writeWs('packages/angular/build/package.json', JSON.stringify({ name: '@angular/build', version: '1.0.0', type: 'module' }));
    writeWs('packages/angular/build/src/index.ts', `export const ngBuild = 1;\n`);
    writeWs('packages/angular/build/build/out.js', `export const ngOut = 1;\n`);
    writeWs('.gitattributes', 'packages/x/build/keep_me.js linguist-generated=false\n');
    const gws = (...a) => execFileSync(gitBin, a, { cwd: ws, stdio: 'pipe' });
    gws('init', '-q');
    gws('add', '-A');
    gws('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');

    r = await run(['map', ws, '--no-open', '--backend', 'openai'], stEnv);
    const wsFilesPath = join(ws, '.loupe', 'tree.files.json');
    const wsTreePath = join(ws, '.loupe', 'tree.json');
    const wsFiles = existsSync(wsFilesPath) ? Object.keys(JSON.parse(readFileSync(wsFilesPath, 'utf8'))).sort() : [];
    const expectedWsKept = [
      'packages/angular/build/src/index.ts',
      'packages/x/build/keep_me.js',
      'packages/x/src/build/foo.ts',
      'packages/x/src/index.ts',
    ];
    check(r.code === 0 && JSON.stringify(wsFiles) === JSON.stringify(expectedWsKept), 'scan quality (workspace): keeps packages/x/src/build/foo.ts and packages/angular/build/src/, skips packages/x/build/ unless re-included', JSON.stringify({ wsFiles, expectedWsKept }) + '\n' + r.all);

    // relations.mjs agrees with generate.mjs on workspace-anchored output dirs
    const wsMap = JSON.parse(readFileSync(wsFilesPath, 'utf8'));
    wsMap['packages/x/build/compiled.js'] = wsMap['packages/x/src/index.ts'];
    writeFileSync(wsFilesPath, JSON.stringify(wsMap, null, 1));
    r = await run(['relations', ws, wsTreePath, '--backend', 'openai'], { ...stEnv, LOUPE_NOLLM: '1' });
    const wsRels = existsSync(wsTreePath) ? JSON.parse(readFileSync(wsTreePath, 'utf8')).root.relations : [];
    const wsHasSlack = wsRels.some((x) => x.kind === 'external' && x.to === 'ext:slack');
    const wsHasGithub = wsRels.some((x) => x.to === 'ext:github');
    check(r.code === 0 && wsHasSlack && !wsHasGithub, 'scan quality (workspace): relations.mjs keeps packages/x/src/build/foo.ts and skips packages/x/build/', JSON.stringify(wsRels) + '\n' + r.all);
  }

  // ---------- import aliases: tsconfig "paths" (JSONC + extends), "baseUrl", SvelteKit $lib ----------
  {
    const al = join(TMP, 'aliases');
    const writeAl = (rel, content) => { const full = join(al, rel); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); };
    writeAl('package.json', JSON.stringify({ name: 'alias-mono', private: true, workspaces: ['server', 'web', 'app'] }));
    writeAl('server/package.json', JSON.stringify({ name: 'srv', version: '1.0.0' }));
    writeAl('server/tsconfig.base.json', JSON.stringify({ compilerOptions: { strict: true } }));
    writeAl('server/tsconfig.json', `{\n  // NestJS-style absolute imports\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": {\n    "paths": { "src/*": ["./src/*"], /* tests */ "test/*": ["./test/*"] },\n  },\n}\n`);
    writeAl('server/src/services/user.service.ts', `import { Injectable } from '@nestjs/common';\nimport { findUser } from 'src/repositories/user.repository.js';\n\nexport const getUser = () => findUser();\nexport const di = Injectable;\n`);
    writeAl('server/src/repositories/user.repository.ts', `export function findUser() {\n  return { id: 1 };\n}\n`);
    writeAl('web/package.json', JSON.stringify({ name: 'web', version: '1.0.0' }));
    writeAl('web/src/lib/api.ts', `export const api = { list: () => [] };\n`);
    writeAl('web/src/routes/photos.ts', `import { api } from '$lib/api';\n\nexport const photos = api.list();\n`);
    writeAl('app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    writeAl('app/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    writeAl('app/src/feature/view.ts', `import { format } from 'shared/format';\n\nexport const view = format('x');\n`);
    writeAl('app/src/shared/format.ts', `export function format(s: string) {\n  return s.trim();\n}\n`);
    const gal = (...a) => execFileSync(gitBin, a, { cwd: al, stdio: 'pipe' });
    gal('init', '-q'); gal('add', '-A'); gal('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    r = await run(['map', al, '--no-open', '--backend', 'openai'], { ...stEnv, LOUPE_NOLLM: '1' });
    // three aliased imports resolve (src/*, $lib, baseUrl); the npm import (@nestjs/common) does not
    const nImp = Number((r.all.match(/\[rel\] imports (\d+)/) || [])[1]);
    check(r.code === 0 && nImp === 3, 'relations: tsconfig "paths" (JSONC + extends), "baseUrl" and SvelteKit $lib imports resolve', `imports=${nImp}\n` + r.all);
  }

  // ---------- JS/TS private class fields are not treated as # comments ----------
  {
    const priv = join(TMP, 'private-fields');
    mkdirSync(join(priv, 'src'), { recursive: true });
    mkdirSync(join(priv, 'prisma'), { recursive: true });
    writeFileSync(join(priv, 'package.json'), JSON.stringify({ name: 'priv', version: '1.0.0', type: 'module' }));
    writeFileSync(join(priv, 'prisma', 'schema.prisma'), 'model Invoice {\n  id Int @id\n}\n');
    writeFileSync(join(priv, 'src', 'pay.ts'), [
      `import Stripe from 'stripe';`,
      `export class Payments {`,
      `  #stripe = new Stripe(process.env.STRIPE_KEY!);`,
      `  #slack = fetch('https://hooks.slack.com/services/T0/B0/XYZ', { method: 'POST' });`,
      `  #db = new PrismaClient();`,
      `  list() { return this.#db.invoice.findMany(); }`,
      `}`,
    ].join('\n') + '\n');
    writeFileSync(join(priv, 'src', 'index.ts'), `import { Payments } from './pay';\nexport const p = new Payments();\n`);
    writeFileSync(join(priv, 'src', 'notes.py'), `# https://api.github.com/repos/org/app\ndef noop():\n    return None\n`);
    const gp = (...a) => execFileSync(gitBin, a, { cwd: priv, stdio: 'pipe' });
    gp('init', '-q'); gp('add', '-A'); gp('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    r = await run(['map', priv, '--no-open', '--backend', 'openai'], stEnv);
    const privTree = existsSync(join(priv, '.loupe', 'tree.json')) ? JSON.parse(readFileSync(join(priv, '.loupe', 'tree.json'), 'utf8')) : null;
    const rels = privTree?.root?.relations || [];
    const hasSlack = rels.some((x) => x.kind === 'external' && x.to === 'ext:slack');
    const hasDb = rels.some((x) => x.kind === 'db' && x.to === 'file:prisma/schema.prisma');
    const hasPyCommentGithub = rels.some((x) => x.to === 'ext:github');
    check(r.code === 0 && hasSlack && hasDb && !hasPyCommentGithub, 'relations: JS/TS private fields (#slack, #db) detected while # stays a comment in Python', JSON.stringify(rels));
  }
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.error(failures ? `FAIL (${failures})` : 'PASS');
process.exitCode = failures ? 1 : 0;
