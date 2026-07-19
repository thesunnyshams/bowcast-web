const CACHE = 'bowcast-shell-v17';
const SHELL = [
  '/',
  '/map/',
  '/now/',
  '/styles.css',
  '/landing.css',
  '/theme.css',
  '/theme.js',
  '/bowgauge.js',
  '/app.js',
  '/install-prompt.js',
  '/manifest.json',
  '/icon.svg',
  '/fonts/fonts.css',
  '/fonts/instrument-sans-latin.woff2',
  '/fonts/instrument-sans-latin-ext.woff2',
  '/fonts/instrument-serif-latin.woff2',
  '/fonts/instrument-serif-latin-ext.woff2',
  '/fonts/instrument-serif-italic-latin.woff2',
  '/fonts/instrument-serif-italic-latin-ext.woff2',
  '/now/now-page.js',
  '/now/webcams.json',
  '/core/alerts.js',
  '/core/cities.js',
  '/core/config.js',
  '/core/ensemble.js',
  '/core/forecast-time.js',
  '/core/geometry.js',
  '/core/http.js',
  '/core/likelihood.js',
  '/core/metrics.js',
  '/core/liveConfirm.js',
  '/core/now.js',
  '/core/nowcast.js',
  '/core/points.js',
  '/core/presentation.js',
  '/core/probability-calibration.js',
  '/core/radar.js',
  '/core/scoring.js',
  '/core/share.js',
  '/core/sightings.js',
  '/core/solar.js',
  '/core/terrain.js',
  '/core/trained-calibration.js',
  '/core/weather.js',
];
const EXTERNAL_SHELL = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then(async (cache) => {
      await cache.addAll(SHELL);
      await Promise.allSettled(EXTERNAL_SHELL.map((url) => cache.add(url)));
    })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('bowcast-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkWithCachedFallback(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cachedWithRefresh(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    refresh.catch(() => undefined);
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(networkWithCachedFallback(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkWithCachedFallback(request).catch(() => caches.match('/map/')));
    return;
  }
  // Runtime-cache only our own assets plus the pinned Leaflet files. Other
  // cross-origin traffic (map tiles, webcams, geocoding) must not enter the
  // cache: each opaque response is quota-padded by the browser, and a map
  // session loads hundreds of tiles.
  if (url.origin !== self.location.origin && !url.href.startsWith('https://unpkg.com/leaflet@')) {
    return;
  }
  event.respondWith(cachedWithRefresh(request).catch(() => caches.match(request)));
});
