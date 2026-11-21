// Acceptance + interaction checks for a built Loupe view.
// Usage: [SCHEME=dark] node test/acceptance.mjs <view.html>. Targets are picked from the view itself:
// PKG = the top-level group with the most cross-boundary relations, MOD = its busiest child.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from './_playwright.mjs';
if (!process.argv[2]) { console.error('usage: node test/acceptance.mjs <view.html>'); process.exit(2); }
const HTML = 'file://' + resolve(process.argv[2]);
const browser = await chromium.launch();
const errors = [];
const results = {};
const ALLOWED_PROTO = /^(file|data|blob|about):/i;
async function open(colorScheme = 'light') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
  page.on('request', (req) => { if (!ALLOWED_PROTO.test(req.url())) errors.push(`network request: ${req.url()}`); });
  await page.goto(HTML); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300);
  return page;
}
// SCHEME=dark runs every check below against the dark palette
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
results.scheme = SCHEME;
const page = await open(SCHEME);

const { PKG, MOD, PKG_LABEL } = await page.evaluate(() => {
  const sz = window.__sz, deg = (n) => sz.degree(n.id);
  const pk = sz.nodes.filter((n) => n.depth === 1 && n.children.length && !n.external).sort((a, b) => deg(b) - deg(a))[0];
  const md = [...pk.children].filter((c) => !c.quiet).sort((a, b) => deg(b) - deg(a))[0];
  return { PKG: pk.id, MOD: md.id, PKG_LABEL: String(pk.label) };
});
results.targets = { PKG, MOD };
// 1. first screen is one closed root card, centred
results.home = await page.evaluate(() => { const v = window.__sz.visible(); const r = v.find((x) => x.id === 'system'); return { visibleCards: v.length, rootOpenness: +r.openness.toFixed(3), centred: Math.abs(r.sx + r.sw / 2 - innerWidth / 2) < 2, level: window.__sz.hud().level }; });

// 2. text never overflows its card and is never drawn below 11px (light + dark), sweeping fits, mid-splits and a zoom ramp
const sweep = () => page.evaluate(() => {
  const sz = window.__sz, W = innerWidth, H = innerHeight;
  let frames = 0, drawn = 0; const bad = [];
  const check = () => { const r = sz.checkText(); frames++; drawn += r.drawn; bad.push(...r.violations); };
  const targets = sz.nodes.filter((n, i) => n.depth <= 2 || (n.depth === 3 && i % 4 === 0));
  for (const n of targets) {
    const base = Math.min(W / n.w, H / n.h);
    for (const f of [0.3, 0.5, 0.65, 0.8, 0.9, 1.3, 2.5]) { sz.setCamera(n.x + n.w / 2, n.y + n.h / 2, base * f); check(); }
  }
  const c = sz.camera;
  for (let s = c.fitScale * 0.3; s < c.maxScale; s *= 1.12) { sz.setCamera(800, 500, s); check(); }
  return { frames, linesDrawn: drawn, violations: bad.length, sample: bad.slice(0, 5) };
});
results.text = await sweep();

// 3. zoom cap: at max zoom the smallest leaf still fits on screen
results.zoomCap = await page.evaluate(() => {
  const sz = window.__sz, leaves = sz.nodes.filter((n) => !n.children.length);
  const small = leaves.reduce((a, b) => (Math.max(a.w / innerWidth, a.h / innerHeight) < Math.max(b.w / innerWidth, b.h / innerHeight) ? a : b));
  sz.setCamera(small.x + small.w / 2, small.y + small.h / 2, 1e9);
  const r = sz.rect(small.id);
  return { leaf: small.id, maxScale: +sz.camera.maxScale.toFixed(2), fitsOnScreen: r.sw <= innerWidth && r.sh <= innerHeight, size: [Math.round(r.sw), Math.round(r.sh)] };
});

