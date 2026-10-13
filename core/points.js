/**
 * Forecast points around a position. A rainbow's rain shaft is typically
 * within ~5-20 km of the observer, so we score the user's spot plus a ring
 * of 8 compass points at ringKm. Shared by the app (on-device) and the
 * server (per-cell push checks).
 */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

export function wrapLongitude(lon) {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearing = toRadians(bearingDeg);
  const latitude = toRadians(lat);
  const longitude = toRadians(lon);
  const targetLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const targetLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(targetLatitude),
  );
  return {
    lat: round4(toDegrees(targetLatitude)),
    lon: round4(wrapLongitude(toDegrees(targetLongitude))),
  };
}

export function pointsAround(lat, lon, { ringKm = 12 } = {}) {
  const centerLat = Math.max(-90, Math.min(90, lat));
  const centerLon = wrapLongitude(lon);
  const points = [{ name: 'Your spot', lat: centerLat, lon: centerLon }];
  COMPASS.forEach((dir, i) => {
    const destination = destinationPoint(centerLat, centerLon, i * 45, ringKm);
    points.push({
      name: `${ringKm} km ${dir}`,
      ...destination,
    });
  });
  return points;
}

/** Describe a forecast point from an individual device, not a shared cell center. */
/**
 * Great-circle distance in kilometres, taking the short way round the globe so
 * two points either side of the date line are neighbours rather than half a
 * world apart.
 */
export function distanceKm(fromLatDeg, fromLonDeg, toLatDeg, toLonDeg) {
  if (![fromLatDeg, fromLonDeg, toLatDeg, toLonDeg].every(Number.isFinite)) return NaN;
  const fromLat = toRadians(fromLatDeg);
  const toLat = toRadians(toLatDeg);
  const deltaLat = toLat - fromLat;
  const deltaLon = toRadians(wrapLongitude(toLonDeg - fromLonDeg));
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function relativePointName(observerLat, observerLon, point) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) return point?.name || 'Your spot';
  const fromLat = toRadians(observerLat);
  const toLat = toRadians(point.lat);
  const deltaLon = toRadians(wrapLongitude(point.lon - observerLon));
  const distance = distanceKm(observerLat, observerLon, point.lat, point.lon);
  if (distance < 2) return 'Your spot';
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat)
    - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  const bearing = (toDegrees(Math.atan2(y, x)) + 360) % 360;
  const direction = COMPASS[Math.round(bearing / 45) % COMPASS.length];
  return `${Math.max(2, Math.round(distance))} km ${direction}`;
}

/**
 * Bucket a position into a ~25 km cell (0.25° grid). Devices in the same
 * cell share one push check, which bounds API usage as users grow.
 */
export function cellKey(lat, lon) {
  const q = (n) => (Math.round(n / 0.25) * 0.25).toFixed(2);
  return `${q(Math.max(-90, Math.min(90, lat)))},${q(wrapLongitude(lon))}`;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
