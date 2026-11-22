// README screenshots of the public demo and example, in light and dark, at 2x.
// Usage: node test/screenshots.mjs   (writes docs/screenshots/*.png)
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from './_playwright.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/screenshots');
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const errors = [];
async function view(file, scheme) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('file://' + join(ROOT, file)); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById('hint')?.classList.add('gone'));
  return p;
}
const shot = (p, name) => p.screenshot({ path: join(OUT, name) });
const settle = (p, ms = 900) => p.mouse.move(2, 2).then(() => p.waitForTimeout(ms));
const center = async (p, id) => { const r = await p.evaluate((i) => window.__sz.rect(i), id); return [r.sx + r.sw / 2, r.sy + r.sh / 2]; };

for (const scheme of ['light', 'dark']) {
  // Immich demo: overview, a package with its relationships, a flow
  let p = await view('demo/immich/immich.html', scheme);
  await p.evaluate(() => window.__sz.fitNode('system', false)); await settle(p);
  await shot(p, `immich-overview-${scheme}.png`);
  await p.evaluate(() => window.__sz.fitNode('pkg:server', false)); await settle(p);
  const [x, y] = await center(p, 'pkg:server');
  await p.mouse.move(x, y); await p.waitForTimeout(700);
  await shot(p, `immich-package-${scheme}.png`);
  await p.evaluate(() => { const f = window.__sz.flows().find((f) => /upload/i.test(f.title)) || window.__sz.flows()[0]; window.__sz.playFlow(f.id, 3, 0.6); }); await p.waitForTimeout(1600);
  await shot(p, `immich-flow-${scheme}.png`);
  await p.close();
  // Bramble (fictional) system manifest: statuses, inspector
  p = await view('examples/bramble/bramble.html', scheme);
  await p.evaluate(() => window.__sz.fitNode('system', false)); await settle(p);
  const [dx, dy] = await center(p, 'svc:dispatch');
  await p.mouse.move(dx, dy); await p.waitForTimeout(500);
  await p.mouse.click(dx, dy); await p.waitForTimeout(800);
  await shot(p, `bramble-system-${scheme}.png`);
  await p.close();
}
await b.close();
console.log(errors.length ? `errors: ${errors.join(' | ')}` : `wrote ${OUT}`);
process.exitCode = errors.length ? 1 : 0;
