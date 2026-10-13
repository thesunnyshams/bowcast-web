/**
 * Land classification for forecast points.
 *
 * A ring point over open water is a forecast nobody can stand in, so Bowcast
 * hides it. That decision used to be made in the browser, once per visitor,
 * which meant the three surfaces reached three different answers for the same
 * coordinates: the map filtered the ring, the generated city pages did not,
 * and the app had no filter at all. A coastal reading could therefore differ
 * between the website and the app purely because of who did the filtering.
 *
 * The classification now runs once beside the forecast and travels in the
 * payload as `land` on every location, so every surface applies one rule
 * through keepLandPoints.
 *
 * Elevation comes from the keyless Open-Meteo elevation API (90 m Copernicus
 * DEM), one batched request for the whole ring. The DEM reads 0 or below over
 * sea, strait, and ocean and the real height on land, which separates coastal
 * water from land without sending synthetic ring coordinates to a geocoder.
 *
 * Browser-safe and dependency-free: the server annotates the ring before
 * scoring it, and the on-device fallback paths call the same function.
 */
import { fetchWithTimeout } from './http.js';

/** The DEM reads at or below this height (metres) over water. */
export const LAND_MIN_ELEVATION_M = 0;

const ELEVATION_TIMEOUT_MS = 5000;
const MEMO_MAX_ENTRIES = 500;

// Terrain does not move, so one answer per ring is reusable for the life of
// the process. Successful lookups only: a flaky network must not stick.
const memo = new Map();

function remember(key, value) {
  memo.set(key, value);
  if (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value);
}

/**
 * Batched elevations for a list of points, in the order given.
 *
 * Never throws and never rejects: the land filter is an improvement on the
 * forecast, not a precondition for it, so an unreachable elevation API returns
 * null and every caller falls open to keeping the whole ring.
 *
 * @returns {Promise<number[]|null>} metres per point, or null when unknown
 */
export async function fetchPointElevations(points, { fetchImpl, timeoutMs = ELEVATION_TIMEOUT_MS } = {}) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (!points.every((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))) return null;

  const latitude = points.map((p) => p.lat).join(',');
  const longitude = points.map((p) => p.lon).join(',');
  const key = `${latitude};${longitude}`;
  if (memo.has(key)) return memo.get(key);

  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`;
    const response = fetchImpl
      ? await fetchImpl(url)
      : await fetchWithTimeout(url, {}, timeoutMs);
    if (!response.ok) return null;
    const elevation = (await response.json())?.elevation;
    if (!Array.isArray(elevation) || elevation.length !== points.length) return null;
    remember(key, elevation);
    return elevation;
  } catch (_) {
    return null;
  }
}

/**
 * Tag each point with `land`. True over land, false over water, and null when
 * the DEM had nothing to say, which every consumer treats as "keep it".
 */
export function classifyLand(points, elevations) {
  if (!Array.isArray(points)) return [];
  const usable = Array.isArray(elevations) && elevations.length === points.length;
  return points.map((point, i) => {
    const metres = usable ? elevations[i] : null;
    return {
      ...point,
      land: Number.isFinite(metres) ? metres > LAND_MIN_ELEVATION_M : null,
    };
  });
}

/** Fetch and classify in one step. Falls open to `land: null` on any failure. */
export async function resolveLandPoints(points, options = {}) {
  return classifyLand(points, await fetchPointElevations(points, options));
}

/**
 * The one presentation rule, shared by the map, the city pages, and the app.
 *
 * The first entry is the place the reader is standing in (`pointsAround` puts
 * it there, and every surface treats it as the subject of the page), so it
 * stays whether it is land, a harbour, or an island smaller than one DEM cell.
 * Ring points are dropped only on a definite `land: false`, which keeps older
 * payloads without the field, and unreachable-DEM payloads, rendering whole.
 */
export function keepLandPoints(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return [];
  return [locations[0], ...locations.slice(1).filter((point) => point?.land !== false)];
}

/** Whether a payload carries land classification at all. */
export function hasLandFlags(locations) {
  return Array.isArray(locations) && locations.some((point) => typeof point?.land === 'boolean');
}