// 4. double-click a tall box: spring flight ends with it fully on screen
results.dblclickTall = await (async () => {
  const id = await page.evaluate(() => { const c = window.__sz.nodes.filter((n) => n.depth >= 1 && n.depth <= 3 && n.children.length).sort((a, b) => b.h / b.w - a.h / a.w)[0]; window.__sz.fitNode(c.parent.id, false); return c.id; });
  const r0 = await page.evaluate((id) => window.__sz.rect(id), id);
  await page.mouse.dblclick(r0.sx + r0.sw / 2, r0.sy + r0.sh / 2);
  await page.waitForTimeout(1000);
  const r = await page.evaluate((id) => window.__sz.rect(id), id);
  return { id, fullyOnScreen: r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 1440 && r.sy + r.sh <= 900, rect: [r.sx, r.sy, r.sw, r.sh].map(Math.round) };
})();

// 5. relationships: a few typed edges at rest; hover lights a card's edges with labels and returns to rest;
//    click opens the inspector; the legend and flows popovers open and close with Escape.
const snap = async () => createHash('sha1').update(await page.screenshot()).digest('hex');
results.relations = await (async () => {
  const out = {};
  await page.evaluate(() => { window.__sz.select(null); window.__sz.fitNode('system', false); });
  await page.mouse.move(2, 2); await page.waitForTimeout(900);
  const rest = await page.evaluate(() => window.__sz.edges());
  out.restPackages = { count: rest.length, kinds: [...new Set(rest.map((e) => e.kind))], sample: rest.slice(0, 7).map((e) => `${e.from} → ${e.to} [${e.kind}] ${e.label}`) };
  await page.evaluate((p) => window.__sz.fitNode(p, false), PKG); await page.waitForTimeout(900);
  out.restModules = (await page.evaluate(() => window.__sz.edges())).length;
  const h0 = await snap();
  const r = await page.evaluate((m) => window.__sz.rect(m), MOD);
  await page.mouse.move(r.sx + r.sw * 0.5, r.sy + r.sh * 0.5); await page.waitForTimeout(500);
  const hov = await page.evaluate(() => window.__sz.edges());
  out.hover = { edges: hov.length, touchingCard: hov.filter((e) => e.from === MOD || e.to === MOD).length, changesCanvas: (await snap()) !== h0 };
  await page.mouse.move(2, 2); await page.waitForTimeout(900);
  out.hover.returnsToRest = (await snap()) === h0;
  await page.mouse.click(r.sx + r.sw * 0.5, r.sy + r.sh * 0.5); await page.waitForTimeout(500);
  await page.locator('#insp .disc').first().click(); await page.waitForTimeout(250);
  const ins = await page.evaluate(() => window.__sz.inspector());
  out.inspector = { open: ins.open, rows: ins.rows, hasTalksTo: ins.text.includes('Talks to'), hasUsedBy: ins.text.includes('Used by'), hasEvidence: /\.\w+:\d+/.test(ins.text) };
  await page.locator('#c').focus(); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  out.inspector.escCloses = !(await page.evaluate(() => window.__sz.inspector())).open;
  await page.locator('#legendBtn').click(); await page.waitForTimeout(300);
  const lg = await page.evaluate(() => window.__sz.popover());
  out.legend = { open: lg.kind === 'legend', kinds: ['HTTP', 'Async', 'Data', 'External', 'Code'].filter((k) => lg.text.includes(k)).length };
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  out.legend.escCloses = (await page.evaluate(() => window.__sz.popover())).kind === null;
  await page.locator('#flowsBtn').click(); await page.waitForTimeout(300);
  out.flows = { list: await page.evaluate(() => window.__sz.flows()) };
  await page.locator('#pop .row').first().click(); await page.waitForTimeout(1600);
  const fi = await page.evaluate(() => window.__sz.inspector());
  await page.locator('#c').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  const pos1 = await page.locator('#insp .pos').textContent();
  await page.keyboard.press(' '); await page.waitForTimeout(200);
  const paused = await page.locator('#insp .transport button').nth(1).getAttribute('aria-label');
  await page.keyboard.press(' '); await page.waitForTimeout(200);
  out.flows.transport = { afterNext: pos1, pausedButtonSays: paused };
  out.flows.playing = { panel: fi.open && fi.text.startsWith('Flow'), steps: fi.rows === 0 ? (fi.text.match(/→/g) || []).length : fi.rows, animating: await page.evaluate(() => window.__sz.edgeAnimating), label: await page.locator('#flowsLabel').textContent() };
  // frame time while a flow plays (camera tour + pulse)
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 240) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await page.waitForTimeout(4500);
  out.flows.perf = await page.evaluate(() => { const f = window.__frames.slice(5).sort((a, b) => a - b); return { frames: f.length, medianMs: +f[Math.floor(f.length / 2)].toFixed(1), p95Ms: +f[Math.floor(f.length * 0.95)].toFixed(1) }; });
  await page.locator('#c').focus(); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  out.flows.escStops = (await page.locator('#flowsLabel').textContent()) === 'Flows' && !(await page.evaluate(() => window.__sz.edgeAnimating));
  return out;
})();

