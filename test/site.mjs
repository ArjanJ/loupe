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
for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) check(!/\sloading\s*=\s*"?lazy/i.test(m[0]), `demo iframe must not be loading="lazy" (breaks the Bramble fly animation, #16): ${m[0]}`);
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
// verify the inspector's Close button centre (mapped through --s) is hit-testable on the iframe, not covered by the Full screen pill
const checkInspectorCloseClear = async (page, frame, label) => {
  const synced = await page.waitForFunction(() => document.getElementById('stage')?.classList.contains('has-inspector'), null, { timeout: 3000 }).then(() => true, () => false);
  check(synced, `${label}: stage did not receive has-inspector class`);
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

    // desktop hero: 16:10 laptop-shaped frame starting in the upper viewport, visible share >= 40%, veil-free, controls overlaid inside frame
    const hero = await page.evaluate(() => {
      const frame = document.querySelector('#panel-excalidraw .frame');
      const iframe = document.querySelector('#panel-excalidraw iframe');
      const veil = document.querySelector('#panel-excalidraw .veil');
      const tabs = document.querySelector('.tabs');
      const full = document.getElementById('full-link');
      const r = iframe.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const tr = tabs.getBoundingClientRect();
      const lr = full.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return {
        top: Math.round(r.top),
        aspect: fr.width / fr.height,
        w: Math.round(fr.width),
        h: Math.round(fr.height),
        ratio: (visW * visH) / (innerWidth * innerHeight),
        veilHidden: getComputedStyle(veil).display === 'none',
        tabsInside: tr.top >= fr.top && tr.bottom <= fr.bottom && tr.left >= fr.left && tr.right <= fr.right,
        fullInside: lr.top >= fr.top && lr.bottom <= fr.bottom && lr.left >= fr.left && lr.right <= fr.right,
        fullAccessible: !!(full.textContent && full.textContent.trim().length > 0),
      };
    });
    check(hero.top <= 400, `${colorScheme}: desktop demo iframe starts at y=${hero.top}px (expected <= 400px)`);
    check(Math.abs(hero.aspect - 1.6) <= 0.05, `${colorScheme}: desktop 1440px frame aspect ratio is ${hero.aspect.toFixed(3)} (${hero.w}x${hero.h}, expected 1.6 ±0.05)`);
    check(hero.ratio >= 0.40, `${colorScheme}: desktop demo iframe covers only ${(hero.ratio * 100).toFixed(1)}% of first viewport (expected >= 40%)`);
    check(hero.veilHidden, `${colorScheme}: desktop touch veil should be hidden`);
    check(hero.tabsInside, `${colorScheme}: desktop demo tabs should be overlaid inside the frame`);
    check(hero.fullInside && hero.fullAccessible, `${colorScheme}: desktop full-screen button should be overlaid inside the frame with accessible name`);

    const ex = await mapReady(page, 'excalidraw');
    check(ex, `${colorScheme}: Excalidraw map did not load`);
    check(ex && await opened(ex), `${colorScheme}: Excalidraw map did not open a level deeper`);
    check(await page.evaluate(() => document.activeElement === document.body), `${colorScheme}: opening the map moved focus`);
    await checkMapRendered(ex, `${colorScheme} desktop Excalidraw`);

    // dot-grid calming applied cleanly without throwing
    if (ex) {
      const calmed = await ex.evaluate(() => {
        const g0 = document.getElementById('grid0');
        const g1 = document.getElementById('grid1');
        return !!(g0 && g1 && (getComputedStyle(g0).visibility === 'hidden' || parseFloat(getComputedStyle(g0).opacity) <= 0.35));
      });
      check(calmed, `${colorScheme}: Excalidraw dot grid was not calmed inside frame`);
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

    // tabs with the keyboard: switch to Bramble, verify rendered, switch back to Excalidraw, and to Bramble again
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
    await checkMapRendered(br, `${colorScheme} desktop Bramble`);
    await page.keyboard.press('End'); await page.keyboard.press('Home');
    check(await page.evaluate(() => document.activeElement.id === 'tab-excalidraw' && !document.getElementById('panel-excalidraw').hidden && document.getElementById('full-link').getAttribute('href') === 'demos/excalidraw.html'), `${colorScheme}: Home did not return to Excalidraw`);
    await page.waitForTimeout(100);
    await checkMapRendered(ex, `${colorScheme} desktop Excalidraw after return`);
    await page.click('#tab-bramble');
    await page.waitForTimeout(100);
    await checkMapRendered(br, `${colorScheme} desktop Bramble second visit`);
    await page.click('#tab-excalidraw');

    // copy button, keyboard-activated
    await page.focus('[data-copy]'); await page.keyboard.press('Enter');
    const said = await page.waitForFunction(() => /Copied|⌘C|Ctrl\+C/.test(document.querySelector('.copy-label').textContent) && document.getElementById('live').textContent, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => '');
    check(/Copied npx @arjanj\/loupe|selected/.test(said), `${colorScheme}: copy was not announced`);
    check(!errs.length, `${colorScheme}: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // 1280px laptop viewport + prefers-reduced-motion: 16:10 frame ratio, hero coverage, and both tabs render cleanly
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
      return { top: Math.round(fr.top), aspect: fr.width / fr.height, w: Math.round(fr.width), h: Math.round(fr.height), ratio: (visW * visH) / (innerWidth * innerHeight) };
    });
    check(geom.top <= 400, `1280px: frame starts at y=${geom.top}px (expected <= 400px)`);
    check(Math.abs(geom.aspect - 1.6) <= 0.05, `1280px: frame aspect ratio is ${geom.aspect.toFixed(3)} (${geom.w}x${geom.h}, expected 1.6 ±0.05)`);
    check(geom.ratio >= 0.40, `1280px: frame covers only ${(geom.ratio * 100).toFixed(1)}% of first viewport (expected >= 40%)`);
    const washAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.bg-wash'), '::before').animationName);
    check(washAnim === 'none', `1280px reduced-motion: wash animation should be none, got ${washAnim}`);
    const ex = await mapReady(page, 'excalidraw');
    check(ex && await opened(ex), '1280px reduced-motion: Excalidraw did not open a level deeper');
    await checkMapRendered(ex, '1280px reduced-motion Excalidraw');
    await page.click('#tab-bramble');
    const br = await mapReady(page, 'bramble');
    check(br && await opened(br), '1280px reduced-motion: Bramble did not open a level deeper');
    await checkMapRendered(br, '1280px reduced-motion Bramble');
    check(!errs.length, `1280px reduced-motion: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // short laptop viewports (#19): 16:10 frame capped by viewport height so it stays <= vh - 64 with controls inside
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
      const tr = document.querySelector('.tabs').getBoundingClientRect();
      const lr = document.getElementById('full-link').getBoundingClientRect();
      return {
        w: fr.width,
        h: fr.height,
        aspect: fr.width / fr.height,
        tabsInside: tr.top >= fr.top && tr.bottom <= fr.bottom && tr.left >= fr.left && tr.right <= fr.right,
        fullInside: lr.top >= fr.top && lr.bottom <= fr.bottom && lr.left >= fr.left && lr.right <= fr.right,
      };
    });
    check(Math.abs(geom.aspect - 1.6) <= 0.05, `${vw}x${vh}: frame aspect ratio is ${geom.aspect.toFixed(3)} (${Math.round(geom.w)}x${Math.round(geom.h)}, expected 1.6 ±0.05)`);
    check(geom.h <= vh - 64, `${vw}x${vh}: frame height ${Math.round(geom.h)}px exceeds viewport height - 64 (${vh - 64}px)`);
    check(geom.tabsInside && geom.fullInside, `${vw}x${vh}: overlay controls fell outside capped frame`);
    check(!errs.length, `${vw}x${vh}: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // switching to Bramble immediately before Excalidraw finishes loading: both tabs must still render cleanly
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('#tab-bramble');
    const br = await mapReady(page, 'bramble');
    check(br && await opened(br), 'early-switch: Bramble did not open a level deeper');
    await checkMapRendered(br, 'early-switch Bramble');
    await page.click('#tab-excalidraw');
    const ex = await mapReady(page, 'excalidraw');
    check(ex && await opened(ex), 'early-switch: Excalidraw did not open a level deeper after returning');
    await checkMapRendered(ex, 'early-switch Excalidraw');
    check(!errs.length, `early-switch: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // late first switch: Bramble first loaded >= 2 s after page load (regression for #16: lazy hidden iframe -> camera scale Infinity, blank map)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const ex = await mapReady(page, 'excalidraw');
    check(ex && await opened(ex), 'late-switch: Excalidraw did not open a level deeper');
    await page.waitForTimeout(3000);
    await page.click('#tab-bramble');
    const br = await mapReady(page, 'bramble');
    check(br, 'late-switch: Bramble map did not load');
    check(br && await opened(br), 'late-switch: Bramble did not open a level deeper');
    // the broken fly self-heals after ~4 s, so sample the camera during the fly instead of only after it settles
    if (br) {
      const bad = await br.evaluate(() => new Promise((res) => {
        const t0 = performance.now();
        const tick = () => {
          const s = window.__sz.camera.scale;
          if (!Number.isFinite(s)) return res({ t: Math.round(performance.now() - t0), scale: String(s) });
          if (performance.now() - t0 > 2500) return res(null);
          setTimeout(tick, 50);
        };
        tick();
      }));
      check(!bad, `late-switch Bramble: camera scale went non-finite during the fly (${JSON.stringify(bad)})`);
      check(await br.waitForFunction(() => !window.__sz.animating, null, { timeout: 4000 }).then(() => true, () => false), 'late-switch Bramble: fly animation did not settle within 4 s');
    }
    await checkMapRendered(br, 'late-switch Bramble');
    check(!errs.length, `late-switch: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // tablet / narrow desktop (681-960px): opening the inspector must never leave the Full screen pill covering the Close button
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
    if (width === 768) {
      await page.click('#tab-bramble');
      const br = await mapReady(page, 'bramble');
      check(br && await opened(br), 'tablet 768px: Bramble map did not open a level deeper');
      await checkMapRendered(br, 'tablet 768px Bramble');
    }
    check(!errs.length, `tablet ${width}px: ${errs.join(' | ')}`);
    await ctx.close();
  }

  // phone: no horizontal overflow down to 320px, touch wording, scaled map with unclipped HUD behind a veil, tap + pinch + Bramble tab work
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
  const shown = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none', sel);
  check(await shown('.hint.touch') && !(await shown('.hint.fine')), 'touch hint not shown on a touch screen');
  const mobileWashAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.bg-wash'), '::before').animationName);
  check(mobileWashAnim === 'none', `phone: wash animation should be static (none), got ${mobileWashAnim}`);
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

    // switch to Bramble on mobile, back to Excalidraw, and to Bramble again
    await page.tap('#tab-bramble');
    const fbr = await mapReady(page, 'bramble');
    check(fbr && await opened(fbr), 'phone: Bramble map did not open a level deeper');
    await checkMapRendered(fbr, 'phone Bramble');
    await page.tap('#tab-excalidraw');
    await page.waitForTimeout(100);
    await checkMapRendered(fx, 'phone Excalidraw after return');
    await page.tap('#tab-bramble');
    await page.waitForTimeout(100);
    await checkMapRendered(fbr, 'phone Bramble second visit');
  }
  check(!errs.length, `phone: ${errs.join(' | ')}`);
  await ctx.close();
} finally { await browser.close(); server.close(); }

if (fails.length) { console.error('site: FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('site: ok (build, references, light + dark, 16:10 hero >=40% & veil-free, overlays, dot-calming, maps open deeper & render on Bramble/Excalidraw switching, reduced-motion, early-switch, late-switch, tablet, copy, phone: no overflow, unclipped HUD, touch hint, tap + pinch + Bramble)');
