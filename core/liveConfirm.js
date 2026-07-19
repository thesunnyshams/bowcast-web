/**
 * Live confirmation: is a rainbow probably visible at a city THIS minute?
 *
 * The score and the /now ranking are forecasts. This asks the harder question
 * observationally, by lining up three independent things at the current
 * moment:
 *   1. Geometry  (free): the sun is up and no higher than 42 degrees, so a
 *      primary bow can physically stand.
 *   2. Radar     (RainViewer): a real echo sits in the antisolar sky, the rain
 *      shaft the bow would form on. This is the observed linchpin.
 *   3. Sun       (satellite DNI where covered; the forecast's sun fraction
 *      where the satellite is dark, e.g. Hawaii): light is actually reaching
 *      those drops.
 *
 * When all three agree we say "rainbow likely now" and point a direction. It
 * is a separate live overlay, never folded into the scored product. The
 * verdict logic is pure and tested; the orchestration needs a browser (radar
 * reads a canvas) and no-ops server-side.
 */
import { sunPositionDeg } from './solar.js';
import { compassPoint } from './geometry.js';
import { observedSky } from './nowcast.js';
import { radarNowcast } from './radar.js';

const MAX_BOW_ELEVATION = 42;
const FORECAST_SUN_MIN = 25; // percent of the hour the forecast must be sunlit to stand in for satellite

/**
 * Fold the three signals into a verdict. Pure, exported for tests.
 *
 * @param {object} p
 * @param {number} p.sunElevation current sun elevation, degrees
 * @param {{available?:boolean, rainNearby?:boolean, nearestKm?:number, quality?:string}} p.radar
 * @param {{observed?:boolean, sun?:boolean}} p.sky satellite reading (may be uncovered)
 * @param {number|null} p.sunlitForecast forecast sun fraction this hour (0-100)
 * @param {boolean|null} p.liquidPhaseSupported whether the current forecast
 *   independently supports liquid precipitation at the observer
 * @returns {{ live:boolean, tier?:string, sunSource?:string, rainKm?:number, quality?:string, reason?:string }}
 */
export function liveVerdict({
  sunElevation,
  radar,
  sky,
  sunlitForecast,
  liquidPhaseSupported = null,
}) {
  if (!(sunElevation > 0 && sunElevation <= MAX_BOW_ELEVATION)) {
    return { live: false, reason: 'sun outside the bow window' };
  }
  if (!radar?.rainNearby) {
    return { live: false, reason: radar?.available ? 'no rain in the antisolar sky' : 'no radar coverage here' };
  }
  if (sky?.observed && !sky.sun) {
    return { live: false, reason: 'satellite observes no direct sun on the scene' };
  }
  const sunObserved = !!(sky?.observed && sky?.sun);
  const sunForecast = !sky?.observed && (sunlitForecast ?? 0) >= FORECAST_SUN_MIN;
  if (!sunObserved && !sunForecast) {
    return { live: false, reason: 'sun not shining on the shaft' };
  }
  const phaseConfirmed = liquidPhaseSupported === true;
  return {
    live: true,
    tier: sunObserved && phaseConfirmed ? 'confirmed' : 'likely',
    sunSource: sunObserved ? 'satellite' : 'forecast',
    rainKm: radar.nearestKm,
    quality: radar.quality,
    liquidPhaseSupported,
  };
}

/** Plain-language radar evidence that does not infer liquid phase from echo colour. */
export function radarEvidencePhrase({ quality, rainKm, liquidPhaseSupported }) {
  const distance = Number.isFinite(rainKm) ? ` ${rainKm} km out` : '';
  if (liquidPhaseSupported) {
    return `${quality === 'heavy' ? 'heavy rain' : 'showers'}${distance}`;
  }
  const strength = quality === 'heavy' ? 'a strong precipitation echo' : 'a precipitation echo';
  return `${strength}${distance} (liquid phase unconfirmed)`;
}

// ── Browser orchestration ───────────────────────────────────────────────────

/**
 * Run the three checks for one city at the current instant. Browser only
 * (radar samples a canvas); resolves { live:false } server-side.
 *
 * @param {{lat:number, lon:number, name?:string, sunlitNow?:number|null}} city
 */
export async function confirmNow(city) {
  if (typeof document === 'undefined') return { live: false };
  const pos = sunPositionDeg(new Date(), city.lat, city.lon);
  if (!(pos.elevation > 0 && pos.elevation <= MAX_BOW_ELEVATION)) return { live: false, reason: 'sun outside the bow window' };

  const [radar, sky] = await Promise.all([
    radarNowcast(city.lat, city.lon, pos.azimuth).catch(() => ({ available: false })),
    observedSky(city.lat, city.lon).catch(() => ({ covered: false })),
  ]);
  const v = liveVerdict({
    sunElevation: pos.elevation,
    radar,
    sky,
    sunlitForecast: city.sunlitNow,
    liquidPhaseSupported: city.liquidPhaseNow ?? null,
  });
  return {
    ...v,
    look: compassPoint((pos.azimuth + 180) % 360),
    sunElevation: Math.round(pos.elevation),
    radar,
    sky,
  };
}

/**
 * Confirm the most promising daytime cities and return those a bow is likely
 * over right now, strongest first. Bounded so a page load makes only a handful
 * of extra requests.
 *
 * @param {Array} cities  ranked rows from now.js (need lat, lon, isDay, headline, sunlitNow)
 * @param {number} limit  how many top daytime candidates to actually check
 */
export async function confirmHappeningNow(cities, { limit = 20 } = {}) {
  // Every daytime city whose sun is actually in the 0-42 bow window this
  // minute (cheap geometry, no fetch), not just the forecast favourites, so a
  // bow the forecast under-rated but radar can see still surfaces. confirmNow
  // only spends a request on cities that clear this gate.
  const candidates = cities.filter((c) => {
    if (!c.isDay) return false;
    const el = sunPositionDeg(new Date(), c.lat, c.lon).elevation;
    return el > 0 && el <= MAX_BOW_ELEVATION;
  }).slice(0, limit);
  const checked = await Promise.all(
    candidates.map((c) => confirmNow(c).then((v) => ({ city: c, ...v })).catch(() => ({ city: c, live: false }))),
  );
  const tierRank = { confirmed: 2, likely: 1 };
  return checked
    .filter((r) => r.live)
    .sort((a, b) => (tierRank[b.tier] - tierRank[a.tier]) || (a.rainKm - b.rainKm));
}
