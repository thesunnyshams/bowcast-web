/*
 * Bowcast "add to home screen" prompt.
 *
 * A single self-contained, dependency-free script that injects its own styles
 * and a dismissible bottom card. It handles two install paths:
 *   - Chromium: the native beforeinstallprompt event (Android, desktop Chrome
 *     and Edge). We stash the event, then offer an "Add app" button that
 *     replays it.
 *   - iOS Safari: no install API exists, so we show instructions for the
 *     Share menu instead.
 *
 * It renders nothing at all inside the packaged Capacitor apps (there is
 * nothing to install), when already running installed, or when the user has
 * installed or recently dismissed it.
 *
 * Theming is entirely token-driven (public/theme.css), so the card follows the
 * page between light and dusk automatically.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // Packaged mobile app: the store build is the install, so never prompt.
  if (window.Capacitor) return;

  var LS_DONE = 'bowcast-install-done';
  var LS_DISMISSED = 'bowcast-install-dismissed';
  var SNOOZE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  var ENGAGE_MS = 10 * 1000;                // let the visitor settle in first

  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { window.localStorage.setItem(key, val); } catch (e) {} }
  function media(query) { try { return window.matchMedia && window.matchMedia(query).matches; } catch (e) { return false; } }

  // Already installed / launched from the home screen.
  if (media('(display-mode: standalone)') || window.navigator.standalone === true) return;

  // Installed before, or dismissed within the snooze window.
  if (lsGet(LS_DONE)) return;
  var dismissedAt = Number(lsGet(LS_DISMISSED));
  if (dismissedAt && (Date.now() - dismissedAt) < SNOOZE_MS) return;

  // ── Path detection ────────────────────────────────────────────────────
  var ua = window.navigator.userAgent || '';

  // iPhone / iPad, including iPadOS which reports as "Macintosh" but exposes
  // a touchscreen. A real Mac has maxTouchPoints of 0.
  var isIOS = /iPhone|iPad|iPod/.test(ua)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);

  // Only true mobile Safari can add to the home screen. Other iOS browsers and
  // common in-app webviews wrap WebKit but lack the Share > Add flow.
  var notSafari = /CriOS|FxiOS|EdgiOS|GSA|Instagram|FBAN|FBAV|Line/.test(ua);
  var iosSafari = isIOS && !notSafari;

  // Chromium exposes the install event hook on window.
  var chromiumCapable = 'onbeforeinstallprompt' in window;

  // Neither install path is available here (for example desktop Safari or
  // Firefox): stay silent.
  if (!chromiumCapable && !iosSafari) return;

  var reduceMotion = media('(prefers-reduced-motion: reduce)');

  var deferredPrompt = null; // stashed beforeinstallprompt event
  var card = null;
  var timer = null;
  var shown = false;

  // The three arcs on an --ink baseline, matching the site header mark. Each
  // arc keeps a light-theme fallback hex because the map page's light
  // stylesheet does not define --violet / --teal / --amber; the token still
  // wins on every page and theme that does define it (including both dusk
  // themes), so the bow stays coloured everywhere the card can appear.
  var ARC_SVG = '<svg viewBox="-4 -3 48 32" aria-hidden="true">'
    + '<path d="M3 22 H37" stroke="var(--ink)" stroke-width="1.6"/>'
    + '<path d="M5 22 A15 15 0 0 1 35 22" fill="none" stroke="var(--violet, #7a68d9)" stroke-width="3" stroke-linecap="round"/>'
    + '<path d="M9 22 A11 11 0 0 1 31 22" fill="none" stroke="var(--teal, #2f9e8f)" stroke-width="3" stroke-linecap="round"/>'
    + '<path d="M13 22 A7 7 0 0 1 27 22" fill="none" stroke="var(--amber, #e0922e)" stroke-width="3" stroke-linecap="round"/>'
    + '</svg>';

  function injectStyles() {
    if (document.getElementById('bc-install-style')) return;
    var style = document.createElement('style');
    style.id = 'bc-install-style';
    style.textContent = [
      /*
       * z-index 900 keeps the card above the map surface and its Leaflet
       * controls (trapped inside #map-container, a fixed stacking context that
       * sits at the root's z auto) and above the bottom #day-bar (800), while
       * staying below the fixed header (1000), the banners (999) and the
       * location / alert popovers (1100+), so nothing critical is covered.
       */
      '.bc-install-card{',
      '  position:fixed;left:50%;z-index:900;',
      '  bottom:calc(16px + env(safe-area-inset-bottom, 0px));',
      '  transform:translateX(-50%);',
      '  width:min(420px, calc(100vw - 32px));box-sizing:border-box;',
      '  background:var(--plaque);border:1px solid var(--line);border-radius:14px;',
      '  box-shadow:0 12px 34px rgba(0,0,0,.20), 0 2px 8px rgba(0,0,0,.12);',
      '  padding:16px 16px 14px;color:var(--ink);',
      '  font-family:var(--font, "Instrument Sans", system-ui, sans-serif);',
      '  transition:transform .24s cubic-bezier(.22,.61,.36,1), opacity .24s ease-out;',
      '}',
      '.bc-install-card.bc-install-hidden{transform:translateX(-50%) translateY(140%);opacity:0;}',
      '.bc-install-body{display:flex;gap:14px;align-items:flex-start;padding-right:22px;}',
      '.bc-install-mark{flex:0 0 auto;width:46px;height:34px;margin-top:2px;}',
      '.bc-install-mark svg{width:100%;height:100%;display:block;}',
      '.bc-install-text{min-width:0;}',
      '.bc-install-title{font-family:var(--display, "Instrument Serif", Georgia, serif);font-weight:400;font-size:1.25rem;',
      '  line-height:1.15;margin:0 0 4px;color:var(--ink);}',
      '.bc-install-line{margin:0;font-size:.9rem;line-height:1.42;color:var(--muted);}',
      '.bc-install-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;}',
      '.bc-install-btn{font:600 .9rem var(--font, "Instrument Sans", system-ui, sans-serif);border-radius:10px;padding:9px 16px;',
      '  min-height:40px;cursor:pointer;border:1px solid transparent;',
      '  transition:background .15s, color .15s, border-color .15s;}',
      '.bc-install-primary{background:var(--accent);color:var(--paper);border-color:var(--accent);}',
      '.bc-install-primary:hover{filter:brightness(1.06);}',
      '.bc-install-ghost{background:transparent;color:var(--muted);}',
      '.bc-install-ghost:hover{color:var(--ink);border-color:var(--line);}',
      '.bc-install-close{position:absolute;top:8px;right:8px;width:30px;height:30px;',
      '  display:flex;align-items:center;justify-content:center;',
      '  border:none;background:transparent;color:var(--muted);cursor:pointer;',
      '  border-radius:8px;font-size:20px;line-height:1;transition:background .15s, color .15s;}',
      '.bc-install-close:hover{color:var(--ink);background:var(--paper-2);}',
      '.bc-install-btn:focus-visible,.bc-install-close:focus-visible{',
      '  outline:2px solid var(--accent);outline-offset:2px;}',
      '@media (prefers-reduced-motion: reduce){.bc-install-card{transition:none;}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function buildCard(variant) {
    var isIosVariant = variant === 'ios';
    var el = document.createElement('div');
    el.className = 'bc-install-card bc-install-hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Add Bowcast to your home screen');

    var bodyLine = isIosVariant
      ? 'Open the Share menu and choose Add to Home Screen.'
      : 'One tap to your sky: forecasts, the live map, and rainbow alerts.';

    var actions = isIosVariant
      ? '<button class="bc-install-btn bc-install-primary" type="button" data-bc="dismiss">Got it</button>'
      : '<button class="bc-install-btn bc-install-ghost" type="button" data-bc="dismiss">Not now</button>'
        + '<button class="bc-install-btn bc-install-primary" type="button" data-bc="add">Add app</button>';

    el.innerHTML =
      '<button class="bc-install-close" type="button" aria-label="Dismiss" data-bc="dismiss">&times;</button>'
      + '<div class="bc-install-body">'
      +   '<span class="bc-install-mark" aria-hidden="true">' + ARC_SVG + '</span>'
      +   '<div class="bc-install-text">'
      +     '<p class="bc-install-title">Add Bowcast to your home screen</p>'
      +     '<p class="bc-install-line">' + bodyLine + '</p>'
      +   '</div>'
      + '</div>'
      + '<div class="bc-install-actions">' + actions + '</div>';

    el.addEventListener('click', function (event) {
      var trigger = event.target.closest ? event.target.closest('[data-bc]') : null;
      if (!trigger) return;
      if (trigger.getAttribute('data-bc') === 'add') addApp();
      else dismiss();
    });
    el.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') dismiss();
    });
    return el;
  }

  function show(variant) {
    if (shown) return;
    shown = true;
    injectStyles();
    card = buildCard(variant);
    document.body.appendChild(card);
    if (reduceMotion) {
      card.classList.remove('bc-install-hidden');
    } else {
      // Two frames so the hidden start state is painted before we animate in.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (card) card.classList.remove('bc-install-hidden');
        });
      });
    }
  }

  function scheduleShow(variant) {
    if (shown || timer) return;
    timer = window.setTimeout(function () {
      timer = null;
      show(variant);
    }, ENGAGE_MS);
  }

  function teardown() {
    if (timer) { window.clearTimeout(timer); timer = null; }
    var el = card;
    if (!el) return;
    card = null;
    if (reduceMotion) { el.remove(); return; }
    el.classList.add('bc-install-hidden');
    var removed = false;
    var finish = function () { if (removed) return; removed = true; el.remove(); };
    el.addEventListener('transitionend', finish);
    window.setTimeout(finish, 400); // fallback if transitionend never fires
  }

  // "Not now" / "Got it" / close: snooze for 30 days, then slide away.
  function dismiss() {
    lsSet(LS_DISMISSED, String(Date.now()));
    teardown();
  }

  function addApp() {
    var promptEvent = deferredPrompt;
    deferredPrompt = null;
    if (!promptEvent) { dismiss(); return; }
    Promise.resolve()
      .then(function () {
        promptEvent.prompt();
        return promptEvent.userChoice;
      })
      .then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          lsSet(LS_DONE, '1');
          teardown();
        } else {
          // Declined the OS sheet: treat it like "Not now" and snooze.
          dismiss();
        }
      })
      .catch(function () { dismiss(); });
  }

  // ── Chromium path ─────────────────────────────────────────────────────
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    scheduleShow('chromium');
  });
  window.addEventListener('appinstalled', function () {
    lsSet(LS_DONE, '1');
    teardown();
  });

  // ── iOS Safari path ───────────────────────────────────────────────────
  if (iosSafari) scheduleShow('ios');
})();
