/**
 * Radar nowcast: is there real, observed rain in the antisolar sky right now?
 *
 * The score forecasts rain; the satellite overlay confirms sun. This confirms
 * the third thing neither can: that a rain shaft is actually sitting where the
 * bow would form (opposite the sun, a few km out) at this minute. Source is
 * RainViewer's free public radar mosaic (global ground radar, ~10 min latency,
 * CORS-open so the tiles can be read on a canvas). Keyless, client-side,
 * another separate overlay never folded into the scored product.
 *
 * The pure geometry and pixel-reading helpers are exported for tests; the
 * tile-fetching sampler needs a browser (Image + canvas) and no-ops in Node,
 * so importing this module server-side stays safe.
 */

const KM_PER_DEG_LAT = 111.32;
const TILE = 256;
const RAINVIEWER_MAPS = 'https://api.rainviewer.com/public/weather-maps.json';
// Distances out along the antisolar bearing to look for the shaft. A bow's
// rain is typically 1-15 km away; sampling a spread catches near and far cells.
const SAMPLE_KM = [1, 3, 6, 10, 14];

/** Equirectangular offset point (same approximation as points.js / terrain.js). */
function destination(lat, lon, bearingDeg, km) {
  const rad = (bearingDeg * Math.PI) / 180;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 0.001;
  return {
    lat: lat + (km * Math.cos(rad)) / KM_PER_DEG_LAT,
    lon: lon + (km * Math.sin(rad)) / kmPerDegLon,
  };
}

/**
 * Web Mercator slippy-tile coordinate plus the pixel within the 256px tile.
 * Pure, exported for tests.
 */
export function tilePixel(lat, lon, z) {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { z, x, y, px: Math.floor((xf - x) * TILE), py: Math.floor((yf - y) * TILE) };
}

/** The points to probe: out along the antisolar bearing (opposite the sun). */
export function antisolarPoints(lat, lon, sunAzimuthDeg, kms = SAMPLE_KM) {
  const az = (sunAzimuthDeg + 180) % 360;
  return kms.map((km) => ({ km, ...destination(lat, lon, az, km) }));
}

/**
 * Classify one RGBA radar pixel. RainViewer tiles are transparent where there
 * is no echo and run a cool-to-warm ramp as intensity climbs, so red-vs-blue
 * is a serviceable coarse intensity proxy (light shower vs heavy downpour),
 * which is exactly the distinction a rainbow cares about. Pure, tested.
 *
 * @returns {{ rain: boolean, level: 0|1|2|3 }} 1 light, 2 moderate, 3 heavy
 */
export function classifyPixel(r, g, b, a) {
  if (a < 40) return { rain: false, level: 0 };
  const warmth = (r - b) / 255; // -1 (blue/light) .. +1 (red/heavy)
  const level = warmth > 0.35 ? 3 : warmth > -0.05 ? 2 : 1;
  return { rain: true, level };
}

/**
 * Fold per-point classifications into a verdict for the antisolar sky.
 * "Ideal" leans on light-to-moderate showers (level 1-2): heavy rain (3)
 * darkens the backdrop, which the score already knows. Pure, tested.
 */
export function summarizeShaft(samples) {
  const wet = samples.filter((s) => s.rain);
  if (wet.length === 0) return { rainNearby: false, cells: 0, nearestKm: null, quality: 'clear', reason: 'no rain in the antisolar sky' };
  const nearestKm = Math.min(...wet.map((s) => s.km));
  const heavy = wet.every((s) => s.level >= 3);
  const quality = heavy ? 'heavy' : 'showery';
  const reason = heavy
    ? `heavy rain ${nearestKm} km out (may darken the bow)`
    : `showers ${nearestKm} km out in the antisolar sky`;
  return { rainNearby: true, cells: wet.length, nearestKm, quality, reason };
}

// ── Browser-only sampler ────────────────────────────────────────────────────

const RADAR_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_RADAR_AGE_MINUTES = 20;
const mapsCache = { at: 0, data: null };

