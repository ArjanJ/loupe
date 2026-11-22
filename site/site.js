'use strict';
(() => {
  const live = document.getElementById('live');
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Copy buttons: Clipboard API where allowed (https, localhost), else hidden textarea + execCommand (file://, older browsers).
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
  const specimenMeta = document.getElementById('specimen-meta');
  const stage = document.getElementById('stage');

  // Demo maps. Same-origin only (served over http); from file:// the frames are opaque and stay as they are.
  const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  const viewer = (frame) => {
    if (!isHttp) return null;
    const src = frame.getAttribute('src');
    if (!src) return null;
    try {
      const w = frame.contentWindow;
      return w && w.location.href.endsWith(src) && w.document.readyState === 'complete' && w.document.getElementById('seg') ? w : null;
    } catch { return null; }
  };

  // Narrow screens: render the map at a wider logical width and scale it down, so cards and the full viewer HUD (including breadcrumbs) fit without clipping.
  const MIN_W = 760;
  function scaleFrame(box) {
    if (!box) return;
    const w = box.clientWidth, on = w > 0 && w < MIN_W;
    box.classList.toggle('scaled', on);
    box.style.setProperty('--lw', `${MIN_W}px`);
    box.style.setProperty('--s', on ? String(w / MIN_W) : '1');
  }

  function isFrameSized(frame) {
    if (!frame || frame.closest('[hidden]')) return false;
    const r = frame.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const w = viewer(frame);
    return !w || (w.innerWidth > 0 && w.innerHeight > 0);
  }

  function cameraValid(w) {
    const c = w && w.__sz && w.__sz.camera;
    if (!c) return false;
    if (![c.x, c.y, c.scale, c.fitScale, c.maxScale].every(Number.isFinite)) return false;
    if (c.fitScale <= 1e-5 || c.maxScale <= 1e-5) return false;
    if (c.scale < c.fitScale * 0.25 || c.scale > c.maxScale * 1.01) return false;
    if (c.x < -800 || c.x > 2400 || c.y < -500 || c.y > 1500) return false;
    return true;
  }

  function recoverCamera(frame, w) {
    const sz = w && w.__sz;
    if (!sz) return;
    if (sz.camera && sz.camera.fitScale <= 1e-5) {
      w.dispatchEvent(new w.Event('resize'));
    }
    if (frame.dataset.zeroBoot === '1' || !cameraValid(w)) {
      delete frame.dataset.zeroBoot;
      const root = sz.nodes && sz.nodes.find((n) => !n.parent);
      if (frame.dataset.opened && root) sz.fitNode(root.id, false);
      else sz.home(false);
    }
  }

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

  function activatePanel(panel) {
    if (!panel || panel.hidden) return;
    scaleFrame(panel.querySelector('.frame'));
    const frame = panel.querySelector('iframe');
    if (!frame) return;
    if (!frame.getAttribute('src') && frame.dataset.src) {
      frame.setAttribute('src', frame.dataset.src);
      return;
    }
    requestAnimationFrame(() => {
      if (!isFrameSized(frame)) return;
      const w = viewer(frame);
      if (!w) return;
      recoverCamera(frame, w);
      watch(frame);
      if (!frame.dataset.opened && frame.dataset.seen) deepen(frame);
    });
  }

  function select(tab, focus) {
    let activePanel = null;
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      panel.hidden = !on;
      if (on) activePanel = panel;
    }
    if (fullLink && tab.dataset.href) fullLink.setAttribute('href', tab.dataset.href);
    if (specimenMeta && tab.dataset.meta) specimenMeta.textContent = tab.dataset.meta;
    activatePanel(activePanel);
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

  // In-page shortcuts to switch demo tab and scroll back to the stage.
  for (const btn of document.querySelectorAll('[data-switch-tab]')) {
    btn.addEventListener('click', () => {
      const tab = document.getElementById(btn.dataset.switchTab);
      if (!tab) return;
      select(tab);
      document.getElementById('demo')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    });
  }

  // Match embedded viewer surface to the specimen frame and calm the dot grid.
  const styledDocs = new WeakSet();
  function styleViewerSurface(frame) {
    const w = viewer(frame);
    if (!w) return;
    try {
      const doc = w.document;
      const root = doc.documentElement;
      const apply = () => {
        const dark = root.getAttribute('data-theme') === 'dark';
        const bg = dark ? '#161618' : '#ffffff';
        root.style.setProperty('--bg', bg);
        root.style.background = bg;
        if (doc.body) {
          doc.body.style.background = bg;
          doc.body.style.backgroundImage = 'none';
        }
        for (const id of ['grid0', 'grid1']) {
          const g = doc.getElementById(id);
          if (g) g.style.visibility = 'hidden';
        }
      };
      apply();
      if (!styledDocs.has(doc)) {
        styledDocs.add(doc);
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
  const watchedDocs = new WeakSet();
  function watch(frame) {
    const w = viewer(frame);
    if (!w) return;
    styleViewerSurface(frame);
    try {
      const doc = w.document;
      if (!watchedDocs.has(doc)) {
        watchedDocs.add(doc);
        const skip = () => { frame.dataset.opened = '1'; };
        for (const ev of ['pointerdown', 'wheel', 'keydown']) doc.addEventListener(ev, skip, { capture: true, once: true, passive: true });
      }
      const c = w.__sz && w.__sz.camera;
      if (!isFrameSized(frame) || !c || c.fitScale <= 1e-5) {
        frame.dataset.zeroBoot = '1';
        return;
      }
    } catch { /* same-origin guard */ }
  }
  function deepen(frame) {
    if (!isFrameSized(frame)) return;
    const w = viewer(frame);
    if (!w || frame.dataset.opened) return;
    recoverCamera(frame, w);
    watch(frame);
    const seg = [...w.document.querySelectorAll('#seg button')];
    if (seg.length < 2) return;
    if (!seg.some((b) => b.getAttribute('aria-pressed') === 'true')) {
      w.requestAnimationFrame(() => deepen(frame));
      return;
    }
    frame.dataset.opened = '1';
    if (seg[0].getAttribute('aria-pressed') !== 'true') return;
    const sz = w.__sz, root = sz && sz.nodes && sz.nodes.find((n) => !n.parent);
    if (calm && root) sz.fitNode(root.id, false);
    else seg[1].click();
  }
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.dataset.seen = e.isIntersecting ? '1' : '';
    for (const e of entries) if (e.isIntersecting) deepen(e.target);
  }, { threshold: 0.3 });
  for (const frame of document.querySelectorAll('.frame iframe')) {
    seen.observe(frame);
    watch(frame);
    frame.addEventListener('load', () => {
      watch(frame);
      if (frame.dataset.seen && isFrameSized(frame)) setTimeout(() => deepen(frame), 250);
    });
  }

  const fit = new ResizeObserver((entries) => {
    for (const { target } of entries) scaleFrame(target);
  });
  for (const frame of document.querySelectorAll('.frame')) fit.observe(frame);

  // Nav frost transition on scroll.
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
