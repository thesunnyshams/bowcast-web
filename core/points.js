/**
 * Forecast points around a position. A rainbow's rain shaft is typically
 * within ~5-20 km of the observer, so we score the user's spot plus a ring
 * of 8 compass points at ringKm. Shared by the app (on-device) and the
 * server (per-cell push checks).
 */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const KM_PER_DEG_LAT = 111.32;

export function pointsAround(lat, lon, { ringKm = 12 } = {}) {
  const points = [{ name: 'Your spot', lat, lon }];
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 0.001;
  COMPASS.forEach((dir, i) => {
    const angle = (i * 45 * Math.PI) / 180; // 0 = north, clockwise
    const dLat = (ringKm * Math.cos(angle)) / KM_PER_DEG_LAT;
    const dLon = (ringKm * Math.sin(angle)) / kmPerDegLon;
    points.push({
      name: `${ringKm} km ${dir}`,
      lat: round4(lat + dLat),
      lon: round4(lon + dLon),
    });
  });
  return points;
}

/**
 * Bucket a position into a ~25 km cell (0.25° grid). Devices in the same
 * cell share one push check, which bounds API usage as users grow.
 */
export function cellKey(lat, lon) {
  const q = (n) => (Math.round(n / 0.25) * 0.25).toFixed(2);
  return `${q(lat)},${q(lon)}`;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