// 6. HUD + keyboard
const hud = () => page.evaluate(() => window.__sz.hud());
results.keyboard = {};
await page.evaluate((m) => window.__sz.fitNode(m, false), MOD); await page.waitForTimeout(100);
results.keyboard.start = await hud();
await page.locator('#crumbs').getByRole('button', { name: PKG_LABEL, exact: true }).click(); await page.waitForTimeout(1000);
results.keyboard.afterCrumbClick = await hud();
await page.locator('#c').focus();
await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
results.keyboard.afterEsc = await hud();
await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
results.keyboard.afterSecondEsc = await hud();
await page.locator('#seg button').nth(2).click(); await page.waitForTimeout(1000);
results.keyboard.afterSegmentModules = await hud();
const before = await page.evaluate(() => window.__sz.camera.x);
await page.locator('#c').focus();
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
results.keyboard.arrowRightPans = (await page.evaluate(() => window.__sz.camera.x)) > before;
await page.locator('#fit').click(); await page.waitForTimeout(1000);
results.keyboard.afterFitButton = await hud();

// 7. frame time during a continuous wheel zoom at DPR 2
results.perf = await (async () => {
  await page.evaluate(() => window.__sz.home(false));
  await page.mouse.move(720, 450);
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 400) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  for (let i = 0; i < 120; i++) { await page.mouse.wheel(0, -12); await page.waitForTimeout(16); }
  await page.waitForTimeout(500);
  return page.evaluate(() => { const f = window.__frames.slice(5).sort((a, b) => a - b); return { frames: f.length, medianMs: +f[Math.floor(f.length / 2)].toFixed(1), p95Ms: +f[Math.floor(f.length * 0.95)].toFixed(1) }; });
})();
results.perfFocused = await (async () => {
  await page.evaluate(([p, m]) => { window.__sz.fitNode(p, false); window.__sz.select(m); }, [PKG, MOD]);
  await page.mouse.move(720, 450);
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 300) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, i < 30 ? -14 : 14); await page.waitForTimeout(16); }
  await page.waitForTimeout(500);
  return page.evaluate(() => { const f = window.__frames.slice(5).sort((a, b) => a - b); return { frames: f.length, medianMs: +f[Math.floor(f.length / 2)].toFixed(1), p95Ms: +f[Math.floor(f.length * 0.95)].toFixed(1) }; });
})();
await page.close();

const other = await open(SCHEME === 'dark' ? 'light' : 'dark');
results.textOtherScheme = await (async () => { const r = await other.evaluate((ids) => { const sz = window.__sz; let bad = 0, drawn = 0; for (const id of ids) { sz.fitNode(id, false); const r = sz.checkText(); bad += r.violations.length; drawn += r.drawn; } return { drawn, violations: bad }; }, ['system', PKG, MOD]); return r; })();
await other.close();

