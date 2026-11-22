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
for (const f of ['index.html', 'style.css', 'site.js', 'favicon.svg', 'demos/excalidraw.html', 'fonts/inter.woff', 'fonts/jbmono.woff', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', '.nojekyll'])
  check(existsSync(join(SITE, f)), `missing _site/${f}`);

// 2. references: nothing external except <a href>, and every local reference resolves
const html = readFileSync(join(SITE, 'index.html'), 'utf8');
const css = readFileSync(join(SITE, 'style.css'), 'utf8');
const refs = [];
for (const m of html.matchAll(/<([a-z]+)\b[^>]*>/gi)) for (const a of m[0].matchAll(/\s(src|href|srcset|poster|data|data-src|data-href)\s*=\s*"([^"]*)"/gi)) refs.push({ tag: m[1].toLowerCase(), attr: a[1].toLowerCase(), url: a[2] });
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
for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) check(!/\sloading\s*=\s*"?lazy/i.test(m[0]), `demo iframe must not be loading="lazy" (breaks the viewer's fly animation, #16): ${m[0]}`);
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
// verify a map actually rendered: finite camera scale in [fitScale*0.5, maxScale], non-zero canvas, and >= 3 visible cards inside the iframe viewport
const checkMapRendered = async (frame, label) => {
  if (!frame) { check(false, `${label}: frame not found`); return; }
  await frame.waitForFunction(() => !window.__sz.animating, null, { timeout: 6000 }).catch(() => {});
  const info = await frame.evaluate(() => {
    const c = window.__sz?.camera;
    const cv = document.getElementById('c');
    const vis = (window.__sz?.visible?.() || []).filter((v) =>
      v.depth >= 1 && v.alpha > 0.5 && v.sw > 10 && v.sh > 10 &&
      v.sx + v.sw > 0 && v.sx < innerWidth && v.sy + v.sh > 0 && v.sy < innerHeight
    );
    return {
      cam: c ? { x: c.x, y: c.y, scale: c.scale, fitScale: c.fitScale, maxScale: c.maxScale } : null,
      finite: !!c && [c.x, c.y, c.scale, c.fitScale, c.maxScale].every(Number.isFinite),
      inRange: !!c && Number.isFinite(c.scale) && c.scale >= c.fitScale * 0.5 && c.scale <= c.maxScale,
      canvasW: cv ? cv.width : 0,
      canvasH: cv ? cv.height : 0,
      inner: [innerWidth, innerHeight],
      visCount: vis.length,
    };
  });
  check(info.finite && info.inRange, `${label}: camera scale out of range or non-finite (${JSON.stringify(info.cam)})`);
  check(info.canvasW > 0 && info.canvasH > 0, `${label}: canvas has zero size (${info.canvasW}x${info.canvasH})`);
  check(info.visCount >= 3, `${label}: expected >= 3 visible cards inside viewport, got ${info.visCount} (inner=${info.inner.join('x')}, cam=${JSON.stringify(info.cam)})`);
};
// wait for finite CSS animations/transitions to settle (ignore infinite ambient background animations)
const waitAnims = (target) => target.evaluate(() => Promise.all(
  document.getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime))
    .map((a) => a.finished.catch(() => {}))
));
// verify the inspector's Close button centre (mapped through --s) is hit-testable on the iframe, not covered by any site overlay
const checkInspectorCloseClear = async (page, frame, label) => {
  await waitAnims(page);
  await waitAnims(frame);
  const closeCenter = await frame.evaluate(() => {
    const btn = document.querySelector('#insp .close');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  check(closeCenter, `${label}: inspector Close button not found`);
  if (!closeCenter) return null;
  const hit = await page.evaluate(({ ix, iy }) => {
    const frameEl = document.querySelector('#panel-excalidraw .frame');
    const iframeEl = document.querySelector('#panel-excalidraw iframe');
    const s = parseFloat(getComputedStyle(frameEl).getPropertyValue('--s')) || 1;
    const ir = iframeEl.getBoundingClientRect();
    const px = ir.left + ix * s;
    const py = ir.top + iy * s;
    const el = document.elementFromPoint(px, py);
    return {
      isIframe: el === iframeEl,
      tag: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') : 'null',
      px,
      py,
      s,
    };
  }, { ix: closeCenter.x, iy: closeCenter.y });
  check(hit.isIframe, `${label}: inspector Close button centre (${Math.round(hit.px)},${Math.round(hit.py)}, s=${hit.s.toFixed(3)}) hit ${hit.tag}, expected iframe`);
  return hit;
};
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
    await waitAnims(page);

    // desktop hero: frame starts in the upper viewport, fits the viewport, leaves page-scroll gutters, visible share >= 40%, veil-free, no site controls on the canvas, full-screen link in the caption below
    const hero = await page.evaluate(() => {
      const frame = document.querySelector('#panel-excalidraw .frame');
      const iframe = document.querySelector('#panel-excalidraw iframe');
      const veil = document.querySelector('#panel-excalidraw .veil');
      const full = document.getElementById('full-link');
      const r = iframe.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const lr = full.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return {
        top: Math.round(r.top),
        h: Math.round(fr.height),
        gutters: [Math.round(fr.left), Math.round(innerWidth - fr.right)],
        ratio: (visW * visH) / (innerWidth * innerHeight),
        veilHidden: getComputedStyle(veil).display === 'none',
        fullBelow: lr.top >= fr.bottom,
        overlays: frame.querySelectorAll('a, button:not(.veil)').length,
        fullAccessible: !!(full.textContent && full.textContent.trim().length > 0),
      };
    });
    check(hero.top <= 460, `${colorScheme}: desktop demo iframe starts at y=${hero.top}px (expected <= 460px)`);
    check(hero.h <= 900 - 64, `${colorScheme}: desktop frame height ${hero.h}px exceeds viewport height - 64`);
    check(hero.gutters.every((g) => g >= 48), `${colorScheme}: desktop frame leaves side gutters of ${hero.gutters.join('/')}px (expected >= 48px each so the page can be scrolled beside the map)`);
    check(hero.ratio >= 0.35, `${colorScheme}: desktop demo iframe covers only ${(hero.ratio * 100).toFixed(1)}% of first viewport (expected >= 35%)`);
    check(hero.veilHidden, `${colorScheme}: desktop touch veil should be hidden`);
    check(hero.fullBelow && hero.fullAccessible, `${colorScheme}: full-screen link should sit in the caption below the frame with an accessible name`);
    check(hero.overlays === 0, `${colorScheme}: the frame should hold only the map, found ${hero.overlays} site control(s) on the canvas`);

    const ex = await mapReady(page, 'excalidraw');
    check(ex, `${colorScheme}: Excalidraw map did not load`);
    check(ex && await opened(ex), `${colorScheme}: Excalidraw map did not open a level deeper`);
    check(await page.evaluate(() => document.activeElement === document.body), `${colorScheme}: opening the map moved focus`);
    await checkMapRendered(ex, `${colorScheme} desktop Excalidraw`);

    // the demo shows the artifact as it really looks: its own canvas and dot grid, not restyled by the site
    if (ex) {
      const native = await ex.evaluate(() => {
        const g0 = document.getElementById('grid0');
        return !!g0 && getComputedStyle(g0).visibility !== 'hidden' && !document.documentElement.style.background;
      });
      check(native, `${colorScheme}: Excalidraw demo should keep the viewer's own canvas and dot grid`);
    }

    // immediately interactive on desktop without any veil: clicking a card opens the inspector
    if (ex) {
      await ex.waitForFunction(() => !window.__sz.animating);
      const box = await (await page.$('#panel-excalidraw iframe')).boundingBox();
      const card = await ex.evaluate(() => window.__sz.visible().filter((v) => v.depth >= 1 && v.openness < 0.5 && v.alpha > 0.9 && v.sw > 60 && v.sx > 0 && v.sy > 0 && v.sx + v.sw < innerWidth && v.sy + v.sh < innerHeight - 100).sort((a, b) => b.sw * b.sh - a.sw * a.sh)[0]);
      check(card, `${colorScheme}: no closed card visible in Excalidraw`);
      if (card) {
        await page.mouse.click(box.x + card.sx + card.sw / 2, box.y + card.sy + card.sh / 2);
        const inspOpen = await ex.waitForFunction(() => window.__sz.inspector().open, null, { timeout: 3000 }).then(() => true, () => false);
        check(inspOpen, `${colorScheme}: clicking a card directly on desktop did not open the inspector`);
        if (inspOpen) await checkInspectorCloseClear(page, ex, `${colorScheme} 1440px`);
      }
    }

    // copy button, keyboard-activated
    await page.focus('[data-copy]'); await page.keyboard.press('Enter');
    const said = await page.waitForFunction(() => /Copied|⌘C|Ctrl\+C/.test(document.querySelector('.copy-label').textContent) && document.getElementById('live').textContent, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => '');
    check(/Copied npx @arjanj\/loupe|selected/.test(said), `${colorScheme}: copy was not announced`);
    // install-command copy icon in Getting started
    await page.focus('[data-copy="start-cmd"]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-copy="start-cmd"]').classList.contains('done') || /⌘C|Ctrl\+C/.test(document.querySelector('[data-copy="start-cmd"] .copy-label').textContent), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(60);
    check(/npx @arjanj\/loupe|selected/.test(await page.evaluate(() => document.getElementById('live').textContent)), `${colorScheme}: install copy button did not copy or announce`);
    check(!errs.length, `${colorScheme}: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // 1280px laptop viewport + prefers-reduced-motion: frame fits, hero coverage, and the map renders cleanly
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    const geom = await page.evaluate(() => {
      const fr = document.querySelector('#panel-excalidraw .frame').getBoundingClientRect();
      const visW = Math.max(0, Math.min(fr.right, innerWidth) - Math.max(fr.left, 0));
      const visH = Math.max(0, Math.min(fr.bottom, innerHeight) - Math.max(fr.top, 0));
      return { top: Math.round(fr.top), h: Math.round(fr.height), ratio: (visW * visH) / (innerWidth * innerHeight) };
    });
    check(geom.top <= 460, `1280px: frame starts at y=${geom.top}px (expected <= 460px)`);
    check(geom.h <= 800 - 64, `1280px: frame height ${geom.h}px exceeds viewport height - 64`);
    check(geom.ratio >= 0.35, `1280px: frame covers only ${(geom.ratio * 100).toFixed(1)}% of first viewport (expected >= 35%)`);
    const ex = await mapReady(page, 'excalidraw');
    check(ex && await opened(ex), '1280px reduced-motion: Excalidraw did not open a level deeper');
    await checkMapRendered(ex, '1280px reduced-motion Excalidraw');
    check(!errs.length, `1280px reduced-motion: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // short laptop viewports (#19): frame capped by viewport height so it stays <= vh - 64 with the full-screen link just below it
  for (const [vw, vh] of [[1280, 720], [1366, 768]]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    const geom = await page.evaluate(() => {
      const fr = document.querySelector('#panel-excalidraw .frame').getBoundingClientRect();
      const lr = document.getElementById('full-link').getBoundingClientRect();
      return {
        h: fr.height,
        fullBelow: lr.top >= fr.bottom,
      };
    });
    check(geom.h <= vh - 64, `${vw}x${vh}: frame height ${Math.round(geom.h)}px exceeds viewport height - 64 (${vh - 64}px)`);
    check(geom.fullBelow, `${vw}x${vh}: full-screen link should sit below the frame`);
    check(!errs.length, `${vw}x${vh}: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // tablet / narrow desktop (681-960px): the inspector opens and its Close button is reachable
  for (const width of [768, 900]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await waitAnims(page);
    const ex = await mapReady(page, 'excalidraw');
    check(ex && await opened(ex), `tablet ${width}px: Excalidraw map did not open a level deeper`);
    if (ex) {
      await ex.waitForFunction(() => !window.__sz.animating);
      await page.evaluate(() => document.querySelector('#panel-excalidraw .frame').scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(50);
      const { box, s } = await page.evaluate(() => {
        const frameEl = document.querySelector('#panel-excalidraw .frame');
        const ir = document.querySelector('#panel-excalidraw iframe').getBoundingClientRect();
        return { box: { x: ir.left, y: ir.top }, s: parseFloat(getComputedStyle(frameEl).getPropertyValue('--s')) || 1 };
      });
      const card = await ex.evaluate(() => window.__sz.visible().filter((v) => v.depth >= 1 && v.openness < 0.5 && v.alpha > 0.9 && v.sw > 60 && v.sx > 0 && v.sy > 0 && v.sy + v.sh / 2 > 70 && v.sx + v.sw < innerWidth && v.sy + v.sh < innerHeight - 100).sort((a, b) => b.sw * b.sh - a.sw * a.sh)[0]);
      check(card, `tablet ${width}px: no closed card visible in Excalidraw`);
      if (card) {
        await page.mouse.click(box.x + (card.sx + card.sw / 2) * s, box.y + (card.sy + card.sh / 2) * s);
        const inspOpen = await ex.waitForFunction(() => window.__sz.inspector().open, null, { timeout: 3000 }).then(() => true, () => false);
        check(inspOpen, `tablet ${width}px: clicking a card did not open the inspector`);
        if (inspOpen) {
          const hit = await checkInspectorCloseClear(page, ex, `tablet ${width}px`);
          if (hit && hit.isIframe) {
            await page.mouse.click(hit.px, hit.py);
            check(await ex.waitForFunction(() => !window.__sz.inspector().open, null, { timeout: 3000 }).then(() => true, () => false), `tablet ${width}px: clicking Close button did not close the inspector`);
          }
        }
      }
    }
    check(!errs.length, `tablet ${width}px: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // phone: no horizontal overflow down to 320px, touch wording, scaled map with unclipped HUD behind a veil, tap + pinch work
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.evaluate(() => document.fonts.ready);
  for (const w of [320, 360, 375, 390]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(50);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(ov <= 0, `horizontal overflow at ${w}px: ${ov}px`);
  }
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
console.log('site: ok (build, references, light + dark, hero fits with scroll gutters & >=35% & veil-free, clean canvas + caption link, native canvas, map opens deeper & renders, reduced-motion, short laptops, tablet, copy, phone: no overflow, unclipped HUD, tap + pinch)');
