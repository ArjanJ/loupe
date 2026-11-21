// Loupe: the interactive model picker `loupe map` shows in a terminal when no backend or model was given.
// detectOptions() lists what is usable here, pick() asks with arrow keys (node:readline, raw mode), and the caller
// remembers the answer in <repo>/.loupe/config.json (see src/map.mjs). Nothing here runs a model.
import { emitKeypressEvents } from 'node:readline';
import { findOnPath, DEFAULT_MODEL } from './llm.mjs';

// The curated choices per backend: keep this table small and up to date. model '' = the backend's own default.
// (Follow-up: other agent CLIs, e.g. Codex, could join as backends here; not supported yet.)
export const CHOICES = {
  claude: { group: 'Claude Code · your subscription', short: 'Claude Code', models: [
    { model: '', label: 'Default', hint: "Claude Code's own default" },
    { model: 'sonnet', label: 'Sonnet', hint: 'fast, balanced' },
    { model: 'opus', label: 'Opus', hint: 'most thorough' },
    { model: 'haiku', label: 'Haiku', hint: 'fastest' },
  ] },
  anthropic: { group: 'Anthropic API · ANTHROPIC_API_KEY', short: 'Anthropic API', models: [
    { model: 'claude-sonnet-5-5', hint: '$2/$10 per MTok · fast, balanced' },
    { model: 'claude-opus-5-5', hint: '$4/$20 · thorough — current default' },
    { model: 'claude-haiku-5-5', hint: 'from $0.10/$0.50 · fastest, cheapest' },
  ] },
  openai: { group: 'OpenAI API · OPENAI_API_KEY', short: 'OpenAI API', models: [
    { model: 'gpt-6.2-sol', hint: '$2/$10 · balanced' },
    { model: 'gpt-6-luna', hint: '$0.10/$0.50 · fastest, cheapest' },
    { model: 'gpt-6.2-astra', hint: '$8/$40 · most capable, slow' },
    { model: 'gpt-4.1', hint: 'current default' },
  ] },
};

// -> [{ backend, model, label, hint, group }] for every backend usable with this env, in the automatic order.
export function detectOptions(env = process.env, find = findOnPath) {
  const have = { claude: !!find(env.LOUPE_CLAUDE_BIN || 'claude'), anthropic: !!env.ANTHROPIC_API_KEY, openai: !!env.OPENAI_API_KEY };
  return Object.entries(CHOICES).filter(([b]) => have[b])
    .flatMap(([backend, c]) => c.models.map((m) => ({ backend, model: m.model, label: m.label || m.model, hint: m.hint, group: c.group })));
}

// The row to start on: the remembered { backend, model } if it is exactly one of the options (the file is untrusted:
// it is only ever compared, never used), else what the non-interactive run would pick (first backend, its default).
export function initialIndex(options, remembered) {
  const same = (o, r) => r && typeof r === 'object' && o.backend === r.backend && o.model === r.model;
  const i = options.findIndex((o) => same(o, remembered));
  if (i >= 0) return i;
  const auto = options.findIndex((o) => o.backend === options[0]?.backend && o.model === DEFAULT_MODEL[o.backend]);
  return Math.max(0, auto);
}

export const summary = (o) => `${CHOICES[o.backend]?.short || o.backend} · ${o.label}`;

// pick(options, { input, output, initial, color }) -> Promise<option>. One option resolves at once without asking.
// Rejects with err.code 'CANCELLED' (err.key 'ctrl-c' | 'escape' | 'eof'); the terminal is always restored.
export function pick(options, { input = process.stdin, output = process.stdout, initial = 0, color = !process.env.NO_COLOR } = {}) {
  if (options.length <= 1) return options.length ? Promise.resolve(options[0]) : Promise.reject(new Error('nothing to pick'));
  const sgr = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = sgr(2), bold = sgr(1), accent = sgr('1;36'), ok = sgr(32);
  const width = Math.max(...options.map((o) => o.label.length));
  let sel = Math.min(Math.max(0, initial), options.length - 1), drawn = 0;

  // keep every row on one terminal line, or the in-place redraw would miscount (room null: width unknown)
  const fit = (s, room) => (room == null || s.length <= room ? s : room <= 1 ? '' : s.slice(0, room - 1) + '…');
  function frame() {
    const cols = output.columns || 0, room = (n) => (cols ? cols - 1 - n : null);
    const lines = [bold(fit('Which model should describe your code?', room(0)))];
    let group;
    options.forEach((o, i) => {
      if (o.group !== group) { group = o.group; lines.push('', `  ${dim(fit(group, room(2)))}`); }
      const on = i === sel, label = fit(o.label.padEnd(width), room(6)), hint = fit(o.hint, room(8 + width)); // '  ❯ ● ' label '  '
      lines.push(`  ${on ? accent('❯ ●') : dim('  ○')} ${on ? accent(label) : label}${hint ? `  ${dim(hint)}` : ''}`);
    });
    lines.push('', `  ${dim(fit('↑↓ move · enter select · esc cancel', room(2)))}`);
    return lines;
  }
  // redraw in place: back to the first line we drew, clear to the end of the screen, write the new frame
  const clear = () => { if (drawn) output.write(`\r\x1b[${drawn}A\x1b[J`); drawn = 0; };
  const draw = () => { clear(); const l = frame(); output.write(l.join('\n') + '\n'); drawn = l.length; };

  return new Promise((resolve, reject) => {
    const raw = !!(input.isTTY && input.setRawMode), wasRaw = raw && !!input.isRaw;
    // a signal (kill, a closed terminal window, ctrl-c when not raw) skips 'exit' handlers: restore, then die by it
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const onSignal = (sig) => { restore(); process.kill(process.pid, sig); };
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true;
      input.removeListener('keypress', onKey); input.removeListener('end', onEnd); process.removeListener('exit', restore);
      for (const s of SIGNALS) process.removeListener(s, onSignal);
      if (raw) try { input.setRawMode(wasRaw); } catch {}
      input.pause(); try { output.write('\x1b[?25h'); } catch {}
    };
    const finish = (line, fn) => { clear(); output.write(line + '\n'); restore(); fn(); };
    const cancel = (key) => finish(`${dim('✕')} Model  ${dim('cancelled')}`, () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED', key })));
    const move = (d) => { sel = (sel + d + options.length) % options.length; draw(); };
    function onKey(str, key = {}) {
      if (key.ctrl && key.name === 'c') return cancel('ctrl-c');
      if (key.name === 'escape') return cancel('escape');
      if (key.name === 'return' || key.name === 'enter') return finish(`${ok('✓')} Model  ${summary(options[sel])}`, () => resolve(options[sel]));
      if (key.name === 'up' || key.name === 'k' || (key.ctrl && key.name === 'p')) return move(-1);
      if (key.name === 'down' || key.name === 'j' || (key.ctrl && key.name === 'n') || key.name === 'tab') return move(1);
      if (/^[1-9]$/.test(str || '') && Number(str) <= options.length) { sel = Number(str) - 1; draw(); }
    }
    const onEnd = () => cancel('eof'); // stdin closed (e.g. a pipe ran out of keys): don't hang
    process.once('exit', restore); // never leave the terminal raw or the cursor hidden
    for (const s of SIGNALS) process.once(s, onSignal);
    try {
      emitKeypressEvents(input);
      if (raw) input.setRawMode(true);
      input.on('keypress', onKey); input.once('end', onEnd);
      output.write('\x1b[?25l'); draw(); input.resume();
    } catch (e) { restore(); reject(e); }
  });
}