// 8. appearance control: System -> Light -> Dark, remembered across reloads, applied before first paint,
//    the canvas repaints in the same task as the click, and a live OS change applies only while on System
results.appearance = await (async () => {
  try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(e.message));
  // Record data-theme the moment <body> appears (after the <head> bootstrap, before first paint).
  // Observe first, then read: a late observer is the only race, and DOMContentLoaded would be too late
  // to prove the bootstrap ran before first paint (the main script may already have called applyTheme).
  await ctx.addInitScript(() => {
    const rec = () => { if (document.body && window.__themeAtBody === undefined) window.__themeAtBody = document.documentElement.getAttribute('data-theme'); };
    new MutationObserver((m, o) => { if (document.body) { rec(); o.disconnect(); } }).observe(document.documentElement || document, { childList: true, subtree: true });
    rec();
  });
  const ready = () => pg.waitForFunction(() => window.__sz && window.__themeAtBody !== undefined && document.documentElement.getAttribute('data-theme'), { timeout: 8000 });
  await pg.goto(HTML, { waitUntil: 'domcontentloaded' }); await ready();
  const st = () => pg.evaluate(() => window.__sz.theme());
  // a pixel inside the closed root card's left padding, read synchronously right after the click
  const clickAndSample = () => pg.evaluate(() => { document.getElementById('themeBtn').click(); const c = document.getElementById('c'); const r = window.__sz.rect('system'), k = c.width / innerWidth; const d = c.getContext('2d').getImageData(Math.round((r.sx + 6) * k), Math.round((r.sy + r.sh / 2) * k), 1, 1).data; return { ...window.__sz.theme(), px: [d[0], d[1], d[2]], label: document.getElementById('themeBtn').getAttribute('aria-label') }; });
  const out = { initial: await st() };
  out.click1 = await clickAndSample();
  out.click2 = await clickAndSample();
  out.storedBeforeReload = await pg.evaluate(() => localStorage.getItem('loupe.appearance'));
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  out.afterReload = { ...(await st()), themeAtBodyCreation: await pg.evaluate(() => window.__themeAtBody) };
  await pg.emulateMedia({ colorScheme: 'light' }); await pg.waitForTimeout(100);
  out.pinnedDarkIgnoresOsLight = (await st()).resolved === 'dark';
  out.click3 = await clickAndSample();
  await pg.emulateMedia({ colorScheme: 'dark' }); await pg.waitForTimeout(100);
  out.systemFollowsOsDark = await pg.evaluate(() => { const c = document.getElementById('c'); const r = window.__sz.rect('system'), k = c.width / innerWidth; const d = c.getContext('2d').getImageData(Math.round((r.sx + 6) * k), Math.round((r.sy + r.sh / 2) * k), 1, 1).data; return { ...window.__sz.theme(), px: [d[0], d[1], d[2]] }; });
  out.storedAfterSystem = await pg.evaluate(() => localStorage.getItem('loupe.appearance'));
  out.ok = out.initial.pref === 'system' && out.click1.pref === 'light' && out.click2.resolved === 'dark' && out.click2.px[0] < 60 && out.click1.px[0] > 200
    && out.afterReload.pref === 'dark' && out.afterReload.themeAtBodyCreation === 'dark' && out.pinnedDarkIgnoresOsLight
    && out.click3.pref === 'system' && out.click3.resolved === 'light' && out.systemFollowsOsDark.resolved === 'dark' && out.systemFollowsOsDark.px[0] < 60 && out.storedAfterSystem === null;
  await ctx.close();
  return out;
  } catch (e) {
    try { await ctx.close(); } catch (e2) {}
    return { ok: false, error: String(e && e.message || e) };
  }
})();

