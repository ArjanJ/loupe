// One-command pipeline (`loupe map`) end to end, against fake models only: a local stub HTTP server stands in
// for the Anthropic and OpenAI APIs, and a tiny node script stands in for the `claude` CLI. Never touches the network.
// Usage: node test/pipeline.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOnPath, redactSecrets } from '../src/llm.mjs';
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

  // ---------- skip vendored, build, generated, gitignored, .gitattributes & minified files (with re-include) ----------
  {
    const vend = join(TMP, 'vendored-repo');
    const write = (rel, content) => {
      const full = join(vend, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    // Real source files that must be mapped
    write('cmd/main.go', 'package main\nfunc Main() {}\n');
    write('internal/app/app.go', 'package app\nfunc Run() {}\n');
    write('other/gen/handwritten.go', 'package gen\nfunc Handwritten() {}\n'); // gen/ without *.pb.* is kept
    // Default excluded directories
    write('vendor/github.com/foo/bar/f1.go', 'package bar\nfunc F1() {}\n');
    write('vendors/lib/v.js', 'export const v = 1;\n');
    write('third_party/lib/f1.c', 'int f1(void){return 0;}\n');
    write('third-party/lib/f2.h', 'int f2(void);\n');
    write('Pods/AFNetworking/f1.swift', 'func pod() {}\n');
    write('Carthage/Checkouts/x.swift', 'func carthage() {}\n');
    write('bower_components/pkg/a.js', 'export const a = 1;\n');
    write('node_modules/pkg/index.js', 'export const n = 1;\n');
    write('build/gen/x1_pb2.py', 'def x(): pass\n');
    write('out/app.js', 'export const o = 1;\n');
    write('target/debug/x1.rs', 'pub fn x() {}\n');
    write('dist/index.js', 'export const d = 1;\n');
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
    write('src/keep_me.generated.ts', 'export const keptGen = 1;\n');
    write('src/keep_minified.js', 'var k=function(x){return x+1};'.repeat(30) + '\n');
    write('.gitattributes', [
      'src/attr_gen.ts linguist-generated=true',
      'src/attr_vend.ts linguist-vendored',
      'src/attr_nodiff.ts -diff',
      'src/attr_bin.ts binary',
      'vendor/keep_me.go linguist-vendored=false',
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
    const expectedKept = ['cmd/main.go', 'internal/app/app.go', 'other/gen/handwritten.go', 'src/keep_me.generated.ts', 'src/keep_minified.js', 'vendor/keep_me.go'];
    check(r.code === 0 && JSON.stringify(vendFiles) === JSON.stringify(expectedKept), 'scan quality: excludes vendored/build/generated/ignored/minified/gitattributes files and honours re-include', JSON.stringify({ vendFiles, expectedKept }) + '\n' + r.all);
    check(/skipped \d+ vendored\/generated files \(see \.gitattributes to include\)/.test(r.err), 'scan quality: logs skipped vendored/generated count without --verbose', r.err);
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
