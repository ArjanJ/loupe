// The commit stamp: short SHA (full SHA on hover, click to copy), "modified" when dirty, the date, a GitHub link only for a
// github.com source, and it gives way to the toolbar on narrow windows.
// Usage: node test/stamp.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from './_playwright.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = '3f9c2e1a7b04d58e9c61f20b3a4d7e8c5f1a2b90';
const leaf = (id) => ({ id, label: id, kind: 'file', path: `src/${id}.ts`, weight: 10, shortDescription: 'x', longDescription: 'x', children: [], edges: [] });
const tree = (meta) => ({ meta: { levels: 2, levelNames: ['system', 'files'], nodeCount: 3, ...meta },
  root: { id: 'system', label: 'Stamp', kind: 'system', path: '.', weight: 20, shortDescription: 'x', longDescription: 'x', edges: [], children: [leaf('a'), leaf('b')] } });
const CASES = {
  github: { meta: { source: 'github.com/owner/repo', commit: SHA, dirty: false, generatedAt: '2026-11-22T12:00:00Z' } },
  dirty: { meta: { source: 'github.com/owner/repo', commit: SHA, dirty: true, generatedAt: '2026-11-22T12:00:00Z' } },
  other: { meta: { source: 'gitlab.com/owner/repo', commit: SHA.toUpperCase() } },
  sneaky: { meta: { source: 'github.com/owner/repo"/../x', commit: SHA } },
  dateOnly: { meta: { source: 'system manifest m.yaml', generatedAt: '2026-11-22T12:00:00Z' } },
  none: { meta: { source: 'x' } },
};
const dir = mkdtempSync(join(tmpdir(), 'loupe-stamp-'));
const fails = [];
const check = (ok, what, got) => { if (!ok) fails.push(`${what}: ${JSON.stringify(got)}`); };
try {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const errs = [];
  for (const [name, c] of Object.entries(CASES)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(tree(c.meta)));
    execFileSync(process.execPath, [join(ROOT, 'src/render.mjs'), join(dir, `${name}.json`), join(dir, `${name}.html`)], { stdio: 'pipe' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('file://' + join(dir, `${name}.html`)); await p.waitForTimeout(200);
    c.got = await p.evaluate(() => window.__sz.stamp());
    if (name === 'github') {
      await p.locator('#stampSha').click(); await p.waitForTimeout(150);
      c.copied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      c.toast = await p.locator('#toast').textContent();
      await p.setViewportSize({ width: 900, height: 900 }); await p.waitForTimeout(200);
      c.narrow = await p.evaluate(() => ({ ...window.__sz.stamp(), compact: document.getElementById('stamp').classList.contains('compact') }));
      await p.setViewportSize({ width: 560, height: 900 }); await p.waitForTimeout(200);
      c.tiny = await p.evaluate(() => window.__sz.stamp());
    }
    await p.close();
  }
  await b.close();
  const { github: g, dirty: d, other: o, sneaky: s, dateOnly: n, none: z } = CASES;
  check(g.got.shown && g.got.text.startsWith('3f9c2e1') && !g.got.text.includes(SHA) && g.got.title.includes(SHA) && /Nov 22, 2026/.test(g.got.text), 'github: short sha, full on hover, date', g.got);
  check(g.got.link === `https://github.com/owner/repo/commit/${SHA}`, 'github: links the commit', g.got);
  check(g.copied === SHA && /copied/i.test(g.toast), 'github: click copies the full sha', [g.copied, g.toast]);
  check(g.narrow.shown && g.narrow.compact, 'narrow: date dropped before the stamp', g.narrow);
  check(!g.tiny.shown, 'tiny: stamp gives way to the toolbar', g.tiny);
  check(d.got.text.includes('modified') && !d.got.link && /uncommitted/.test(d.got.title), 'dirty: marked modified, no link', d.got);
  check(o.got.shown && o.got.text.startsWith('3f9c2e1') && !o.got.link, 'non-github: no link, sha lowercased', o.got);
  check(s.got.shown && !s.got.link, 'odd source: no link', s.got);
  check(n.got.shown && n.got.text === 'Generated Nov 22, 2026' && !n.got.title, 'no commit: date only', n.got);
  check(!z.got.shown, 'nothing to show: hidden', z.got);
  check(!errs.length, 'no page errors', errs);
  console.log(fails.length ? fails.join('\n') : 'stamp: all checks pass');
  console.error(fails.length ? 'FAIL' : 'PASS');
  process.exitCode = fails.length ? 1 : 0;
} finally { rmSync(dir, { recursive: true, force: true }); }
