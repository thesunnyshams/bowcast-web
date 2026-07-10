/**
 * Bow geometry: where to look and when the arc is geometrically possible.
 *
 * Pure math on top of solar.js, shared by the map popup, the city pages,
 * and push alerts. The weather model owns the hour; this module owns the
 * minutes inside it, because the sun's path is deterministic even when the
 * forecast is not. Browser-safe, dependency-free.
 */
import { sunPositionDeg } from './solar.js';

/** Primary bow visible only while the sun is at or below 42 degrees (see scoring.js). */
const MAX_BOW_ELEVATION = 42;

const COMPASS_16 = [
  'North', 'North-Northeast', 'Northeast', 'East-Northeast',
  'East', 'East-Southeast', 'Southeast', 'South-Southeast',
  'South', 'South-Southwest', 'Southwest', 'West-Southwest',
  'West', 'West-Northwest', 'Northwest', 'North-Northwest',
];

/** 16-point compass name for an azimuth in degrees clockwise from true north. */
export function compassPoint(azimuthDeg) {
  const idx = Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[idx];
}

/**
 * The stretch of one forecast hour during which a primary bow can stand:
 * sun up and no higher than 42 degrees. Sampled minute by minute, so the
 * edges land on real crossings (sun dropping through 42, or setting), not
 * on hour boundaries. Look direction and sun elevation are reported at the
 * midpoint of the stretch.
 *
 * @param {number} epochSec start of the forecast hour (unix seconds)
 * @param {number} lat observer latitude
 * @param {number} lon observer longitude
 * @returns {null | { startEpoch: number, endEpoch: number, sunElevation: number,
 *                    sunAzimuth: number, lookAzimuth: number, look: string }}
 *          null when no minute of the hour qualifies.
 */
export function bowGeometry(epochSec, lat, lon) {
  let first = null;
  let last = null;
  for (let m = 0; m < 60; m++) {
    const t = epochSec + m * 60;
    const { elevation } = sunPositionDeg(new Date(t * 1000), lat, lon);
    if (elevation > 0 && elevation <= MAX_BOW_ELEVATION) {
      if (first == null) first = t;
      last = t;
    }
  }
  if (first == null) return null;

  const mid = new Date(((first + last) / 2) * 1000);
  const pos = sunPositionDeg(mid, lat, lon);
  const lookAzimuth = (pos.azimuth + 180) % 360;
  return {
    startEpoch: first,
    endEpoch: last + 60, // the window closes at the end of the last qualifying minute
    sunElevation: pos.elevation,
    sunAzimuth: pos.azimuth,
    lookAzimuth,
    look: compassPoint(lookAzimuth),
  };
}

/**
 * Join two time labels into a window, dropping a repeated AM/PM suffix:
 * "6:40 PM" + "7:15 PM" -> "6:40-7:15 PM", but "11:40 AM" + "12:10 PM"
 * keeps both suffixes. Returns null if either label is missing.
 */
export function formatWindow(startLabel, endLabel) {
  if (!startLabel || !endLabel) return null;
  const suffix = / (AM|PM)$/;
  const s = startLabel.match(suffix);
  const e = endLabel.match(suffix);
  if (s && e && s[1] === e[1]) return `${startLabel.replace(suffix, '')}-${endLabel}`;
  return `${startLabel}-${endLabel}`;
}
