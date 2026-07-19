/**
 * Bowcast theme controller: wires up .theme-toggle switches and keeps the
 * <html data-theme> in sync with the user's choice (localStorage). Dark is
 * the default when no choice is saved. The initial value is set by an inline
 * <head> script (see THEME_INIT below, inlined per page) so there is no flash
 * of the wrong theme before this module loads.
 */

const KEY = 'bowcast-theme';

/**
 * Inline this in each page's <head>, before any stylesheet, so the theme is
 * applied before first paint:
 *   <script>(function(){ ... })();</script>
 */
export const THEME_INIT = `(function(){try{var t=localStorage.getItem('bowcast-theme');if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

const SUN = '<span class="tt-icon tt-sun" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"></path></svg></span>';
const MOON = '<span class="tt-icon tt-moon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg></span>';
const KNOB_SUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"></path></svg>';
const KNOB_MOON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';

function current() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function apply(theme, buttons) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#12151b' : '#f5f2ea');
  // Pages with theme-dependent resources (the map's basemap tiles) listen here.
  document.dispatchEvent(new CustomEvent('bowcast-themechange', { detail: { theme } }));
  const dark = theme === 'dark';
  buttons.forEach((btn) => {
    btn.setAttribute('aria-checked', String(dark));
    btn.title = dark ? 'Switch to light' : 'Switch to dark';
    const knob = btn.querySelector('.tt-knob');
    if (knob) knob.innerHTML = dark ? KNOB_MOON : KNOB_SUN;
    // Compact variant: one icon showing the theme you would switch TO.
    if (btn.classList.contains('theme-mini')) btn.innerHTML = dark ? KNOB_SUN : KNOB_MOON;
  });
}

/**
 * Fill and wire every theme switch on the page. Two variants:
 * `.theme-toggle` is the full 62px sun/moon switch; `.theme-mini` is a
 * compact icon button for dense headers. Call once on load.
 */
export function initThemeToggles() {
  const buttons = [...document.querySelectorAll('.theme-toggle, .theme-mini')];
  buttons.forEach((btn) => {
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', 'Toggle dark mode');
    if (!btn.classList.contains('theme-mini')) {
      btn.innerHTML = `${SUN}${MOON}<span class="tt-knob"></span>`;
    }
    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      apply(next, buttons);
    });
  });
  apply(current(), buttons);
}
