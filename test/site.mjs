// Website checks: builds _site/, checks its files and references, then drives it in a browser (light + dark, desktop + phone).
// Usage: node test/site.mjs   (needs Playwright for the browser half; see test/_playwright.mjs)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '_site');
const insideSite = (p) => p === SITE || p.startsWith(SITE + sep);
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

// 1. build
const build = spawnSync(process.execPath, [join(ROOT, 'scripts/build-site.mjs')], { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stderr || build.stdout); process.exit(1); }
for (const f of ['index.html', 'style.css', 'site.js', 'favicon.svg', 'demos/excalidraw.html', 'demos/bramble.html', 'fonts/inter.woff', 'fonts/jbmono.woff', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', '.nojekyll'])
  check(existsSync(join(SITE, f)), `missing _site/${f}`);

// 2. references: nothing external except <a href>, and every local reference resolves
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const css = readFileSync(join(SITE, 'style.css'), 'utf8');
const refs = [];
for (const m of html.matchAll(/<([a-z]+)\b[^>]*>/gi)) for (const a of m[0].matchAll(/\s(src|href|srcset|poster|data)\s*=\s*"([^"]*)"/gi)) refs.push({ tag: m[1].toLowerCase(), attr: a[1].toLowerCase(), url: a[2] });
for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) refs.push({ tag: 'css', attr: 'url', url: m[1] });
check(!/@import/i.test(css), 'style.css must not @import');
const external = (u) => /^(https?:)?\/\//i.test(u);
for (const { tag, attr, url } of refs) {
  if (external(url)) { check(tag === 'a', `external ${tag} resource: ${url}`); continue; }
  if (/^(#|mailto:|data:)/.test(url)) continue;
  check(!/^\/(?!\/)/.test(url), `${tag} ${attr} must be relative, not root-absolute: ${url}`);
  const p = normalize(join(SITE, decodeURI(url.split(/[?#]/)[0])));
  check(insideSite(p) && existsSync(p) && statSync(p).isFile(), `${tag} reference does not resolve: ${url}`);
}
for (const id of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) check(html.includes(`id="${id}"`), `dangling anchor #${id}`);
check(!/\son[a-z]+\s*=/i.test(html), 'inline event handler in index.html');
check(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html) && !/<style/i.test(html), 'inline script or style in index.html (breaks the CSP)');

// 3. browser (served under /loupe/ to match GitHub Pages project URLs)
const { chromium } = await import('./_playwright.mjs');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.txt': 'text/plain' };
const PREFIX = '/loupe/';
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
  const rel = path.slice(PREFIX.length);
  const file = normalize(join(SITE, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel));
  if (!insideSite(file) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}${PREFIX}`;
const browser = await chromium.launch();
const mapReady = async (page, name) => {
  const frame = await (async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find((f) => f.url().endsWith(`demos/${name}.html`)); if (f) return f; await page.waitForTimeout(50); } })();
  if (!frame) return null;
  return frame.waitForFunction(() => !!window.__sz && window.__sz.nodes.length > 0, null, { timeout: 15000 }).then(() => frame, () => null);
};
// site.js opens each map one level deeper once it is on screen (the viewer's own level switcher)
const opened = (frame) => frame.waitForFunction(() => document.querySelectorAll('#seg button')[1]?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 }).then(() => true, () => false);
try {
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('requestfailed', (r) => errs.push(`request failed: ${r.url()}`));
    page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) errs.push(`external request: ${r.url()}`); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    check(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches) === (colorScheme === 'dark'), `${colorScheme}: scheme not applied`);

    // wait for subtle entrance animations to settle before measuring hero geometry
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));

    // desktop hero: demo iframe starts within the upper viewport, dominates (>= 50%), with no veil blocking interaction
    const hero = await page.evaluate(() => {
      const iframe = document.querySelector('#panel-excalidraw iframe');
      const veil = document.querySelector('#panel-excalidraw .veil');
      const r = iframe.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return {
        top: Math.round(r.top),
        ratio: (visW * visH) / (innerWidth * innerHeight),
        veilHidden: getComputedStyle(veil).display === 'none',
      };
    });
    check(hero.top <= 320, `${colorScheme}: desktop demo iframe starts at y=${hero.top}px (expected <= 320px)`);
    check(hero.ratio >= 0.5, `${colorScheme}: desktop demo iframe covers only ${(hero.ratio * 100).toFixed(1)}% of first viewport (expected >= 50%)`);
    check(hero.veilHidden, `${colorScheme}: desktop touch veil should be hidden`);

    const ex = await mapReady(page, 'excalidraw');
    check(ex, `${colorScheme}: Excalidraw map did not load`);
    check(ex && await opened(ex), `${colorScheme}: Excalidraw map did not open a level deeper`);
    check(await page.evaluate(() => document.activeElement === document.body), `${colorScheme}: opening the map moved focus`);

    // immediately interactive on desktop without any veil: clicking a card opens the inspector
    if (ex) {
      await ex.waitForFunction(() => !window.__sz.animating);
      const box = await (await page.$('#panel-excalidraw iframe')).boundingBox();
      const card = await ex.evaluate(() => window.__sz.visible().filter((v) => v.depth >= 1 && v.openness < 0.5 && v.alpha > 0.9 && v.sw > 60 && v.sx > 0 && v.sy > 0 && v.sx + v.sw < innerWidth && v.sy + v.sh < innerHeight - 100).sort((a, b) => b.sw * b.sh - a.sw * a.sh)[0]);
      check(card, `${colorScheme}: no closed card visible in Excalidraw`);
      if (card) {
        await page.mouse.click(box.x + card.sx + card.sw / 2, box.y + card.sy + card.sh / 2);
        check(await ex.waitForFunction(() => window.__sz.inspector().open, null, { timeout: 3000 }).then(() => true, () => false), `${colorScheme}: clicking a card directly on desktop did not open the inspector`);
      }
    }

    // tabs with the keyboard
    await page.focus('#tab-excalidraw');
    await page.keyboard.press('ArrowRight');
    const st = await page.evaluate(() => ({
      sel: document.activeElement.id,
      ex: document.getElementById('panel-excalidraw').hidden,
      br: document.getElementById('panel-bramble').hidden,
      aria: document.getElementById('tab-bramble').getAttribute('aria-selected'),
      full: document.getElementById('full-link').getAttribute('href'),
    }));
    check(st.sel === 'tab-bramble' && st.aria === 'true' && st.ex && !st.br && st.full === 'demos/bramble.html', `${colorScheme}: ArrowRight did not switch to Bramble (${JSON.stringify(st)})`);
    const br = await mapReady(page, 'bramble');
    check(br, `${colorScheme}: Bramble map did not load`);
    check(br && await opened(br), `${colorScheme}: Bramble map did not open a level deeper`);
    await page.keyboard.press('End'); await page.keyboard.press('Home');
    check(await page.evaluate(() => document.activeElement.id === 'tab-excalidraw' && !document.getElementById('panel-excalidraw').hidden && document.getElementById('full-link').getAttribute('href') === 'demos/excalidraw.html'), `${colorScheme}: Home did not return to Excalidraw`);

    // copy button, keyboard-activated
    await page.focus('[data-copy]'); await page.keyboard.press('Enter');
    const said = await page.waitForFunction(() => /Copied|⌘C|Ctrl\+C/.test(document.querySelector('.copy-label').textContent) && document.getElementById('live').textContent, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => '');
    check(/Copied npx @arjanj\/loupe|selected/.test(said), `${colorScheme}: copy was not announced`);
    check(!errs.length, `${colorScheme}: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // phone: no horizontal overflow down to 320px, touch wording, scaled map with unclipped HUD behind a veil, tap + pinch work
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.evaluate(() => document.fonts.ready);
  for (const w of [320, 360, 375]) {
    await page.setViewportSize({ width: w, height: 740 });
    await page.waitForTimeout(50);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(ov <= 0, `horizontal overflow at ${w}px: ${ov}px`);
  }
  const shown = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none', sel);
  check(await shown('.hint.touch') && !(await shown('.hint.fine')), 'touch hint not shown on a touch screen');
  const fx = await mapReady(page, 'excalidraw');
  check(fx && await opened(fx), 'phone: Excalidraw map did not open a level deeper');
  if (fx) {
    const hudCheck = await fx.evaluate(() => {
      const hud = document.getElementById('hud').getBoundingClientRect();
      const fit = document.getElementById('fit').getBoundingClientRect();
      const crumb = document.querySelector('#crumbs button');
      return {
        inner: innerWidth,
        clipped: fit.right > hud.right + 1 || hud.right > innerWidth,
        crumbTrunc: crumb ? crumb.scrollWidth > crumb.clientWidth + 1 : false,
      };
    });
    check(hudCheck.inner >= 760, `phone: map renders ${hudCheck.inner}px wide, expected scaled >= 760px`);
    check(!hudCheck.clipped && !hudCheck.crumbTrunc, `phone: viewer HUD controls are clipped/truncated at ${hudCheck.inner}px (${JSON.stringify(hudCheck)})`);
    await page.tap('#panel-excalidraw .veil');
    check(!(await page.$('#panel-excalidraw .veil')), 'phone: the veil did not go away on tap');
    check(await page.evaluate(() => document.activeElement === document.querySelector('#panel-excalidraw iframe')), 'phone: dismissing the veil did not focus the map iframe');
    await fx.waitForFunction(() => !window.__sz.animating);
    await page.evaluate(() => document.querySelector('#panel-excalidraw .frame').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForTimeout(100);
    const box = await (await page.$('#panel-excalidraw iframe')).boundingBox();
    const s = box.width / hudCheck.inner;
    // tap a card: page coordinates = iframe box + map coordinates x scale
    const r = await fx.evaluate(() => window.__sz.visible().filter((v) => v.depth >= 1 && v.openness < 0.5 && v.alpha > 0.9 && v.sw > 40 && v.sx > 0 && v.sy > 0 && v.sx + v.sw < innerWidth && v.sy + v.sh < innerHeight - 100).sort((a, b) => b.sw * b.sh - a.sw * a.sh)[0]);
    check(r, 'phone: no closed card on screen to tap');
    if (r) await page.touchscreen.tap(box.x + (r.sx + r.sw / 2) * s, box.y + (r.sy + r.sh / 2) * s);
    check(await fx.waitForFunction(() => window.__sz.inspector().open, null, { timeout: 3000 }).then(() => true, () => false), 'phone: tapping a card did not open the inspector');
    await fx.waitForFunction(() => !window.__sz.animating);
    // two-finger pinch out zooms in
    const before = await fx.evaluate(() => window.__sz.camera.scale);
    const cdp = await ctx.newCDPSession(page);
    const cx = box.x + box.width * 0.18, cy = box.y + box.height * 0.45; // left of the inspector panel
    const pts = (d) => [{ x: cx, y: cy - d, id: 1 }, { x: cx, y: cy + d, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(30) });
    for (const d of [45, 60, 80, 100]) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) }); await page.waitForTimeout(30); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(100);
    const after = await fx.evaluate(() => window.__sz.camera.scale);
    check(after > before * 1.5, `phone: pinch did not zoom the map (${before} -> ${after})`);
  }
  check(!errs.length, `phone: ${errs.join(' | ')}`);
  await ctx.close();
} finally { await browser.close(); server.close(); }

if (fails.length) { console.error('site: FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('site: ok (build, references, light + dark, hero >=50% & veil-free, maps open deeper, tabs, copy, phone: no overflow, unclipped HUD, touch hint, tap + pinch)');
