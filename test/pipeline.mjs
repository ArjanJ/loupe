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
const seen = { count: 0, auth: [], badKeyRequests: 0 };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key.startsWith('sk-bad')) { seen.badKeyRequests++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `invalid x-api-key: ${key}` } })); }
    seen.count++; seen.auth.push(req.headers['x-api-key'] ? `x-api-key:${key}` : `bearer:${key}`);
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
function run(args, env) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code, out, err, all: out + err }));
  });
}
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
  check(r.code === 0 && ['map', '--out', '--no-open', '--backend', '--verbose'].every((s) => r.out.includes(s)), '--help lists map and its flags', r.all);
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
  check(r.out.includes('backend: claude'), 'claude: auto-selected over ANTHROPIC_API_KEY', r.out);
  check(seen.count === before, 'claude: no HTTP requests');
  const calls = existsSync(fakeClaudeLog) ? readFileSync(fakeClaudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check(calls.length > 0 && calls.every((c) => JSON.stringify(c.argv) === JSON.stringify(['-p', '--tools', '', '--output-format', 'text'])), 'claude: CLI called headless with tools off', JSON.stringify(calls[0]));
  // the repo could plant .claude/settings.json (hooks) or CLAUDE.md: claude must never run inside it
  check(calls.length > 0 && calls.every((c) => !c.cwd.startsWith(cl)), 'claude: runs outside the repo', JSON.stringify(calls[0]));
  const tree = JSON.parse(readFileSync(join(cl, '.loupe', 'tree.json'), 'utf8'));
  check(!JSON.stringify(tree).includes('test/spec.js'), 'top-level test/ is not mapped as source');

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
  r = await run(['render', treePath], stEnv);
  check(r.code === 0 && existsSync(join(TMP, 'steps-out', 'steps.html')), 'render subcommand', r.all);
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.error(failures ? `FAIL (${failures})` : 'PASS');
process.exitCode = failures ? 1 : 0;
