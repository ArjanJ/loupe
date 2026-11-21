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
  --verbose           show every model call
  scan and relations accept --backend too. Intermediate files and the answer cache go to <repoDir>/.loupe/.

  -h, --help          this help
  -v, --version       print the version

See README.md and docs/ for details.`;

let [cmd, ...args] = process.argv.slice(2);
if (cmd === '--version' || cmd === '-v') { console.log(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version); process.exit(0); }
if (cmd === '--help' || cmd === '-h' || cmd === 'help' || ((cmd === 'map' || cmd?.startsWith('-')) && (args.includes('--help') || args.includes('-h')))) { console.log(HELP); process.exit(0); }
// no subcommand, only flags, or a directory (`loupe ../my-app`): map
if (cmd === undefined || cmd.startsWith('-') || (!Object.hasOwn(COMMANDS, cmd) && existsSync(cmd) && statSync(cmd).isDirectory())) { args = cmd === undefined ? [] : [cmd, ...args]; cmd = 'map'; }
if (!Object.hasOwn(COMMANDS, cmd)) { console.log(HELP); process.exit(2); }

// --backend <name> / --backend=<name> on any subcommand becomes LOUPE_BACKEND for the step scripts
const env = { ...process.env };
if (cmd !== 'map') {
  for (let i = 0; i < args.length; i++) {
    let v;
    if (args[i] === '--backend') { v = args[i + 1]; args.splice(i--, 2); }
    else if (args[i].startsWith('--backend=')) { v = args[i].slice(10); args.splice(i--, 1); }
    else continue;
    if (!v || v.startsWith('-')) { console.error('loupe: --backend needs a value: claude, anthropic or openai'); process.exit(2); }
    env.LOUPE_BACKEND = v;
  }
}
const r = spawnSync(process.execPath, [join(here, '..', 'src', COMMANDS[cmd][0]), ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
