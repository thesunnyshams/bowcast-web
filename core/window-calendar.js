/**
 * The rainbow window, as a year by hour grid.
 *
 * A bow needs the sun above the horizon and below 42 degrees. Both conditions
 * are pure solar geometry, so for any latitude the whole year's worth of
 * opportunity can be computed rather than described. This module is the single
 * source for that: the grid a city page draws, and every sentence the page says
 * about it, come from the same function, because a graphic that contradicts its
 * own caption is worse than no graphic.
 *
 * Browser-safe and dependency-free, like the rest of core/.
 */

/** The geometric ceiling for a primary bow: above this the arc is below the horizon. */
export const BOW_CEILING_DEG = 42;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// One representative day per month, near mid-month.
export const MID_MONTH_DAYS = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/**
 * Solar elevation for a day of year and local solar hour.
 * Declination by Cooper's equation; hour angle 15 degrees per hour from noon.
 */
export function solarElevation(latDeg, dayOfYear, hour) {
  const dec = 23.44 * Math.sin(rad((360 / 365) * (284 + dayOfYear)));
  const H = (hour - 12) * 15;
  const sinElev = Math.sin(rad(latDeg)) * Math.sin(rad(dec))
    + Math.cos(rad(latDeg)) * Math.cos(rad(dec)) * Math.cos(rad(H));
  return deg(Math.asin(clamp(sinElev, -1, 1)));
}

/** Which of the three states an hour is in. */
export function cellState(elev) {
  if (elev <= 0) return 'night';
  if (elev <= BOW_CEILING_DEG) return 'window';
  return 'above';
}

/**
 * The full 12 x 24 grid plus every fact derived from it.
 *
 * @param {number} latDeg
 * @returns {{
 *   grid: Array<Array<{hour: number, elev: number, state: string, weight: number}>>,
 *   monthsNeverReachingCeiling: number[],
 *   closedHoursByMonth: number[],
 *   seasonShares: Array<{season: string, months: number[], share: number|null}>,
 *   everReachesCeiling: boolean,
 *   alwaysOpen: boolean,
 *   polarNightMonths: number[],
 * }}
 */
export function windowCalendar(latDeg) {
  const grid = MID_MONTH_DAYS.map((doy) =>
    Array.from({ length: 24 }, (_, hour) => {
      const elev = solarElevation(latDeg, doy, hour);
      const state = cellState(elev);
      return {
        hour,
        elev: +elev.toFixed(2),
        state,
        // Inside the window, a lower sun is a better bow, so weight rises as
        // the sun falls. This drives cell opacity, nothing else.
        weight: state === 'window' ? 0.45 + 0.55 * (1 - elev / BOW_CEILING_DEG) : 0,
      };
    }));

  const closedHoursByMonth = grid.map((row) => row.filter((c) => c.state === 'above').length);
  const monthsNeverReachingCeiling = closedHoursByMonth
    .map((n, i) => (n === 0 ? i : -1))
    .filter((i) => i >= 0);
  const polarNightMonths = grid
    .map((row, i) => (row.every((c) => c.state === 'night') ? i : -1))
    .filter((i) => i >= 0);

  // Seasons by month, flipped below the equator so "summer" means the warm half
  // wherever the city actually is.
  const north = latDeg >= 0;
  const SEASONS = [
    { season: north ? 'Spring' : 'Autumn', months: [2, 3, 4] },
    { season: north ? 'Summer' : 'Winter', months: [5, 6, 7] },
    { season: north ? 'Autumn' : 'Spring', months: [8, 9, 10] },
    { season: north ? 'Winter' : 'Summer', months: [11, 0, 1] },
  ];
  const ORDER = ['Spring', 'Summer', 'Autumn', 'Winter'];

  const seasonShares = SEASONS.map(({ season, months }) => {
    let daylight = 0;
    let inWindow = 0;
    for (const m of months) {
      for (const cell of grid[m]) {
        if (cell.state === 'night') continue;
        daylight += 1;
        if (cell.state === 'window') inWindow += 1;
      }
    }
    // No daylight at all (polar winter) has no share, rather than a false zero.
    return { season, months, share: daylight === 0 ? null : Math.round((inWindow / daylight) * 100) };
  }).sort((a, b) => ORDER.indexOf(a.season) - ORDER.indexOf(b.season));

  return {
    grid,
    closedHoursByMonth,
    monthsNeverReachingCeiling,
    polarNightMonths,
    seasonShares,
    everReachesCeiling: closedHoursByMonth.some((n) => n > 0),
    alwaysOpen: closedHoursByMonth.every((n) => n === 0),
  };
}
