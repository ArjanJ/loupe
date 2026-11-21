#!/usr/bin/env node
// Capture the website's feature images from the real demo maps, light and dark, as WebP in site/assets/.
// Usage: node scripts/capture-site-images.mjs   (needs Playwright; see test/_playwright.mjs)
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../test/_playwright.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site/assets');
mkdirSync(OUT, { recursive: true });

// name, map, viewport, how to pose it, crop (CSS px; null = whole viewport), output width (px, ~2x the shown size)
const SHOTS = [
  { name: 'zoom', map: 'demo/excalidraw/excalidraw.html', vp: [860, 560], width: 1200, clip: null,
    pose: async (p) => {
      await p.evaluate(() => { document.getElementById('hud').style.visibility = 'hidden'; window.__sz.fitNode('pkg:packages/excalidraw', false); });
    } },
  { name: 'flow', map: 'demo/excalidraw/excalidraw.html', vp: [900, 640], width: 960, clip: (w) => ({ x: w - 600, y: 0, width: 600, height: 450 }),
    pose: async (p) => {
      await p.evaluate(() => window.__sz.fitNode('system', false));
      await p.evaluate(() => { const f = window.__sz.flows().find((f) => /collab/i.test(f.title)) || window.__sz.flows()[0]; window.__sz.playFlow(f.id, 3, 0.6); });
    } },
  { name: 'inspector', map: 'examples/bramble/bramble.html', vp: [900, 640], width: 960, clip: (w) => ({ x: w - 600, y: 0, width: 600, height: 450 }),
    pose: async (p) => {
      await p.evaluate(() => window.__sz.fitNode('system', false)); await p.waitForTimeout(300);
      const r = await p.evaluate(() => window.__sz.rect('svc:dispatch'));
      await p.mouse.click(r.sx + r.sw / 2, r.sy + r.sh / 2);
      await p.mouse.move(2, 2);
    } },
];

const browser = await chromium.launch();
const encoder = await browser.newPage();
const toWebp = (png, width) => encoder.evaluate(async ({ b64, width }) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = width; c.height = Math.round(img.height * width / img.width);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/webp', 0.86), w: c.width, h: c.height };
}, { b64: png.toString('base64'), width });

let total = 0;
for (const s of SHOTS) for (const scheme of ['light', 'dark']) {
  const p = await browser.newPage({ viewport: { width: s.vp[0], height: s.vp[1] }, deviceScaleFactor: 2, colorScheme: scheme });
  await p.goto('file://' + join(ROOT, s.map));
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => document.getElementById('hint')?.classList.add('gone'));
  await s.pose(p);
  await p.mouse.move(2, 2); await p.waitForTimeout(800);
  await p.waitForFunction(() => !window.__sz.animating); await p.waitForTimeout(400);
  const png = await p.screenshot(s.clip ? { clip: s.clip(s.vp[0]) } : {});
  const { url, w, h } = await toWebp(png, s.width);
  const file = join(OUT, `${s.name}-${scheme}.webp`);
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  total += statSync(file).size;
  console.log(`wrote site/assets/${s.name}-${scheme}.webp (${w}x${h}, ${(statSync(file).size / 1024).toFixed(0)} KiB)`);
  await p.close();
}
await browser.close();
console.log(`total ${(total / 1024).toFixed(0)} KiB`);
