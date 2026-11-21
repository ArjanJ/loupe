#!/usr/bin/env node
// loupe: zoomable architecture maps for codebases and multi-repo systems.
// `loupe` with no subcommand (or only flags) means `loupe map`: scan + relations + render the current repo.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const COMMANDS = {
  map: ['map.mjs', 'loupe [map] [repoDir] [options]          map a repo in one go: scan, relations, render, open (default: cwd)'],
  scan: ['generate.mjs', 'loupe scan <repoDir> [tree.json]       describe a repo with a model (packages, modules, files)'],
  relations: ['relations.mjs', 'loupe relations <repoDir> <tree.json>  add typed relationships and flows to a scanned tree'],
  manifest: ['manifest.mjs', 'loupe manifest <manifest.yaml> [tree.json] [--strict]   turn a system manifest into a tree'],
  render: ['render.mjs', 'loupe render <tree.json> [out.html]      build the self-contained viewer'],
};
const HELP = `Loupe: zoomable architecture maps.

Usage:
${Object.values(COMMANDS).map(([, u]) => `  ${u}`).join('\n')}

Options for map:
  --out <file>        where to write the map (default: <repoDir>/architecture.html)
  --no-open           don't open the map in your browser (also off when CI or LOUPE_NO_OPEN is set, or stdout isn't a terminal)
  --backend <name>    claude | anthropic | openai (default: claude if on PATH, else ANTHROPIC_API_KEY, else OPENAI_API_KEY)
  --model <name>      model for that backend: a claude alias (sonnet, opus, haiku) or an API model id (also LOUPE_MODEL)
  --verbose           show every model call
  In a terminal (not in CI), with no --backend/--model and no LOUPE_BACKEND/LOUPE_MODEL, map asks which model to use first.
  scan and relations accept --backend and --model too. Intermediate files and the answer cache go to <repoDir>/.loupe/.

  -h, --help          this help
  -v, --version       print the version

See README.md and docs/ for details.`;

let [cmd, ...args] = process.argv.slice(2);
if (cmd === '--version' || cmd === '-v') { console.log(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version); process.exit(0); }
if (cmd === '--help' || cmd === '-h' || cmd === 'help' || ((cmd === 'map' || cmd?.startsWith('-')) && (args.includes('--help') || args.includes('-h')))) { console.log(HELP); process.exit(0); }
// no subcommand, only flags, or a directory (`loupe ../my-app`): map
if (cmd === undefined || cmd.startsWith('-') || (!Object.hasOwn(COMMANDS, cmd) && existsSync(cmd) && statSync(cmd).isDirectory())) { args = cmd === undefined ? [] : [cmd, ...args]; cmd = 'map'; }
if (!Object.hasOwn(COMMANDS, cmd)) { console.log(HELP); process.exit(2); }

// --backend / --model (<name> or =<name>) on scan, relations (any non-map subcommand) become LOUPE_BACKEND / LOUPE_MODEL for the step
// scripts (the flag wins over the env); map parses its own (src/map.mjs). A bad model stops here, before any work.
const env = { ...process.env };
if (cmd !== 'map') {
  const FLAGS = { '--backend': ['LOUPE_BACKEND', 'claude, anthropic or openai'], '--model': ['LOUPE_MODEL', 'e.g. sonnet or claude-sonnet-5-5'] };
  for (let i = 0; i < args.length; i++) {
    const [flag, eq] = args[i].startsWith('--') ? args[i].split(/=(.*)/s) : [];
    if (!Object.hasOwn(FLAGS, flag || '')) continue;
    const v = eq !== undefined ? eq : args[i + 1];
    args.splice(i--, eq !== undefined ? 1 : 2);
    if (!v || (eq === undefined && v.startsWith('-'))) { console.error(`loupe: ${flag} needs a value: ${FLAGS[flag][1]}`); process.exit(2); }
    env[FLAGS[flag][0]] = v;
  }
  if ((env.LOUPE_MODEL || env.LOUPE_EFFORT) && (cmd === 'scan' || cmd === 'relations')) { // render/manifest never use a model
    const { validateModel, validateEffort } = await import('../src/llm.mjs');
    try {
      if (env.LOUPE_MODEL) validateModel(env.LOUPE_MODEL);
      if (env.LOUPE_EFFORT) validateEffort(env.LOUPE_EFFORT);
    } catch (e) { console.error(e.message); process.exit(2); }
  }
}
const r = spawnSync(process.execPath, [join(here, '..', 'src', COMMANDS[cmd][0]), ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