// 9. skewed / non-monotonic rAF clock: camera flight must keep scale and center finite and in range (#18)
results.skewedClockFly = await (async () => {
  let ctx;
  try {
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      const orig = window.requestAnimationFrame.bind(window);
      let calls = 0;
      window.requestAnimationFrame = (cb) => orig((ts) => {
        // Skew rAF timestamps 3 s behind performance.now() and inject a backward step to test both lazy t0 and u clamping.
        const jitter = calls++ === 2 ? -120 : 0;
        cb(ts - 3000 + jitter);
      });
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(HTML, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => !!window.__sz && window.__sz.nodes.length > 0, null, { timeout: 8000 });
    await pg.waitForTimeout(150);
    // Start sampling before clicking the second level in #seg so every animation frame is checked.
    const samplePromise = pg.evaluate(() => new Promise((res) => {
      const bad = [];
      let samples = 0;
      const t0 = performance.now();
      const check = () => {
        const c = window.__sz.camera;
        samples++;
        const ok = [c.x, c.y, c.scale, c.fitScale, c.maxScale].every(Number.isFinite)
          && c.scale >= c.fitScale * 0.25 && c.scale <= c.maxScale * 1.01;
        if (!ok) bad.push({ t: Math.round(performance.now() - t0), x: c.x, y: c.y, scale: c.scale });
        if (performance.now() - t0 > 1200 && !window.__sz.animating) return res({ samples, bad, final: { x: c.x, y: c.y, scale: c.scale, fitScale: c.fitScale, maxScale: c.maxScale } });
        if (performance.now() - t0 > 3500) return res({ samples, bad, timedOut: true, final: { x: c.x, y: c.y, scale: c.scale, fitScale: c.fitScale, maxScale: c.maxScale } });
        setTimeout(check, 20);
      };
      setTimeout(check, 10);
    }));
    await pg.locator('#seg button').nth(1).click();
    const trace = await samplePromise;
    const f = trace.final;
    const finalOk = [f.x, f.y, f.scale].every(Number.isFinite) && f.scale >= f.fitScale * 0.5 && f.scale <= f.maxScale * 1.01;
    const ok = !trace.timedOut && trace.bad.length === 0 && finalOk && trace.samples >= 10;
    await ctx.close();
    return { ok, samples: trace.samples, badCount: trace.bad.length, timedOut: !!trace.timedOut, finalScale: Number.isFinite(f.scale) ? +f.scale.toFixed(4) : String(f.scale) };
  } catch (e) {
    try { await ctx?.close(); } catch (e2) {}
    return { ok: false, error: String(e && e.message || e) };
  }
})();
// 10. child-count pluralisation (singular for 1, plural for > 1)
results.pluralisation = await (async () => {
  const pg = await open(SCHEME);
  const res = await pg.evaluate(() => {
    const singles = [], bad = [];
    for (const n of window.__sz.nodes) {
      if (!n.children.length) continue;
      const kids = n.children.filter((c) => !c.quiet).length + n.children.filter((c) => c.quiet).reduce((s, c) => s + (parseInt(String(c.label).replace(/\D+/g, ''), 10) || 0), 0);
      if (kids === 1) {
        singles.push(n.meta);
        if (!/^1 (package|module|file|service|datastore|library|repo|interface|item)$/.test(n.meta)) bad.push({ id: n.id, meta: n.meta });
      } else if (kids > 1) {
        if (!/^\d+ (packages|modules|files|services|datastores|libraries|repos|interfaces|items)$/.test(n.meta)) bad.push({ id: n.id, meta: n.meta });
      }
    }
    return { ok: bad.length === 0, singleCount: singles.length, sampleSingles: singles.slice(0, 5), bad };
  });
  await pg.close();
  return res;
})();
results.consoleErrors = errors;
console.log(JSON.stringify(results, null, 2));
// exit non-zero on any explicit failure: an `ok: false`, a text violation, or a console error
const failures = [];
(function scan(v, path) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'ok' && x === false) failures.push(path || 'root');
    else if (k === 'violations' && (Array.isArray(x) ? x.length : +x > 0)) failures.push(`${path}.violations`);
    else scan(x, path ? `${path}.${k}` : k);
  }
})(results, '');
if (errors.length) failures.push(`console: ${errors.slice(0, 3).join(' | ')}`);
console.error(failures.length ? `FAIL ${failures.join(', ')}` : 'PASS');
process.exitCode = failures.length ? 1 : 0;
await browser.close();
