#!/usr/bin/env node
// Build the static website into _site/ (gitignored): site/ + the demo maps + the viewer fonts + license files.
// Usage: npm run site   then   python3 -m http.server -d _site 8080   (or `npm run site:dev` to serve live without building)
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');

// [source in the repo, destination in _site]
export const FILES = [
  ['demo/excalidraw/excalidraw.html', 'demos/excalidraw.html'],
  ['viewer/fonts/inter.woff', 'fonts/inter.woff'],
  ['viewer/fonts/jbmono.woff', 'fonts/jbmono.woff'],
  ['LICENSE', 'LICENSE.txt'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt'], // .txt so every static host serves it as readable text
];

export function buildSite() {
  const missing = ['site/index.html', ...FILES.map(([src]) => src)].filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) {
    console.error(`build-site: missing ${missing.join(', ')}\n(regenerate the maps with \`npm run example\` or the demo's own commands)`);
    process.exit(1);
  }

  const rejectSymlinks = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { console.error(`build-site: refusing symlink ${p}`); process.exit(1); }
    if (st.isDirectory()) for (const f of readdirSync(p)) rejectSymlinks(join(p, f));
  };
  rejectSymlinks(join(ROOT, 'site'));

  rmSync(OUT, { recursive: true, force: true });
  cpSync(join(ROOT, 'site'), OUT, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
  for (const [src, dest] of FILES) {
    mkdirSync(dirname(join(OUT, dest)), { recursive: true });
    copyFileSync(join(ROOT, src), join(OUT, dest));
  }
  writeFileSync(join(OUT, '.nojekyll'), '');

  const size = (dir) => readdirSync(dir).reduce((s, f) => { const p = join(dir, f); const st = statSync(p); return s + (st.isDirectory() ? size(p) : st.size); }, 0);
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`wrote _site/ (${kib(size(OUT))}; ${kib(size(OUT) - size(join(OUT, 'demos')))} without the demo maps)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  buildSite();
}
