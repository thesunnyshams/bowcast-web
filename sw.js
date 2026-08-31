/*
 * Offline shell for the PWA.
 *
 * Strategy, and the reason for it: the old worker served every same-origin
 * asset cache-first behind a hand-bumped cache name. A deploy that changed
 * landing.css or app.js without bumping that constant left returning visitors
 * on the new HTML with the old stylesheet and the old script, which is exactly
 * how the redesign shipped looking half-applied. Correctness beats a few
 * milliseconds here: HTML, CSS and JS are network-first with a cached
 * fallback, so a reachable network always wins and the cache only stands in
 * when the network does not answer.
 *
 * Fonts and icons stay cache-first: they are immutable, addressed by filename,
 * and by far the heaviest part of a cold load.
 */
const CACHE = 'bowcast-shell-v20';

// Only what a cold offline start actually needs. The rest of the site enters
// the cache as it is visited, through the fetch handler below.
const SHELL = [
  '/',
  '/map/',
  '/now/',
  '/styles.css',
  '/landing.css',
  '/content.css',
  '/theme.css',
  '/theme.js',
  '/bowgauge.js',
  '/app.js',
  '/install-prompt.js',
  '/analytics.js',
  '/manifest.json',
  '/icon.svg',
  '/icons/bowcast-mark.png',
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
  '/core/window-calendar.js',
];
const EXTERNAL_SHELL = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// A failed precache entry used to abort the whole install. Settle each one so
// a single 404 cannot leave the site with no worker at all.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then(async (cache) => {
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await Promise.allSettled(EXTERNAL_SHELL.map((url) => cache.add(url)));
    })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('bowcast-') && key !== CACHE)
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

const FONT_OR_ICON = /\.(woff2|png|svg|ico)$/;

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Cross-origin traffic stays out of the cache entirely, apart from the two
  // pinned Leaflet files: every opaque response is quota-padded by the
  // browser, and a map session loads hundreds of tiles.
  if (url.origin !== self.location.origin) {
    if (url.href.startsWith('https://unpkg.com/leaflet@')) event.respondWith(cacheFirst(request));
    return;
  }

  // Forecast responses: fresh when the network answers, last known good when
  // it does not. Same rule as the rest, named separately because it matters.
  if (url.pathname.startsWith('/api/')) {
    // The map rotates its forecast query every 15 minutes to avoid receiving
    // one-cycle-old CDN data. Normalize that key locally so offline storage
    // retains one latest response per area instead of growing every cycle.
    const offlineKey = new URL(request.url);
    offlineKey.searchParams.delete('refresh');
    event.respondWith(networkFirst(request, offlineKey.toString()));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request).catch(() => caches.match('/map/')));
    return;
  }
  if (FONT_OR_ICON.test(url.pathname)) {
    event.respondWith(cacheFirst(request).catch(() => caches.match(request)));
    return;
  }
  // Everything else we serve (CSS, JS, JSON, the API) is versionless, so it
  // has to be revalidated rather than trusted.
  event.respondWith(networkFirst(request).catch(() => caches.match(request)));
});
