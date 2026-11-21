#!/usr/bin/env node
// loupe: zoomable architecture maps for codebases and multi-repo systems.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const COMMANDS = {
  scan: ['generate.mjs', 'loupe scan <repoDir> [tree.json]       describe a repo with Claude Code (packages, modules, files)'],
  relations: ['relations.mjs', 'loupe relations <repoDir> <tree.json>  add typed relationships and flows to a scanned tree'],
  manifest: ['manifest.mjs', 'loupe manifest <manifest.yaml> [tree.json] [--strict]   turn a system manifest into a tree'],
  render: ['render.mjs', 'loupe render <tree.json> [out.html]      build the self-contained viewer'],
};
const [cmd, ...args] = process.argv.slice(2);
if (cmd === '--version' || cmd === '-v') { console.log(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version); process.exit(0); }
if (!cmd || !Object.hasOwn(COMMANDS, cmd)) {
  console.log(`Loupe: zoomable architecture maps.\n\nUsage:\n${Object.values(COMMANDS).map(([, u]) => `  ${u}`).join('\n')}\n\nSee README.md and docs/ for details.`);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 2 : 0);
}
const r = spawnSync(process.execPath, [join(here, '..', 'src', COMMANDS[cmd][0]), ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
