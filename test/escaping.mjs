// Hostile strings in a tree (labels, descriptions, relations, flows, evidence) must render as text, never as markup.
// Usage: node test/escaping.mjs
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from './_playwright.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_PROTO = /^(file|data|blob|about):/i;
const EVIL = [
  '</script><script>window.__pwn=1</script>',
  '<img src=x onerror="window.__pwn=2">',
  '"><svg onload=window.__pwn=3>',
  '${window.__pwn=4}', '$& $` $\' $$', '\u2028\u2029', '<!--', ']]>',
].join(' ');
const idPkgA = `pkg:a:${EVIL}`;
const idPkgB = `pkg:b:${EVIL}`;
const idA1 = `a1:${EVIL}`;
const idA2 = `a2:${EVIL}`;
const idB1 = `b1:${EVIL}`;
const leaf = (id, extra = {}) => ({ id, label: `${id} ${EVIL}`, kind: 'file', path: `src/${EVIL}/${id}.ts`, weight: 10, shortDescription: EVIL, longDescription: EVIL, functions: [EVIL], children: [], edges: [], ...extra });
const tree = {
  meta: { source: EVIL, levels: 3, levelNames: ['system', EVIL, 'files'], nodeCount: 6 },
  root: { id: 'system', label: `Evil ${EVIL}`, kind: 'system', path: `repo/${EVIL}`, weight: 100, shortDescription: EVIL, longDescription: EVIL, edges: [],
    children: [
      { id: idPkgA, label: `A ${EVIL}`, kind: 'package', path: `packages/${EVIL}/a`, packageName: `@evil/${EVIL}`, weight: 50, shortDescription: EVIL, longDescription: EVIL, edges: [], children: [leaf(idA1), leaf(idA2, { status: 'proposed', statusNote: EVIL, confidence: 'low' })] },
      { id: idPkgB, label: `B ${EVIL}`, kind: 'package', path: `packages/${EVIL}/b`, packageName: `@evil-b/${EVIL}`, weight: 50, shortDescription: EVIL, longDescription: EVIL, edges: [], children: [leaf(idB1)] },
    ],
    relations: [{ id: `r0:${EVIL}`, from: idA1, to: idB1, kind: 'http', label: EVIL, count: 2, details: [EVIL], evidence: [[`src/${EVIL}.ts`, 3, EVIL]], status: 'planned', confidence: 'low' }],
    rollups: { [`${idPkgA}|${idPkgB}`]: { label: EVIL, summary: EVIL } },
    flows: [{ id: `f:${EVIL}`, title: EVIL, summary: EVIL, status: EVIL, footnote: EVIL, steps: [{ from: idA1, to: idB1, kind: 'http', text: EVIL, detected: true, tags: ['inferred', EVIL] }, { from: idB1, to: idA2, kind: 'queue', text: EVIL, detected: false }] }] },
};
const dir = mkdtempSync(join(tmpdir(), 'loupe-esc-'));
try {
  writeFileSync(join(dir, 'evil.json'), JSON.stringify(tree));
  execFileSync(process.execPath, [join(ROOT, 'src/render.mjs'), join(dir, 'evil.json'), join(dir, 'evil.html')], { stdio: 'pipe' });
  const renderedHtml = readFileSync(join(dir, 'evil.html'), 'utf8');
  const hasCsp = /http-equiv="Content-Security-Policy"[^>]*default-src 'none'/.test(renderedHtml)
    && /script-src 'sha256-[^']+' 'sha256-[^']+'/.test(renderedHtml);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('dialog', (d) => { errs.push('dialog'); d.dismiss(); });
  p.on('request', (req) => { if (!ALLOWED_PROTO.test(req.url())) errs.push(`network request: ${req.url()}`); });
  await p.goto('file://' + join(dir, 'evil.html')); await p.waitForTimeout(300);
  await p.evaluate(() => window.__sz.fitNode('system', false)); await p.waitForTimeout(400);
  const r = await p.evaluate((id) => window.__sz.rect(id), idPkgA);
  await p.mouse.move(r.sx + r.sw / 2, r.sy + r.sh / 2); await p.waitForTimeout(300);
  await p.mouse.click(r.sx + r.sw / 2, r.sy + r.sh / 2); await p.waitForTimeout(400);
  await p.evaluate((id) => window.__sz.select(id), idA2); await p.waitForTimeout(300);
  await p.locator('#legendBtn').click(); await p.waitForTimeout(150);
  await p.locator('#flowsBtn').click(); await p.waitForTimeout(150);
  await p.locator('#pop .row').first().click(); await p.waitForTimeout(1200);
  const res = await p.evaluate(() => ({ pwn: window.__pwn ?? null, scripts: document.scripts.length, imgs: document.images.length, svgs: document.querySelectorAll('svg[onload]').length, title: document.title }));
  await b.close();
  const ok = hasCsp && res.pwn === null && res.imgs === 0 && res.svgs === 0 && res.scripts === 2 && !errs.length;
  console.log(JSON.stringify({ hasCsp, ...res, errors: errs }));
  console.error(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
