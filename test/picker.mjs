// The interactive model picker (src/picker.mjs): option detection and the key-driven UI, with injected streams.
// No terminal, no models. Usage: node test/picker.mjs
import { PassThrough } from 'node:stream';
import { detectOptions, initialIndex, pick, CHOICES } from '../src/picker.mjs';

let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { failures++; if (extra) console.log(String(extra).slice(0, 3000)); } };
const ids = (opts) => opts.map((o) => `${o.backend}:${o.model}`);

// ---------- detectOptions ----------
const onPath = (want) => (cmd) => (cmd === want ? `/usr/bin/${cmd}` : null);
const nothing = () => null;
const all = detectOptions({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, onPath('claude'));
check(JSON.stringify(ids(all)) === JSON.stringify(['claude:', 'claude:sonnet', 'claude:opus', 'claude:haiku', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5', 'openai:gpt-6.2-sol', 'openai:gpt-6-luna', 'openai:gpt-6.2-astra', 'openai:gpt-4.1']), 'all three: claude, anthropic, openai in order', ids(all));
check(all[0].label === 'Default' && all.every((o) => o.group && o.hint && o.label), 'options carry label, hint and group');
const claudeOnly = detectOptions({}, onPath('claude'));
check(claudeOnly.length === 4 && claudeOnly.every((o) => o.backend === 'claude'), 'claude only', ids(claudeOnly));
check(detectOptions({ LOUPE_CLAUDE_BIN: '/opt/cc' }, onPath('/opt/cc')).length === 4 && detectOptions({ LOUPE_CLAUDE_BIN: '/opt/cc' }, onPath('claude')).length === 0, 'claude found via LOUPE_CLAUDE_BIN');
const keys = detectOptions({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, nothing);
check(keys.length === 7 && !keys.some((o) => o.backend === 'claude'), 'keys only', ids(keys));
check(detectOptions({ OPENAI_API_KEY: 'o' }, nothing).every((o) => o.backend === 'openai'), 'openai key only');
check(detectOptions({}, nothing).length === 0, 'none');
check(Object.values(CHOICES).flatMap((c) => c.models).every((m) => m.model === '' || /^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]*$/.test(m.model)), 'every curated model id passes validation');

// ---------- initialIndex: remembered choice, else the automatic default ----------
check(ids(all)[initialIndex(all)] === 'claude:', 'default preselect: claude Default');
check(ids(keys)[initialIndex(keys)] === 'anthropic:claude-opus-5-5', 'default preselect without claude: anthropic default');
check(ids(detectOptions({ OPENAI_API_KEY: 'o' }, nothing))[initialIndex(detectOptions({ OPENAI_API_KEY: 'o' }, nothing))] === 'openai:gpt-4.1', 'default preselect openai only: gpt-4.1');
check(ids(all)[initialIndex(all, { backend: 'openai', model: 'gpt-6-luna' })] === 'openai:gpt-6-luna', 'remembered choice preselects');
for (const bad of [{ backend: 'claude', model: '--dangerously-skip-permissions' }, { backend: 'codex', model: 'x' }, { backend: 'claude' }, 'claude', null, [], { backend: 'anthropic', model: 'claude-sonnet-5-5' }])
  check(ids(claudeOnly)[initialIndex(claudeOnly, bad)] === 'claude:', `unknown/unavailable remembered choice ignored: ${JSON.stringify(bad)}`);

// ---------- pick() with injected streams ----------
function harness() {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.rawCalls = [];
  input.setRawMode = (v) => { input.isRaw = v; input.rawCalls.push(v); return input; };
  const output = { columns: 80, text: '', write(s) { this.text += s; return true; } };
  return { input, output };
}
const send = (input, ...chunks) => chunks.forEach((c, i) => setTimeout(() => input.write(c), 5 * (i + 1)));
async function drive(options, chunks, o = {}) {
  const h = harness(); const p = pick(options, { ...h, color: false, ...o });
  send(h.input, ...chunks);
  try { return { ...h, value: await p }; } catch (err) { return { ...h, err }; }
}

let r = await drive(all, ['\x1b[B', '\r']);
check(r.value?.backend === 'claude' && r.value?.model === 'sonnet', 'down + enter selects the next option', JSON.stringify(r.value));
check(r.input.rawCalls[0] === true && r.input.isRaw === false, 'raw mode on while active, restored after');
check(r.output.text.startsWith('\x1b[?25l') && r.output.text.endsWith('\x1b[?25h'), 'cursor hidden while active, shown after');
check(r.output.text.trimEnd().endsWith('✓ Model  Claude Code · Sonnet\n\x1b[?25h'.trimEnd()) && r.output.text.includes('\x1b[J'), 'collapses to a summary line', JSON.stringify(r.output.text.slice(-120)));
check(r.output.text.includes('Claude Code · your subscription') && r.output.text.includes('Anthropic API · ANTHROPIC_API_KEY') && r.output.text.includes('↑↓ move · enter select · esc cancel'), 'grouped list with headers and footer');
check(!/\x1b\[[0-9;]*m/.test(r.output.text), 'color: false writes no SGR codes');
r = await drive(claudeOnly.concat(keys), ['\x1b[A', '\r']); // up from the first row wraps to the last
check(r.value?.model === 'gpt-4.1', 'up from the top wraps to the last option', JSON.stringify(r.value));
r = await drive(all, ['j', 'j', 'j', 'j', 'k', '\r']); // j x4 crosses the Anthropic header, k comes back
check(r.value?.model === 'haiku', 'j/k move across group headers', JSON.stringify(r.value));
r = await drive(all, ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r']);
check(r.value?.backend === 'anthropic' && r.value?.model === 'claude-sonnet-5-5', 'down past a group header lands on the next model, not the header', JSON.stringify(r.value));
r = await drive(all, ['\r'], { initial: initialIndex(all, { backend: 'anthropic', model: 'claude-haiku-5-5' }) });
check(r.value?.model === 'claude-haiku-5-5', 'remembered choice: enter keeps it');
r = await drive(all, ['3', '\r']);
check(r.value?.model === 'opus', 'number keys jump to an option');
r = await drive(all, ['\x03']);
check(r.err?.code === 'CANCELLED' && r.err.key === 'ctrl-c', 'ctrl-c rejects as cancelled', String(r.err));
check(r.input.isRaw === false && r.output.text.endsWith('\x1b[?25h') && r.output.text.includes('cancelled'), 'ctrl-c restores raw mode + cursor and says cancelled');
r = await drive(all, ['\x1b']);
check(r.err?.code === 'CANCELLED' && r.err.key === 'escape' && r.input.isRaw === false, 'esc cancels');
r = await (async () => { const h = harness(); const p = pick(all, { ...h, color: false }); setTimeout(() => h.input.end(), 5); try { await p; return { ...h }; } catch (err) { return { ...h, err }; } })();
check(r.err?.code === 'CANCELLED' && r.err.key === 'eof', 'input ending cancels instead of hanging');
const one = [all[0]];
r = harness();
const single = await pick(one, { ...r, color: false });
check(single === one[0] && r.output.text === '' && r.input.rawCalls.length === 0, 'a single option is chosen without asking');
r = await drive(all, ['\x1b[B', '\r'], { color: true });
check(/\x1b\[1;36m❯ ●\x1b\[0m/.test(r.output.text), 'color: accent on the selected row');
// a narrow terminal: every row fits on one line, so the in-place redraw stays aligned
r = harness(); r.output.columns = 30;
const pNarrow = pick(all, { ...r, color: false }); send(r.input, '\r'); await pNarrow;
check(r.output.text.split(/\x1b\[\?25l|\r\x1b/)[1].split('\n').every((l) => l.length <= 30), 'rows are truncated to the terminal width', r.output.text);

// signals skip 'exit' handlers: while asking, SIGINT/SIGTERM/SIGHUP restore the terminal first; the handlers go after
{
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
  const h = harness(); const p = pick(all, { ...h, color: false });
  const during = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
  send(h.input, '\r'); await p;
  const after = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
  check(during.every((n, i) => n === before[i] + 1) && after.every((n, i) => n === before[i]), 'signal handlers installed while asking, removed after', JSON.stringify({ before, during, after }));
  // a setRawMode that throws: rejected, nothing left installed
  const bad = harness(); bad.input.setRawMode = () => { throw new Error('no tty'); };
  let err; try { await pick(all, { ...bad, color: false }); } catch (e) { err = e; }
  check(err?.message === 'no tty' && ['SIGINT', 'SIGTERM', 'SIGHUP'].every((s, i) => process.listenerCount(s) === before[i]) && process.listenerCount('exit') === 0, 'a raw-mode failure rejects and cleans up');
}
// the real thing: a child process killed with SIGTERM mid-prompt restores the cursor before dying
{
  const { spawn } = await import('node:child_process');
  const code = `import { pick } from ${JSON.stringify(new URL('../src/picker.mjs', import.meta.url).href)};
    const { PassThrough } = await import('node:stream'); const input = new PassThrough(); input.isTTY = true; input.setRawMode = (v) => process.stdout.write('[raw ' + v + ']');
    pick([{ backend: 'claude', model: '', label: 'A', hint: '' }, { backend: 'claude', model: 'x', label: 'B', hint: '' }], { input, color: false });
    setInterval(() => {}, 1e4); process.stdout.write('[ready]'); // a real TTY stdin holds the loop open; a PassThrough doesn't`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', killed = false; c.stdout.on('data', (d) => { out += d; if (!killed && out.includes('[ready]')) { killed = true; c.kill('SIGTERM'); } });
  const [, sig] = await new Promise((res) => c.on('close', (...a) => res(a)));
  check(sig === 'SIGTERM' && out.includes('[raw true]') && out.includes('[raw false]') && out.trimEnd().endsWith('\x1b[?25h'), 'SIGTERM mid-prompt: raw mode off and cursor shown, then dies by the signal', JSON.stringify({ sig, out: out.slice(-80) }));
}

console.error(failures ? `FAIL (${failures})` : 'PASS');
process.exitCode = failures ? 1 : 0;
