#!/usr/bin/env node
// Inline a zoom tree JSON into viewer/template.html.
// Usage: loupe render <tree.json> [out.html]   (default: <tree>.html)
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { safeWriteFile, SafeFsError } from './fs-safe.mjs';

const PLACEHOLDER = '/*__ZOOM_TREE__*/null';
const CSP_SCRIPT_PLACEHOLDER = "script-src 'unsafe-inline'";
const [treePath = 'loupe-tree.json', outArg] = process.argv.slice(2);
const outPath = outArg || treePath.replace(/(\.tree)?\.json$/, '') + '.html';

let template = readFileSync(new URL('../viewer/template.html', import.meta.url), 'utf8');

// Embed the subset fonts (Inter, JetBrains Mono; OFL) as data URLs so the file stays self-contained.
// Done before the tree is inlined, so tree content can never be mistaken for the font placeholder.
const FONT_PLACEHOLDER = '/*__FONTS__*/';
const fontFace = (family, file, weight) => {
  const url = new URL(`../viewer/fonts/${file}`, import.meta.url);
  if (!existsSync(url)) return '';
  return `@font-face{font-family:"${family}";src:url(data:font/woff;base64,${readFileSync(url).toString('base64')}) format("woff");font-weight:${weight};font-style:normal;font-display:block;}`;
};
template = template.replace(FONT_PLACEHOLDER, () => fontFace('Inter', 'inter.woff', '400 600') + fontFace('JetBrains Mono', 'jbmono.woff', '400'));
const count = template.split(PLACEHOLDER).length - 1;
if (count !== 1) {
  console.error(`template must contain the placeholder exactly once (found ${count})`);
  process.exit(1);
}

// "__proto__" keys would re-parent objects once the JSON is inlined as a JS literal: drop them
const tree = JSON.parse(readFileSync(resolve(treePath), 'utf8'), (k, v) => (k === '__proto__' ? undefined : v));
const depth = (n, d = 0) => { if (d > 64) throw new Error('tree is nested more than 64 levels deep'); for (const c of Array.isArray(n?.children) ? n.children : []) depth(c, d + 1); };
try { depth(tree?.root); } catch (e) { console.error(`${treePath}: ${e.message}`); process.exit(1); }
if (!tree || typeof tree !== 'object' || !tree.root) {
  console.error(`${treePath}: expected { meta, root }`);
  process.exit(1);
}

// JSON is valid JS; escape what could end the <script> block or break older parsers.
const safe = JSON.stringify(tree)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// Function replacer so `$` sequences in the data are not interpreted.
let html = template.replace(PLACEHOLDER, () => safe);

// Replace script-src 'unsafe-inline' with exact sha256 hashes of the two inline <script> blocks.
const scriptHashes = [];
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  const body = m[1].replace(/\r\n?/g, '\n');
  scriptHashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}
if (scriptHashes.length === 2 && html.includes(CSP_SCRIPT_PLACEHOLDER)) {
  html = html.replace(CSP_SCRIPT_PLACEHOLDER, () => `script-src ${scriptHashes.join(' ')}`);
}

try { safeWriteFile(resolve(outPath), html); }
catch (e) { if (e instanceof SafeFsError) { console.error(`loupe: ${e.message}`); process.exit(2); } throw e; }
console.log(`wrote ${outPath} (${(html.length / 1024).toFixed(1)} KiB, ${tree.meta?.nodeCount ?? '?'} nodes)`);
