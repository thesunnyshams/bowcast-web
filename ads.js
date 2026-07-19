// Loads Google AdSense on the public website only. It must never run in the
// packaged Capacitor apps (AdSense policy prohibits ads in app WebViews) or
// during local development. Auto ads placement is controlled in the AdSense
// dashboard once this script is live.
(function () {
  var CLIENT = 'ca-pub-2439566469069712';
  if (window.Capacitor) return; // packaged iOS/Android app
  if (location.protocol !== 'https:') return; // local dev, capacitor scheme
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) return;
  var s = document.createElement('script');
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + CLIENT;
  s.async = true;
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
})();
