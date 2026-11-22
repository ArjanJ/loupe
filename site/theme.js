'use strict';
// Appearance: System / Light / Dark, shared with the Loupe viewer through the same localStorage key, so the footer
// control and the demo map's own theme button stay in sync (each page hears the other's writes via the `storage` event).
// Loaded without `defer` in <head> so a saved choice is applied before first paint.
(() => {
  const KEY = 'loupe.appearance';
  const root = document.documentElement;
  const read = (v) => (v === 'light' || v === 'dark' ? v : 'system');
  let pref = 'system';
  try { pref = read(localStorage.getItem(KEY)); } catch { /* storage blocked: follow the OS */ }

  function apply() {
    if (pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    // keep the browser chrome colour in step with an explicit choice
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.dataset.auto ??= m.content;
      m.content = pref === 'dark' ? '#0f0f11' : pref === 'light' ? '#f6f6f4' : m.dataset.auto;
    }
    for (const b of document.querySelectorAll('#themeSeg button')) b.setAttribute('aria-pressed', String(b.dataset.pref === pref));
  }

  apply();
  addEventListener('storage', (e) => { if (e.key === KEY) { pref = read(e.newValue); apply(); } });
  document.addEventListener('DOMContentLoaded', () => {
    const seg = document.getElementById('themeSeg');
    if (!seg) return;
    seg.hidden = false;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pref]');
      if (!b) return;
      pref = read(b.dataset.pref);
      try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* not persisted */ }
      apply();
    });
    apply();
  });
})();
