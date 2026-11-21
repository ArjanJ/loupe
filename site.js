'use strict';
(() => {
  const live = document.getElementById('live');
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };

  // Promote entrance animation layers only while animating.
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!calm) {
    for (const el of document.querySelectorAll('.hero-in, .stage-wrap')) {
      el.classList.add('will-anim');
      el.addEventListener('animationend', () => el.classList.remove('will-anim'), { once: true });
    }
  }

  // Copy button: Clipboard API where allowed (https, localhost), else hidden textarea + execCommand (file://, older browsers).
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
      const target = document.getElementById(btn.dataset.copy);
      const text = target.innerText.trim();
      const ok = await copyText(text);
      if (!ok) {
        const r = document.createRange(); r.selectNodeContents(target);
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
  const fullLink = document.getElementById('full-link');
  const stage = document.getElementById('stage');

  // Demo maps. Same-origin only (served over http); from file:// the frames are opaque and stay as they are.
  const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  const viewer = (frame) => {
    if (!isHttp) return null;
    try {
      const w = frame.contentWindow;
      return w && w.location.href.endsWith(frame.getAttribute('src')) && w.document.readyState === 'complete' && w.document.getElementById('seg') ? w : null;
    } catch { return null; }
  };

  function syncInspectorState() {
    if (!stage) return;
    const activePanel = stage.querySelector('.panel:not([hidden]) iframe');
    const w = activePanel ? viewer(activePanel) : null;
    let open = false;
    try {
      const insp = w && w.document.getElementById('insp');
      open = !!(insp && insp.classList.contains('on'));
    } catch { /* same-origin guard */ }
    stage.classList.toggle('has-inspector', open);
  }

  function select(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (fullLink && tab.dataset.href) fullLink.setAttribute('href', tab.dataset.href);
    syncInspectorState();
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

  // Refine embedded viewer surface via CSSOM: match frame backdrop and calm the dot grid.
  const styledFrames = new WeakSet();
  function styleViewerSurface(frame) {
    const w = viewer(frame);
    if (!w) return;
    try {
      const doc = w.document;
      const root = doc.documentElement;
      const apply = () => {
        const dark = root.getAttribute('data-theme') === 'dark';
        const bg = dark ? '#141416' : '#fbfbfd';
        const grad = dark
          ? 'linear-gradient(180deg, #19191c 0%, #121214 100%)'
          : 'linear-gradient(180deg, #ffffff 0%, #f8f8fa 100%)';
        root.style.setProperty('--bg', bg);
        root.style.background = bg;
        if (doc.body) {
          doc.body.style.background = bg;
          doc.body.style.backgroundImage = grad;
        }
        // Calm the viewer's Freeform dot grid so the product frame feels crisp and quiet.
        for (const id of ['grid0', 'grid1']) {
          const g = doc.getElementById(id);
          if (g) g.style.visibility = 'hidden';
        }
      };
      apply();
      if (!styledFrames.has(frame)) {
        styledFrames.add(frame);
        const mo = new MutationObserver(() => apply());
        mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
        const insp = doc.getElementById('insp');
        if (insp) {
          const imo = new MutationObserver(() => syncInspectorState());
          imo.observe(insp, { attributes: true, attributeFilter: ['class'] });
        }
      }
    } catch { /* same-origin guard */ }
  }

  // Open one level deeper than the viewer's first screen (one closed card), using the viewer's own level switcher.
  // Only once, only while the visitor hasn't moved the map yet, and without focusing anything or scrolling the page.
  const initCam = new WeakMap();
  function watch(frame) {
    const w = viewer(frame);
    if (!w) return;
    styleViewerSurface(frame);
    if (initCam.has(frame)) return;
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
    const seg = [...w.document.querySelectorAll('#seg button')];
    if (seg.length < 2) return;
    // Viewer marks the initial level pressed on its first animation frame; retry on next frame if not painted yet.
    if (!seg.some((b) => b.getAttribute('aria-pressed') === 'true')) {
      w.requestAnimationFrame(() => deepen(frame));
      return;
    }
    const c = w.__sz && w.__sz.camera, c0 = initCam.get(frame);
    if (c && c0 && (Math.abs(c.x - c0.x) > 1 || Math.abs(c.y - c0.y) > 1 || (c.fitScale && Math.abs(c.scale / c.fitScale - c0.rel) > 1e-3))) {
      frame.dataset.opened = '1';
      return;
    }
    frame.dataset.opened = '1';
    if (seg[0].getAttribute('aria-pressed') !== 'true') return;
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

  // Narrow screens: render the map at a wider logical width and scale it down, so cards and the full viewer HUD (including breadcrumbs) fit without clipping.
  const MIN_W = 760;
  const fit = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const w = target.clientWidth, on = w > 0 && w < MIN_W;
      target.classList.toggle('scaled', on);
      target.style.setProperty('--lw', `${MIN_W}px`);
      target.style.setProperty('--s', on ? String(w / MIN_W) : '1');
    }
  });
  for (const frame of document.querySelectorAll('.frame')) fit.observe(frame);

  // Subtle nav hairline transition on scroll.
  const nav = document.getElementById('nav');
  if (nav) {
    const syncNav = () => nav.classList.toggle('scrolled', scrollY > 4);
    syncNav();
    addEventListener('scroll', syncNav, { passive: true });
  }

  // Touch screens: keep touch-only UI stable on touch devices and dismiss the veil on tap.
  if (matchMedia('(hover: none) and (pointer: coarse)').matches) document.documentElement.classList.add('is-touch');
  for (const veil of document.querySelectorAll('.veil')) {
    veil.addEventListener('click', () => {
      const f = veil.parentElement.querySelector('iframe');
      veil.remove();
      f?.focus({ preventScroll: true });
    });
  }
})();