/** Latest RainViewer radar frame (host + path + age). Cached ~2 min. */
async function latestFrame(fetchImpl, now = Date.now()) {
  if (!mapsCache.data || now - mapsCache.at > 120000) {
    const res = await (fetchImpl || fetch)(RAINVIEWER_MAPS);
    if (!res.ok) throw new Error(`RainViewer maps ${res.status}`);
    mapsCache.data = await res.json();
    mapsCache.at = now;
  }
  const past = mapsCache.data.radar?.past || [];
  if (!past.length) throw new Error('no radar frames');
  const f = past[past.length - 1];
  return { host: mapsCache.data.host, path: f.path, time: f.time };
}

/** Load a radar tile and return a canvas 2D context for pixel reads (browser only). */
function loadTileCtx(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = TILE;
      c.height = TILE;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx);
    };
    img.onerror = () => reject(new Error('tile load failed'));
    img.src = url;
  });
}

const nowcastCache = new Map(); // key -> { at, promise }

/**
 * Observed rain in the antisolar sky for an observer + sun direction. One
 * RainViewer frame, one tile per distinct tile touched (usually 1-2),
 * memoized per ~1 km cell and sun direction. Browser only.
 *
 * @returns {Promise<{ available, ageMin?, rainNearby?, cells?, nearestKm?,
 *                     quality?, reason? }>}
 */
export function radarNowcast(lat, lon, sunAzimuthDeg, {
  fetchImpl,
  zoom = 9,
  now = Date.now(),
  cacheTtlMs = RADAR_CACHE_TTL_MS,
  maxAgeMinutes = MAX_RADAR_AGE_MINUTES,
  latestFrameFn = latestFrame,
  loadTileCtxFn = loadTileCtx,
} = {}) {
  if (typeof document === 'undefined' && loadTileCtxFn === loadTileCtx) {
    return Promise.resolve({ available: false });
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(sunAzimuthDeg / 15) * 15},${zoom}`;
  const cached = nowcastCache.get(key);
  if (!cached || now - cached.at >= cacheTtlMs) {
    const promise = (async () => {
      const frame = await latestFrameFn(fetchImpl, now);
      const ageMin = Math.max(0, Math.round((now / 1000 - frame.time) / 60));
      if (ageMin > maxAgeMinutes) {
        return { available: false, ageMin, stale: true, reason: 'radar frame is stale' };
      }
      const pts = antisolarPoints(lat, lon, sunAzimuthDeg).map((p) => ({ ...p, ...tilePixel(p.lat, p.lon, zoom) }));
      const ctxByTile = new Map();
      const samples = [];
      let failedSamples = 0;
      for (const p of pts) {
        const tk = `${p.z}/${p.x}/${p.y}`;
        if (!ctxByTile.has(tk)) {
          const url = `${frame.host}${frame.path}/${TILE}/${p.z}/${p.x}/${p.y}/2/1_1.png`;
          ctxByTile.set(tk, Promise.resolve().then(() => loadTileCtxFn(url)).catch(() => null));
        }
        const ctx = await ctxByTile.get(tk);
        if (!ctx) { failedSamples += 1; continue; }
        const [r, g, b, a] = ctx.getImageData(p.px, p.py, 1, 1).data;
        samples.push({ km: p.km, ...classifyPixel(r, g, b, a) });
      }
      if (samples.length === 0) {
        return { available: false, ageMin, reason: 'radar tiles unavailable' };
      }
      const summary = summarizeShaft(samples);
      // A wet sampled point is positive evidence even if another tile failed.
      // A dry verdict requires every requested point to have been readable.
      if (!summary.rainNearby && failedSamples > 0) {
        return { available: false, ageMin, reason: 'radar coverage incomplete' };
      }
      return { available: true, ageMin, ...summary };
    })();
    promise.catch(() => {
      if (nowcastCache.get(key)?.promise === promise) nowcastCache.delete(key);
    });
    nowcastCache.set(key, { at: now, promise });
  }
  return nowcastCache.get(key).promise;
}
