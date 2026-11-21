'use strict';
(() => {
  const live = document.getElementById('live');
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };

  // Copy buttons: the Clipboard API where allowed (https, localhost), else a hidden textarea + execCommand (file://, old browsers).
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  const copyFallback = /Mac|iP(hone|ad|od)/i.test(navigator.platform || navigator.userAgent) ? 'Press ⌘C' : 'Press Ctrl+C';
  for (const btn of document.querySelectorAll('[data-copy]')) {
    const label = btn.querySelector('.copy-label');
    let timer;
    btn.addEventListener('click', async () => {
      const text = document.getElementById(btn.dataset.copy).innerText.trim(); // innerText: one line per command
      const ok = await copyText(text);
      if (!ok) { // last resort: select the command so ⌘C / Ctrl+C works
        const r = document.createRange(); r.selectNodeContents(document.getElementById(btn.dataset.copy));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      btn.classList.toggle('done', ok);
      label.textContent = ok ? 'Copied' : copyFallback;
      announce(ok ? `Copied ${text} to the clipboard` : 'Command selected. Press Control C or Command C to copy.');
      clearTimeout(timer);
      timer = setTimeout(() => { btn.classList.remove('done'); label.textContent = 'Copy'; }, 2000);
    });
  }

  // Demo tabs (WAI-ARIA tabs, automatic activation): arrows, Home and End move between tabs.
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function select(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(tabs[(to + n) % n], true);
    });
  });

  // Demo maps. Same-origin only (served over http); from file:// the frames are opaque and stay as they are.
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const viewer = (frame) => {
    try {
      const w = frame.contentWindow;
      return w && w.location.href.endsWith(frame.getAttribute('src')) && w.document.readyState === 'complete' && w.document.getElementById('seg') ? w : null;
    } catch { return null; }
  };
  // Open one level deeper than the viewer's first screen (one closed card), using the viewer's own level switcher.
  // Only once, only while the visitor hasn't moved the map yet, and without focusing anything or scrolling the page.
  const initCam = new WeakMap();
  function watch(frame) {
    const w = viewer(frame);
    if (!w || initCam.has(frame)) return;
    try {
      const c = w.__sz && w.__sz.camera;
      if (c && c.fitScale) initCam.set(frame, { x: c.x, y: c.y, rel: c.scale / c.fitScale });
      const skip = () => { frame.dataset.opened = '1'; };
      for (const ev of ['pointerdown', 'wheel', 'keydown']) w.document.addEventListener(ev, skip, { capture: true, once: true, passive: true });
    } catch { /* same-origin guard */ }
  }
  function deepen(frame) {
    const w = viewer(frame);
    if (!w || frame.dataset.opened) return;
    watch(frame);
    const c = w.__sz && w.__sz.camera, c0 = initCam.get(frame);
    if (c && c0 && (Math.abs(c.x - c0.x) > 1 || Math.abs(c.y - c0.y) > 1 || (c.fitScale && Math.abs(c.scale / c.fitScale - c0.rel) > 1e-3))) {
      frame.dataset.opened = '1';
      return;
    }
    frame.dataset.opened = '1';
    const seg = w.document.querySelectorAll('#seg button');
    if (seg.length < 2 || seg[0].getAttribute('aria-pressed') !== 'true') return;
    const sz = w.__sz, root = sz && sz.nodes && sz.nodes.find((n) => !n.parent);
    if (calm && root) sz.fitNode(root.id, false); // no flight when motion is unwelcome
    else seg[1].click();
  }
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.dataset.seen = e.isIntersecting ? '1' : '';
    for (const e of entries) if (e.isIntersecting) deepen(e.target);
  }, { threshold: 0.4 });
  for (const frame of document.querySelectorAll('.frame iframe')) {
    seen.observe(frame);
    watch(frame);
    frame.addEventListener('load', () => {
      watch(frame);
      if (frame.dataset.seen) setTimeout(() => deepen(frame), 250);
    });
  }

  // Narrow screens: render the map at a wider logical width and scale it down, so card titles and the map's controls fit.
  const MIN_W = 560;
  const fit = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const w = target.clientWidth, on = w > 0 && w < MIN_W;
      target.classList.toggle('scaled', on);
      target.style.setProperty('--lw', `${MIN_W}px`);
      target.style.setProperty('--s', on ? String(w / MIN_W) : '1');
    }
  });
  for (const frame of document.querySelectorAll('.frame')) fit.observe(frame);

  // Touch screens: a veil keeps the page scrollable until the visitor taps into the map.
  for (const veil of document.querySelectorAll('.veil')) {
    veil.addEventListener('click', () => {
      const f = veil.parentElement.querySelector('iframe');
      veil.remove();
      f?.focus({ preventScroll: true });
    });
  }

  // Fade/rise sections in as they scroll into view, only when motion is welcome. Content stays visible without JS.
  if (!calm && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    const items = document.querySelectorAll('.reveal');
    // anything already on screen shows at once: no flash of hidden content above the fold
    const vh = innerHeight;
    for (const el of items) { if (el.getBoundingClientRect().top < vh) el.classList.add('in'); else io.observe(el); }
    document.documentElement.classList.add('anim');
  }
})();
