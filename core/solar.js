/**
 * Solar position: sun elevation angle above the horizon.
 *
 * Implements the NOAA solar-calculator algorithm (Meeus-derived), accurate to
 * well under 0.1° for the 1900–2100 range, which is far more precision than
 * the rainbow heuristic needs. Includes the standard atmospheric-refraction
 * correction so elevations near the horizon behave sensibly.
 */

const RAD = Math.PI / 180;

/**
 * Sun elevation in degrees for a given instant and observer position.
 *
 * @param {Date} date - the instant (any JS Date; internally uses its UTC time)
 * @param {number} latDeg - observer latitude, degrees north positive
 * @param {number} lonDeg - observer longitude, degrees east positive (Victoria ≈ -123.4)
 * @returns {number} apparent elevation in degrees (negative = below horizon)
 */
export function sunElevationDeg(date, latDeg, lonDeg) {
  return sunPositionDeg(date, latDeg, lonDeg).elevation;
}

/**
 * Sun elevation AND azimuth (degrees clockwise from true north) for a given
 * instant and observer position. Azimuth is needed to compare the sun's
 * direction with shower movement (wind): a rainbow appears opposite the sun,
 * so showers clearing toward the antisolar sky are ideal.
 *
 * @returns {{ elevation: number, azimuth: number }}
 */
export function sunPositionDeg(date, latDeg, lonDeg) {
  // Julian day / century from unix epoch
  const jd = date.getTime() / 86400000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;

  // Sun's geometric mean longitude and mean anomaly (degrees)
  const meanLong = mod360(280.46646 + jc * (36000.76983 + jc * 0.0003032));
  const meanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  // Equation of center -> true / apparent longitude
  const eqOfCenter =
    Math.sin(meanAnom * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * meanAnom * RAD) * 0.000289;
  const trueLong = meanLong + eqOfCenter;
  const apparentLong =
    trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * RAD);

  // Obliquity of the ecliptic (corrected) -> solar declination
  const meanObliq =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * RAD);
  const declination =
    Math.asin(Math.sin(obliq * RAD) * Math.sin(apparentLong * RAD)) / RAD;

  // Equation of time (minutes)
  const varY = Math.tan((obliq / 2) * RAD) ** 2;
  const eqOfTime =
    (4 / RAD) *
    (varY * Math.sin(2 * meanLong * RAD) -
      2 * ecc * Math.sin(meanAnom * RAD) +
      4 * ecc * varY * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * varY * varY * Math.sin(4 * meanLong * RAD) -
      1.25 * ecc * ecc * Math.sin(2 * meanAnom * RAD));

  // True solar time (minutes of day) -> hour angle (degrees)
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = mod(utcMinutes + eqOfTime + 4 * lonDeg, 1440);
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  // Zenith -> geometric elevation
  const zenith =
    Math.acos(
      Math.sin(latDeg * RAD) * Math.sin(declination * RAD) +
        Math.cos(latDeg * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD),
    ) / RAD;
  const elevation = 90 - zenith;

  // Azimuth (NOAA spreadsheet formula), clockwise from true north
  const acosArg = clamp(
    (Math.sin(latDeg * RAD) * Math.cos(zenith * RAD) - Math.sin(declination * RAD)) /
      (Math.cos(latDeg * RAD) * Math.sin(zenith * RAD)),
    -1,
    1,
  );
  const ac = Math.acos(acosArg) / RAD;
  const azimuth = hourAngle > 0 ? mod(ac + 180, 360) : mod(540 - ac, 360);

  return { elevation: elevation + refractionDeg(elevation), azimuth };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** NOAA approximate atmospheric refraction, degrees, as a function of geometric elevation. */
function refractionDeg(el) {
  if (el > 85) return 0;
  const te = Math.tan(el * RAD);
  let arcsec;
  if (el > 5) {
    arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (el > -0.575) {
    arcsec = 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)));
  } else {
    arcsec = -20.774 / te;
  }
  return arcsec / 3600;
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function mod360(n) {
  return mod(n, 360);
}
