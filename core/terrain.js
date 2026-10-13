/**
 * Terrain awareness: does the land let you see this bow?
 *
 * The weather model says whether sunlit rain exists; this module says
 * whether the observer's sightlines allow the show. Two things matter:
 *
 *  1. Sun side: low-angle sunlight (the only kind that makes a bow) is
 *     easily blocked by a ridge toward the sun's azimuth.
 *  2. Bow side: the arc stands opposite the sun, from the horizon up to
 *     (42 - sun elevation) degrees. High ground in that direction clips
 *     the arc from the feet upward.
 *
 * Elevations come from the keyless Open-Meteo elevation API (90 m Copernicus
 * DEM), already a dependency of the map's land filter, one batched request
 * per assessment. Horizon angles ignore Earth curvature: at our longest
 * sample (14 km) curvature is ~0.07 degrees, well under the thresholds.
 *
 * This is a SEPARATE score, deliberately not a factor in the 8-factor
 * occurrence product: terrain is about the observer, not the weather, and
 * folding it in would break comparability with the ERA5 backtests.
 * Browser-safe; runs on the map, the city pages, and the phones.
 */

const KM_PER_DEG_LAT = 111.32;
const SAMPLE_KM = [1, 2, 4, 8, 14];
const MAX_BOW_ELEVATION = 42;

const cache = new Map(); // key -> Promise of verdict; azimuth bucketed to 15 degrees

/** Straight-line offset point, equirectangular (same approach as points.js). */
function destination(lat, lon, bearingDeg, km) {
  const rad = (bearingDeg * Math.PI) / 180;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 0.001;
  return {
    lat: lat + (km * Math.cos(rad)) / KM_PER_DEG_LAT,
    lon: lon + (km * Math.sin(rad)) / kmPerDegLon,
  };
}

/** Highest apparent terrain angle (degrees above horizontal) along one bearing. */
function horizonAngle(baseElevM, elevsM, distancesKm) {
  let max = 0;
  elevsM.forEach((e, i) => {
    const angle = (Math.atan2((e ?? 0) - baseElevM, distancesKm[i] * 1000) * 180) / Math.PI;
    if (angle > max) max = angle;
  });
  return max;
}

/**
 * Pure verdict from horizon angles: exported for tests, no network.
 *
 * @param {object} p
 * @param {number} p.sunHorizonDeg highest terrain angle toward the sun
 * @param {number} p.bowHorizonDeg highest terrain angle toward the antisolar sky
 * @param {number} p.sunElevation sun elevation in degrees (0..42 in practice)
 * @returns {{ score: number, word: string, reason: string }} score 0-100
 */
export function terrainVerdict({ sunHorizonDeg, bowHorizonDeg, sunElevation }) {
  const reasons = [];

  let sunFactor = 1;
  if (sunHorizonDeg >= sunElevation) {
    sunFactor = 0.15;
    reasons.push('high ground toward the sun stands above the low light');
  } else if (sunHorizonDeg >= sunElevation - 1.5) {
    sunFactor = 0.6;
    reasons.push('terrain toward the sun grazes the light path');
  }

  const bowTop = Math.max(MAX_BOW_ELEVATION - sunElevation, 1);
  const visible = Math.min(Math.max(1 - bowHorizonDeg / bowTop, 0), 1);
  let bowFactor;
  if (visible <= 0.15) {
    bowFactor = 0.3;
    reasons.push('high ground opposite the sun hides most of the arc');
  } else {
    bowFactor = 0.4 + 0.6 * visible;
    if (visible < 0.85) reasons.push('terrain opposite the sun clips the base of the arc');
  }

  const score = Math.round(100 * sunFactor * bowFactor);
  const word =
    score >= 85 ? 'open' : score >= 60 ? 'mostly open' : score >= 35 ? 'partly blocked' : 'blocked';
  const reason = reasons.length ? reasons.join('; ') : 'open horizon toward the bow';
  return { score, word, reason };
}

/**
 * Assess terrain for an observer and a sun position. One batched elevation
 * request (11 points: origin plus five samples along each of the sun and
 * antisolar bearings), memoized per position and 15-degree sun-azimuth
 * bucket, so repeated popup opens cost nothing.
 *
 * @returns {Promise<{ score, word, reason, sunHorizonDeg, bowHorizonDeg }>}
 */
export function terrainOutlook(lat, lon, sunAzimuthDeg, sunElevationDeg, { fetchImpl } = {}) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(sunAzimuthDeg / 15) * 15}`;
  if (!cache.has(key)) {
    const doFetch = fetchImpl || fetch;
    const antiAz = (sunAzimuthDeg + 180) % 360;
    const points = [
      { lat, lon },
      ...SAMPLE_KM.map((km) => destination(lat, lon, sunAzimuthDeg, km)),
      ...SAMPLE_KM.map((km) => destination(lat, lon, antiAz, km)),
    ];
    const url = new URL('https://api.open-meteo.com/v1/elevation');
    url.searchParams.set('latitude', points.map((p) => p.lat.toFixed(4)).join(','));
    url.searchParams.set('longitude', points.map((p) => p.lon.toFixed(4)).join(','));

    const promise = doFetch(url.toString())
      .then((res) => {
        if (!res.ok) throw new Error(`elevation API error: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const elev = data.elevation || [];
        const base = elev[0] ?? 0;
        const n = SAMPLE_KM.length;
        const sunHorizonDeg = horizonAngle(base, elev.slice(1, 1 + n), SAMPLE_KM);
        const bowHorizonDeg = horizonAngle(base, elev.slice(1 + n, 1 + 2 * n), SAMPLE_KM);
        return {
          ...terrainVerdict({ sunHorizonDeg, bowHorizonDeg, sunElevation: sunElevationDeg }),
          sunHorizonDeg: Math.round(sunHorizonDeg * 10) / 10,
          bowHorizonDeg: Math.round(bowHorizonDeg * 10) / 10,
        };
      });
    // Do not memoize failures: a flaky network should not stick.
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}
