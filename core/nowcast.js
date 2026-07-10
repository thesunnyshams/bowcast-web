/**
 * Nowcast: what the sky is doing right now, from satellite.
 *
 * The 7-day score is a forecast; this is an observation. Recent direct
 * normal irradiance (DNI) from geostationary satellites tells us whether the
 * sun is ACTUALLY breaking through at a place this hour, the one thing a
 * forecast cannot confirm: that sunlight is reaching the rain. It is a
 * SEPARATE overlay, never folded into the 8-factor occurrence product, so
 * the "identical code over ERA5" backtests on the science page stay honest.
 *
 * Coverage: Open-Meteo blends Meteosat (Europe, Africa, South America),
 * Himawari (India, Asia, Australia, New Zealand), and IODC (India). NASA
 * GOES (the Americas and central Pacific) is not integrated yet, and there
 * the "seamless" product silently backfills a model rather than a real
 * observation. We refuse to present that as satellite truth, so we stay
 * silent over the GOES gap and light up the moment it lands. Browser-safe,
 * keyless, dependency-free.
 */

// Longitude band with no real satellite yet: west of Meteosat's disc and
// east of Himawari's, i.e. everything that needs GOES. Honolulu (-158),
// Victoria (-123), and the rest of the Americas fall inside; eastern South
// America (Rio -43) and Fiji (+178, Himawari) do not. Shrink when GOES lands.
const GOES_GAP_LON = [-170, -73];

/** True where Open-Meteo has a real satellite over this point (not a model backfill). */
export function satelliteCovered(lat, lon) {
  return !(lon > GOES_GAP_LON[0] && lon < GOES_GAP_LON[1]);
}

/**
 * Turn observed DNI (W/m²) into a plain sky state. Uses the same ramp the
 * scoring engine applies to per-member DNI (v3.3): the WMO-style sunshine
 * threshold at 80 W/m² rising to a full beam by 320. Pure, exported for tests.
 *
 * @returns {null | { s: number, state: string, sun: boolean }} s in 0..1
 */
export function classifySky(dni) {
  if (dni == null || Number.isNaN(dni)) return null;
  const s = Math.min(Math.max((dni - 80) / 240, 0), 1);
  if (s >= 0.75) return { s, state: 'strong direct sun', sun: true };
  if (s >= 0.35) return { s, state: 'sun breaking through', sun: true };
  if (s > 0) return { s, state: 'weak, filtered sun', sun: false };
  return { s: 0, state: 'no direct sun right now', sun: false };
}

const cache = new Map(); // key -> Promise, memoized per ~1 km cell

/**
 * The most recent satellite reading of the sky at a point. One keyless
 * request to the seamless satellite-radiation product, memoized. Returns
 * { covered: false } over the GOES gap without any network call.
 *
 * @returns {Promise<{ covered: boolean, observed?: boolean, dni?: number,
 *                     epoch?: number, ageMin?: number, state?: string, sun?: boolean }>}
 */
export function observedSky(lat, lon, { fetchImpl, now = Date.now() } = {}) {
  if (!satelliteCovered(lat, lon)) return Promise.resolve({ covered: false });

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!cache.has(key)) {
    const doFetch = fetchImpl || fetch;
    const url = new URL('https://satellite-api.open-meteo.com/v1/archive');
    url.searchParams.set('latitude', lat.toFixed(4));
    url.searchParams.set('longitude', lon.toFixed(4));
    url.searchParams.set('hourly', 'direct_normal_irradiance');
    url.searchParams.set('models', 'satellite_radiation_seamless');
    url.searchParams.set('past_hours', '3');
    url.searchParams.set('forecast_hours', '1');
    url.searchParams.set('timeformat', 'unixtime');

    const promise = doFetch(url.toString())
      .then((res) => {
        if (!res.ok) throw new Error(`satellite API error: ${res.status}`);
        return res.json();
      })
      .then((data) => parseObserved(data, now));
    // A flaky network should not stick; drop the entry so a retry can refetch.
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}

/** Pure: pick the latest reading at or before now and classify it. Exported for tests. */
export function parseObserved(data, now = Date.now()) {
  const nowSec = now / 1000;
  const times = data?.hourly?.time || [];
  const dnis = data?.hourly?.direct_normal_irradiance || [];
  let latest = null;
  times.forEach((ts, i) => {
    // Allow up to 30 min into the future so a just-closed hour still counts.
    if (ts <= nowSec + 1800 && dnis[i] != null) latest = { epoch: ts, dni: dnis[i] };
  });
  if (!latest) return { covered: true, observed: false };
  const sky = classifySky(latest.dni);
  return {
    covered: true,
    observed: true,
    dni: Math.round(latest.dni),
    epoch: latest.epoch,
    ageMin: Math.max(0, Math.round((nowSec - latest.epoch) / 60)),
    state: sky.state,
    sun: sky.sun,
  };
}
