// Loads Vercel Web Analytics on the public website only. It must never run in
// the packaged Capacitor apps or during local development, and it honours the
// same Global Privacy Control and Do Not Track opt-out as the anonymous
// product counters (metricMeasurementAllowed in core/metrics.js), so a single
// promise in the privacy policy covers every measurement Bowcast takes.
//
// The script is served by Vercel's edge from this same origin, so there is no
// third-party request and no cookie. Vercel counts a unique visitor with a
// hash that is re-salted every 24 hours, which is why the policy promises no
// identifier that survives the day rather than no identifier at all.
(function () {
  if (window.Capacitor) return; // packaged iOS/Android app
  if (location.protocol !== 'https:') return; // local dev, capacitor scheme
  var hostname = String(location.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return;
  if (hostname === '0.0.0.0' || hostname === '::1') return;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)) return;
  if (hostname.includes(':') && /^(?:fc|fd|fe[89ab])/.test(hostname)) return;
  // Keep this rule identical to metricMeasurementAllowed() in core/metrics.js.
  if (navigator.globalPrivacyControl === true) return;
  if (String(navigator.doNotTrack || '') === '1') return;
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  var s = document.createElement('script');
  s.src = '/_vercel/insights/script.js';
  s.defer = true;
  document.head.appendChild(s);
})();
