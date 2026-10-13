import {
  activeCalibrationVersion,
  calibrateEstimatedChance,
  SCORING_VERSION,
} from './probability-calibration.js';

/**
 * Rainbow likelihood scoring: v3.8.
 *
 * Published studies inform the ingredients and broad relationships:
 *  - Carlson et al. 2022 modeled photographed rainbow occurrence using liquid
 *    precipitation, cloud cover, sun angle, interactions, and diurnal timing.
 *  - Liu et al. 2023 studied three years of observations in ZhaoSu, China.
 *    About 90% of the observed rainbows occurred during the hour after
 *    rainfall. This is a regional result that informs Bowcast's preference
 *    for clearing showers, not a universal occurrence rate.
 *  - Businger 2021 describes why spaced convective showers, direct sun, and
 *    sufficiently large liquid drops produce favorable rainbow conditions.
 *
 * Per-hour formula (factors in [0,1] unless noted):
 *
 *   score = 100 · sunFactor · rainNear · elevationQuality
 *               · convective(1-1.15) · alignment(0.88-1.12)
 *               · windFactor · tempFactor · coincidence(0.5-1)
 *               · cloudConflict(0.5 or 1) · confidence
 *
 * The deterministic conditions score combines direct sunlight, liquid rain,
 * sun elevation, convection, wind alignment, sub-hour timing, confidence,
 * wind, and temperature. Geometry and frozen precipitation provide physical
 * gates. Other cutoffs, curves, and weights are Bowcast heuristics, even
 * where a study motivates the underlying relationship.
 *
 * Two rules govern how conflicting inputs are resolved, and they are
 * deliberately symmetric:
 *  - An explicit zero direct-sun signal cannot borrow a cloud-derived floor
 *    (v3.7).
 *  - An explicit positive direct-sun signal cannot be vetoed by an areal
 *    cloud fraction (v3.8). Sunshine duration and DNI are statements about
 *    the beam; cloud cover is a statement about sky area. When they
 *    contradict each other the beam wins, at half weight.
 *
 * The exact values are tunable. They require calibration against a large,
 * representative set of positive and negative sighting outcomes before the
 * estimated chance can be treated as a measured occurrence frequency.
 */

const MAX_BOW_ELEVATION = 42; // degrees; primary-bow geometric cutoff
const DRIZZLE_CODES = new Set([51, 53, 55, 56, 57]);
const FROZEN_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);

/**
 * Weight applied when a >96% areal cloud fraction meets a positive direct-sun
 * signal in the same interval.
 *
 * Bowcast's >96% gate is informed by a Carlson et al. 2022 CART split, but
 * when the same hour also reports sunshine the two fields contradict each
 * other and one of them is wrong at that grid point. A hard veto silently
 * picked the areal fraction: over Honolulu 2024 it zeroed 94 hours that had
 * rain nearby, bow-eligible geometry, and a median 46 minutes of forecast
 * sunshine, a fair description of the conditions Bowcast exists to find.
 *
 * The beam is the more direct physical statement, so it wins, at half weight
 * to keep the published split's direction. Where no direct-sun signal exists
 * to contradict the cloud fraction, callers veto the interval outright.
 */
const CLOUD_CONFLICT_WEIGHT = 0.5;

const LEVELS = [
  { min: 70, level: 'high' },
  { min: 50, level: 'good' },
  { min: 25, level: 'moderate' },
  { min: 1, level: 'low' },
  { min: 0, level: 'none' },
];

// Probability bands are lower than quality-score bands: even a textbook
// convective evening rarely exceeds ~50% member agreement.
const PROB_LEVELS = [
  { min: 45, level: 'high' },
  { min: 25, level: 'good' },
  { min: 10, level: 'moderate' },
  { min: 1, level: 'low' },
  { min: 0, level: 'none' },
];

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function levelFor(score) {
  return LEVELS.find((l) => score >= l.min).level;
}

/** How rainbow-friendly a liquid precipitation intensity is (mm/h). */
function dropQuality(mm) {
  if (mm <= 0.05) return 0; // effectively dry
  if (mm < 0.2) return 0.35; // trace: few drops to refract
  if (mm < 0.5) return 0.75; // light
  if (mm <= 4) return 1.0; // light–moderate: ideal, big drops, sky not blackened
  if (mm <= 8) return 0.6; // heavy: sky darkens
  return 0.3; // torrential
}

/** Whether the interval explicitly reports frozen precipitation. */
function frozenPrecipitation(h) {
  return !!h && ((h.snowMm ?? 0) > 0.1 || FROZEN_CODES.has(h.weatherCode));
}

/**
 * How much to discount precipitation that carries a drizzle weather code.
 *
 * True drizzle (drops well under 0.5 mm) makes a washed-out bow at best, so
 * the discount is physically motivated. The WMO code is a poor detector of
 * it: providers assign 51/53/55 to almost any light precipitation, and over
 * a year of Honolulu archive hours 432 of 454 liquid hours came back coded
 * as drizzle while none came back as showers. Leaning on the code alone put
 * a 4x swing on the headline number behind a categorical field that does not
 * support the weight.
 *
 * So the code opens the question and the physics closes it: real drizzle is
 * light AND non-convective. Intensity and CAPE, where present, override.
 */
function drizzleWeight(liquidMm, cape) {
  if (liquidMm >= 0.5) return 0.5; // too heavy to be drizzle whatever the code says
  if (Number.isFinite(cape) && cape >= 150) return 0.45; // convective, not stratus drizzle
  if (liquidMm >= 0.2) return 0.35;
  return 0.25; // light and non-convective: take the code at its word
}

/**
 * Rain signal for one hour: dropQuality × type weight (convective showers
 * beat stratiform rain beat drizzle), liquid only.
 * Returns { q, type } with type 'showers' | 'rain' | 'drizzle' | null.
 */
function rainSignal(h) {
  if (!h) return { q: 0, type: null };
  if (frozenPrecipitation(h)) return { q: 0, type: null };
  const showers = h.showersMm ?? 0;
  const rain = h.rainMm ?? Math.max(0, (h.precipMm ?? 0) - showers - (h.snowMm ?? 0));
  const liquid = showers + rain;
  if (liquid <= 0.05) return { q: 0, type: null };
  if ((h.tempC ?? 10) < 0.5) return { q: 0, type: null }; // frozen: no bow

  const drizzle = DRIZZLE_CODES.has(h.weatherCode);
  const rainWeight = drizzle ? drizzleWeight(liquid, h.cape) : 0.55;
  const typeWeight = (showers * 1.0 + rain * rainWeight) / liquid;
  const type = showers >= rain ? 'showers' : drizzle ? 'drizzle' : 'rain';
  return { q: dropQuality(liquid) * typeWeight, type };
}

/** Heuristic quality of direct sunlight during the hour. */
function sunFactor(h) {
  // Layered fallback: low cloud sits in front of the sun disc; thin high
  // cirrus barely matters. If layers are missing, use total cover.
  let cloudBased;
  if (h.cloudLow != null || h.cloudMid != null || h.cloudHigh != null) {
    cloudBased = clamp(
      1 - 0.9 * ((h.cloudLow ?? 0) / 100) - 0.5 * ((h.cloudMid ?? 0) / 100) - 0.15 * ((h.cloudHigh ?? 0) / 100),
      0,
      1,
    );
  } else {
    cloudBased = clamp(1 - 0.8 * ((h.cloudTotal ?? 50) / 100), 0, 1);
  }

  if (h.sunshineSec == null) return cloudBased;
  const sunlitFrac = clamp(h.sunshineSec / 3600, 0, 1);
  // ^0.4: a rainbow needs one sunny moment, not a sunny hour.
  return sunlitFrac ** 0.4;
}

/**
 * Strong wind shreds rain curtains and mixes drop sizes. Liu et al. observed
 * zero rainbows at Beaufort >= 8 (~75 km/h) and 60% below Beaufort 2.
 */
function windFactor(windKmh) {
  if (windKmh == null) return 1;
  if (windKmh <= 20) return 1;
  if (windKmh >= 75) return 0.1;
  if (windKmh >= 60) return 0.25;
  return 1 - ((windKmh - 20) / 40) * 0.45; // 20..60 km/h: 1.0 -> 0.55
}

/** Cold-rain bows are rare (Liu: none below 8 C). Freezing gate is separate. */
function tempFactor(tempC) {
  if (tempC == null) return 1;
  if (tempC >= 10) return 1;
  if (tempC <= 2) return 0.6;
  return 0.6 + 0.4 * ((tempC - 2) / 8);
}

/** Lower sun makes a taller, more dramatic bow. Valid only for 0 < el ≤ 42. */
function elevationQuality(el) {
  return 0.6 + 0.4 * (1 - el / MAX_BOW_ELEVATION);
}

/**
 * Prepared forecast intervals carry minute-resolved bow eligibility. Legacy
 * and synthetic callers without those fields retain the midpoint gate.
 */
function bowEligible(h) {
  if (Number.isFinite(h?.bowEligibleMinutes)) return h.bowEligibleMinutes > 0;
  return !!h?.isDay && h.sunElevation > 0 && h.sunElevation <= MAX_BOW_ELEVATION;
}

function bowElevation(h) {
  return Number.isFinite(h?.bowSunElevation) ? h.bowSunElevation : h?.sunElevation;
}

function bowAzimuth(h) {
  return Number.isFinite(h?.bowSunAzimuth) ? h.bowSunAzimuth : h?.sunAzimuth;
}

/**
 * Ensemble estimated chance: weighted model agreement on rainbow ingredients.
 *
 * Each ensemble member is one physically consistent "possible atmosphere".
 * For member m at hour i we ask: does THIS member put liquid rain in/next to
 * the hour while leaving enough gap for the sun disc? Averaging that over
 * all members summarizes forecast uncertainty and, unlike multiplying
 * marginal probabilities, respects the rain/cloud
 * correlation inside each member (rainy members are cloudier members).
 *
 * m: { precipMm: number[], rainMm: number[] (per-member liquid rain,
 *       optional), snowMm: number[] (mm water equivalent), cloudTotal:
 *       number[], dni: number[] (direct normal irradiance, W/m², optional),
 *       tempC: number[] (optional), windKmh: number[] (optional) },
 * arrays parallel to `hours` (nulls where the member has no data). Only
 * phase and solar data decide member usability; the optional temperature and
 * wind series gate a member that has them without excluding one that does
 * not, so models publishing fewer variables keep full coverage.
 *
 * Returns null when the member lacks usable phase or solar data for hour i
 * (it is excluded from that hour's estimate entirely), otherwise a weight
 * in [0, 1].
 */

/**
 * A member's liquid precipitation for hour j, in mm of water equivalent.
 * Prefers the model's own per-member rain (total precipitation includes
 * snow); falls back to precipitation minus snow water equivalent for models
 * that do not publish rain but do publish both total precipitation and snow.
 * Returns null when the member carries no usable phase signal for that hour;
 * hours outside the scored window claim no rain (0).
 */
function memberLiquidMm(m, j, len) {
  if (j < 0 || j >= len) return 0;
  const rain = m.rainMm?.[j];
  if (Number.isFinite(rain)) return rain;
  const precip = m.precipMm?.[j];
  const snow = m.snowMm?.[j];
  if (!Number.isFinite(precip)) return null;
  if (precip === 0) return 0;
  if (!Number.isFinite(snow)) return null;
  return Math.max(0, precip - snow);
}

/** Whether target-hour phase and sunlight are both represented by a member. */
function memberUsableAt(m, i, hours) {
  // Every in-range phase value consumed by the clearing/current/approaching
  // state must be known. Only a true array boundary is a structural dry zero.
  const liquidKnown = [i - 1, i, i + 1].every((j) => (
    j < 0 || j >= hours.length || memberLiquidMm(m, j, hours.length) != null
  ));
  const solarKnown = Number.isFinite(m.dni?.[i]) || Number.isFinite(m.cloudTotal?.[i]);
  return liquidKnown && solarKnown;
}

/** Members with usable target-hour inputs (the effective denominator). */
function effectiveMembersAt(members, i, hours) {
  if (!members) return 0;
  return members.reduce(
    (n, m) => n + (memberUsableAt(m, i, hours) ? 1 : 0),
    0,
  );
}

function memberHourP(m, i, hours) {
  const h = hours[i];
  if (!memberUsableAt(m, i, hours)) return null;
  if (!bowEligible(h)) return 0;
  if ((m.snowMm?.[i] ?? 0) > 0.1) return 0; // frozen precip: no bow

  // Below-freezing members produce no bow, mirroring rainSignal's liquid gate.
  // Members that carry no temperature series are not penalized for it.
  const memberTempC = m.tempC?.[i];
  if (Number.isFinite(memberTempC) && memberTempC < 0.5) return 0;

  // In-range neighbours are finite by memberUsableAt; only a structural array
  // boundary claims no rain.
  const liq = (j) => memberLiquidMm(m, j, hours.length) ?? 0;
  // Same temporal states as scoreHour: the post-rain clearing hour leads.
  const rainNear = Math.max(
    1.0 * dropQuality(liq(i - 1)),
    0.9 * dropQuality(liq(i)),
    0.6 * dropQuality(liq(i + 1)),
  );
  if (rainNear <= 0) return 0;

  // Sun signal: prefer per-member direct normal irradiance, the forecast solar
  // beam on the rain, ~700-900 W/m² in sun and ~0 under cloud. Cloud-cover
  // inference badly under-counts broken-cloud sun (a Hawaii trade-wind hour
  // can run 60% cloud with DNI 800), which is why the old probabilities read
  // far too low. Ramp around the WMO 120 W/m² sunshine threshold. Fall back
  // to a softened cloud curve only if this member has no DNI data.
  const sunAt = (j) => {
    const value = j >= 0 && j < hours.length ? m.dni?.[j] : null;
    const v = Number.isFinite(value) ? value : null;
    if (v == null) return null;
    return clamp((v - 80) / 240, 0, 1); // 80 -> 0, 320 -> 1, 120 W/m² ≈ 0.17
  };
  const s0 = sunAt(i);
  const overcast = (m.cloudTotal?.[i] ?? 0) > 96;
  let sun;
  if (s0 == null) {
    // No DNI for this member: cloud cover is the only solar signal it has, so
    // nothing contradicts the Carlson split and it vetoes outright.
    if (overcast) return 0;
    const cloud = m.cloudTotal?.[i];
    sun = clamp(1 - 0.7 * (cloud / 100), 0, 1); // finite by memberUsableAt
  } else {
    // Rain may be clearing from the previous interval, falling now, or
    // approaching in the next interval, but the beam must exist in THIS target
    // interval. Independently maximizing neighbouring DNI used to synthesize
    // a false event from old sunlight and later rain with darkness between.
    sun = s0;
  }
  if (sun <= 0) return 0;
  // Occurrence-flavored, not intensity-product. Averaging rainNear × sun
  // collapsed toward zero (a 0.4-rain × 0.9-sun member contributed 0.36, not
  // "1 member with sunlit rain"), understating broken-cloud regimes ~4x.
  // A member with liquid rain present has a bow chance that scales with the
  // direct sun on it; rain intensity affects brightness (the score's job),
  // not whether a bow occurs. So: gate on rain, weight by sun.
  //
  // Wind and temperature are occurrence gates, not brightness: Liu et al.
  // observed no rainbows at Beaufort >= 8 and none below 8 C. Before v3.8
  // they reached only the deterministic score, so a gale left the headline
  // estimated chance untouched. Members that carry no such series are
  // unaffected (both factors return 1 for a missing value).
  return sun
    * (overcast ? CLOUD_CONFLICT_WEIGHT : 1)
    * windFactor(m.windKmh?.[i])
    * tempFactor(memberTempC);
}

/**
 * The estimate is only as good as the members that actually reported: at
 * least half of them must carry usable target-hour data, or the hour returns
 * null and the surface falls back to the deterministic Conditions score.
 */
const MIN_MEMBER_COVERAGE = 0.5;

/**
 * Uncalibrated weighted estimate of rainbow ingredients, in whole percent.
 * Averages over the members that have usable data for this hour (the
 * effective denominator), never over the nominal member count; returns null
 * below the coverage floor so missing data cannot masquerade as a forecast.
 */
function rawHourProbability(members, i, hours) {
  if (!members || members.length === 0) return null;
  let effective = 0;
  let sum = 0;
  for (const m of members) {
    const p = memberHourP(m, i, hours);
    if (p == null) continue;
    effective += 1;
    sum += p;
  }
  if (effective === 0 || effective / members.length < MIN_MEMBER_COVERAGE) return null;
  return Math.round((100 * sum) / effective);
}

/**
 * CAPE ⇒ buoyant, cellular showers with sunny gaps between them.
 *
 * Absent CAPE means "no signal", not "no convection". The distinction is not
 * academic: the Open-Meteo historical archive returns an all-null CAPE array,
 * so every backtest and validation case runs with this factor pinned at 1
 * while the live forecast API supplies real values. Coercing null to zero
 * made the two cases indistinguishable and hid a dead factor for three
 * scoring versions. `scripts/backtest.js range` now reports CAPE coverage.
 */
function convectiveFactor(cape) {
  if (!Number.isFinite(cape)) return 1;
  return 1 + 0.15 * clamp(cape / 300, 0, 1);
}

/**
 * Liquid precipitation in one 15-minute entry, mm. Prefers the provider's own
 * rain field; falls back to precipitation minus snow water equivalent.
 */
function quarterLiquidMm(quarter) {
  if (!quarter) return 0;
  if (Number.isFinite(quarter.rainMm)) return quarter.rainMm;
  if (!Number.isFinite(quarter.precipMm)) return 0;
  if (quarter.precipMm === 0) return 0;
  return Math.max(0, quarter.precipMm - (Number.isFinite(quarter.snowMm) ? quarter.snowMm : 0));
}

/**
 * Did the sun and the rain actually overlap inside the hour?
 *
 * The largest physical error available to an hourly rainbow model is assuming
 * that rain and sunshine reported for the same hour happened at the same
 * time. Ten minutes of sun at 5:50 and a shower at 5:05 satisfy every hourly
 * test and produce no bow. Open-Meteo already returns 15-minute precipitation
 * and sunshine duration, which until now only labelled the best window.
 *
 * The sunny quarters of this hour are checked against liquid rain in the same
 * or an adjacent quarter, walking across the neighbouring hours so a genuine
 * clearing transition (rain in the previous hour's last quarter, sun in this
 * hour's first) still reads as coincident. Returns the share of this hour's
 * sunshine that landed next to rain, floored at 0.5: quarter resolution and
 * the forecast itself are both too coarse for a timing mismatch to veto.
 *
 * Returns 1 when the provider has no minute data, so nothing is penalized for
 * missing inputs.
 */
function coincidenceFactor(h, prev, next) {
  const qs = h?.quarters;
  if (!Array.isArray(qs) || qs.length < 2) return 1;
  if (qs.every((q) => q.sunshineSec == null)) return 1;

  // One sequence across the three hours, so adjacency survives hour edges.
  const before = Array.isArray(prev?.quarters) ? prev.quarters : [];
  const after = Array.isArray(next?.quarters) ? next.quarters : [];
  const merged = [...before, ...qs, ...after];
  const offset = before.length;

  // The provider only resolves 15-minute precipitation natively over parts of
  // Europe and North America; elsewhere the series is interpolated and can
  // report a flat zero for an hour the hourly data says is wet. Reading that
  // as a timing mismatch penalized whole regions for a data gap (it halved
  // Honolulu and Kochi), so the factor stays silent unless the minute data
  // actually carries the rain it is being asked to time.
  if (!merged.some((q) => quarterLiquidMm(q) > 0.02)) return 1;

  let sunTotal = 0;
  let sunNearRain = 0;
  qs.forEach((q, i) => {
    const sun = q.sunshineSec ?? 0;
    if (sun <= 0) return;
    sunTotal += sun;
    const j = offset + i;
    const wet = quarterLiquidMm(merged[j]) > 0.02
      || quarterLiquidMm(merged[j - 1]) > 0.02
      || quarterLiquidMm(merged[j + 1]) > 0.02;
    if (wet) sunNearRain += sun;
  });

  if (sunTotal <= 0) return 1; // sunFactor already owns the no-sun case
  return 0.5 + 0.5 * (sunNearRain / sunTotal);
}


/** Wind from the sun's direction clears showers toward the antisolar sky. */
function alignmentFactor(windDirDeg, sunAzimuth) {
  if (windDirDeg == null || sunAzimuth == null) return 1;
  const delta = ((windDirDeg - sunAzimuth) * Math.PI) / 180;
  return 1 + 0.12 * Math.cos(delta);
}

/**
 * Score one hour in context of its neighbours.
 * Returns { score, rainSource, rainType, sunlitPct }.
 */
function scoreHour(h, prev, next) {
  const sunlitPct =
    h.sunshineSec != null ? Math.round(clamp(h.sunshineSec / 3600, 0, 1) * 100) : null;

  if (!bowEligible(h)) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  if (frozenPrecipitation(h)) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  // Bowcast's >96% gate is informed by a Carlson et al. 2022 CART split.
  // Treating that observed relationship as a cutoff is still a heuristic, and
  // it only vetoes the hour outright when no direct-sun signal contradicts it.
  // (memberHourP applies the same rule per member, against that member's DNI.)
  const overcast = (h.cloudTotal ?? 0) > 96;
  const directSun = (h.sunshineSec ?? 0) > 0;
  if (overcast && !directSun) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  // Liu et al. 2023 found that about 90% of observed ZhaoSu rainbows occurred
  // during the hour after rainfall. The clearing transition gets the highest
  // Bowcast weight, but the regional rate is not assumed to be universal.
  const candidates = [
    { source: 'clearing', weight: 1.0, hour: prev },
    { source: 'now', weight: 0.9, hour: h },
    { source: 'approaching', weight: 0.6, hour: next },
  ].map((c) => {
    const { q, type } = rainSignal(c.hour);
    return { ...c, value: q * c.weight, type };
  });
  const best = candidates.reduce((a, b) => (b.value > a.value ? b : a));
  if (best.value <= 0) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  const rainNear = best.value;
  const rainType = best.type;
  const confidence = 0.3 + 0.7 * ((best.hour.precipProb ?? 70) / 100);

  const score =
    100 *
    sunFactor(h) *
    rainNear *
    elevationQuality(bowElevation(h)) *
    convectiveFactor(h.cape) *
    alignmentFactor(h.windDirDeg, bowAzimuth(h)) *
    windFactor(h.windKmh) *
    tempFactor(h.tempC) *
    coincidenceFactor(h, prev, next) *
    (overcast ? CLOUD_CONFLICT_WEIGHT : 1) *
    confidence;

  return {
    score: Math.round(clamp(score, 0, 100)),
    rainSource: best.source,
    rainType,
    sunlitPct,
  };
}

const RAIN_PHRASE = {
  showers: { now: 'showers around', clearing: 'a shower clearing out', approaching: 'a shower moving in' },
  rain: { now: 'rain nearby', clearing: 'rain clearing out', approaching: 'rain moving in' },
  drizzle: { now: 'drizzle about', clearing: 'drizzle clearing', approaching: 'drizzle moving in' },
};

function sunPhrase(sunlitPct, h) {
  if (sunlitPct == null) {
    return (h.cloudTotal ?? 50) < 50 ? 'plenty of sun' : 'some sun through the clouds';
  }
  if (sunlitPct >= 60) return `long sunny spells (${sunlitPct}% of the hour)`;
  if (sunlitPct >= 25) return `sunny breaks (${sunlitPct}% of the hour)`;
  if (sunlitPct > 0) return `brief glimpses of sun (${sunlitPct}% of the hour)`;
  return 'sun mostly hidden';
}

// English text for each zeroReasonKind() outcome. Keyed by kind so reasonParts
// can carry the machine-readable kind while `reason` keeps the exact prose.
const ZERO_REASON_TEXT = {
  dry: 'Bone-dry forecast: no rain means no rainbow today.',
  highSun: 'Rain comes only while the sun is too high (or set) for a bow.',
  noSun: 'Rain around, but no direct sun forecast to light it up while the sun is low.',
};

/** Which fundamental ingredient a zero-score day is missing, most to least basic. */
function zeroReasonKind(hours) {
  const anyLiquid = hours.some((h) => rainSignal(h).q > 0);
  if (!anyLiquid) return 'dry';

  const lowSunHours = hours.filter(
    (h) => h.isDay && h.sunElevation > 0 && h.sunElevation <= MAX_BOW_ELEVATION,
  );
  const rainAtLowSun = lowSunHours.some(
    (h, i, arr) => rainSignal(h).q > 0 || rainSignal(arr[i - 1]).q > 0 || rainSignal(arr[i + 1]).q > 0,
  );
  if (anyLiquid && !rainAtLowSun) return 'highSun';
  return 'noSun';
}

/**
 * Score a full day for one location.
 *
 * @param {Array<object>} hours chronologically ordered hourly entries:
 *   { epoch, label, sunElevation, sunAzimuth, isDay, precipMm, rainMm,
 *     showersMm, snowMm, precipProb, weatherCode, cloudLow, cloudMid,
 *     cloudHigh, cloudTotal, sunshineSec, cape, windDirDeg, tempC,
 *     quarters?: [{ epoch, label, precipMm, sunshineSec }] }
 * @param {Array<object>|null} members optional ensemble members, each
 *   { precipMm: number[], rainMm: number[], snowMm: number[] (mm water
 *   equivalent), cloudTotal: number[], dni: number[], tempC?: number[],
 *   windKmh?: number[] } with arrays parallel
 *   to `hours`. When present and at least one hour clears the member-coverage
 *   floor, `probability` is computed and becomes the headline: best hour,
 *   level, and reason key off it, while `score` remains the deterministic
 *   conditions-quality number.
 * @param {{nowEpochSeconds?: number|null}} [opts] when `nowEpochSeconds` is
 *   supplied, two forward-looking summaries are added to the return value:
 *   `nextPeak` (the best interval whose end is still ahead of now, the
 *   actionable target) and `currentInterval` (the interval containing now).
 *   The existing fields keep describing the whole-day peak (retrospective).
 *   When `nowEpochSeconds` is null the return value is byte-identical to
 *   before: neither key is added.
 * @param {number} [opts.targetStartIndex=0] first publishable hour when the
 *   input includes hidden neighbouring context.
 * @param {number} [opts.targetEndIndex=hours.length] exclusive end of the
 *   publishable target range. Context hours affect transitions but cannot win.
 * @returns {{probability, score, level, bestHour, bestInterval, bestEpoch,
 *            bestIntervalStartEpoch, bestIntervalEndEpoch, bestWindow, reason,
 *            reasonParts, hourly, nextPeak?, currentInterval?}}
 *   reasonParts is a small { kind, rainType?, rainSource?, sunlitPct?,
 *   cloudTotal? } object: the minimal data (beyond this same result's other
 *   fields) a UI needs to recompose `reason` in another language. See the
 *   comment above its construction for the five `kind` values.
 */
export function scoreLocation(hours, members = null, opts = {}) {
  const {
    nowEpochSeconds = null,
    targetStartIndex = 0,
    targetEndIndex = hours.length,
  } = opts;
  const scored = hours.map((h, i) => ({
    ...h,
    ...scoreHour(h, hours[i - 1], hours[i + 1]),
    rawProbability: rawHourProbability(members, i, hours),
  }));
  scored.forEach((hour) => {
    hour.probability = calibrateEstimatedChance(hour.rawProbability);
  });
  const targetScored = scored.slice(targetStartIndex, targetEndIndex);
  if (targetScored.length === 0) throw new RangeError('scoreLocation target range must contain an hour');

  // An ensemble only counts when it produced at least one usable estimate
  // during physically eligible rainbow geometry. Night and high-sun hours
  // legitimately score zero, but they must not make a sparse ensemble look
  // complete while every actionable low-sun hour is missing member data.
  const estimateHours = targetScored.filter((h) => bowEligible(h)
    && h.rawProbability != null);
  const hasEnsemble = Array.isArray(members) && members.length > 0
    && estimateHours.length > 0;

  // Headline hour: member agreement when we have an ensemble (quality as
  // tiebreak), otherwise the deterministic score. In ensemble mode, exclude
  // hours below the completeness floor rather than silently ranking them as
  // zero percent.
  const rank = (h) => (hasEnsemble ? (h.probability ?? 0) * 1000 + h.score : h.score);
  const headlineHours = hasEnsemble ? estimateHours : targetScored;
  const best = headlineHours.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const headline = hasEnsemble ? (best.probability ?? 0) : best.score;

  // Advertise the members that actually informed the best hour, never the
  // nominal roster ("28 of 40" when some members had no usable data).
  const bestIdx = scored.indexOf(best);
  const effective = hasEnsemble ? effectiveMembersAt(members, bestIdx, hours) : 0;
  const provenanceFor = (hour) => {
    if (!hasEnsemble || hour?.probability == null) return null;
    return {
      total: members.length,
      effective: effectiveMembersAt(members, scored.indexOf(hour), hours),
    };
  };
  const memberPhrase = hasEnsemble && effective < members.length
    ? `${effective} of ${members.length} forecast members`
    : `${members?.length ?? 0} forecast members`;

  // reasonParts: the minimal data a UI needs to recompose `reason` in another
  // language. `kind` selects which of the five sentence shapes applies:
  //  - 'dry' | 'highSun' | 'noSun': the three zero-score explanations, fixed
  //    English sentences with no interpolation (ZERO_REASON_TEXT).
  //  - 'zeroEnsemble': ensemble ran but found nothing; the member counts it
  //    needs are already on the sibling `ensembleMembers` field.
  //  - 'best': a headline hour exists. `rainType`/`rainSource` select a
  //    RAIN_PHRASE entry, `sunlitPct`/`cloudTotal` select a sunPhrase entry;
  //    the interval and probability/score it also needs are the sibling
  //    bestIntervalStartEpoch/bestIntervalEndEpoch/probability/score fields.
  let reason;
  let reasonParts;
  if (headline === 0) {
    if (hasEnsemble) {
      reason = `No usable forecast member combined liquid precipitation with a direct solar beam during eligible bow geometry (Estimated chance from ${memberPhrase}: 0%).`;
      reasonParts = { kind: 'zeroEnsemble' };
    } else {
      const kind = zeroReasonKind(hours);
      reason = ZERO_REASON_TEXT[kind];
      reasonParts = { kind };
    }
  } else {
    const phrases = RAIN_PHRASE[best.rainType] ?? RAIN_PHRASE.rain;
    const rainPhrase = phrases[best.rainSource] ?? 'rain nearby';
    reason = hasEnsemble
      ? `Best during ${best.label}: ${best.probability}% estimated chance, a weighted estimate from ${memberPhrase} (${sunPhrase(best.sunlitPct, best)} with ${rainPhrase}).`
      : `Best during ${best.label}: ${sunPhrase(best.sunlitPct, best)} with ${rainPhrase} (conditions score ${best.score}/100).`;
    reasonParts = {
      kind: 'best',
      rainType: best.rainType ?? null,
      rainSource: best.rainSource ?? null,
      sunlitPct: best.sunlitPct ?? null,
      cloudTotal: Number.isFinite(best.cloudTotal) ? best.cloudTotal : null,
    };
  }

  const hasBest = headline > 0;
  const bestStartEpoch = best.validFromEpoch ?? best.epoch;
  const bestEndEpoch = best.validToEpoch ?? (Number.isFinite(bestStartEpoch) ? bestStartEpoch + 3600 : null);

  // Forward-looking summaries: only computed when the caller supplies "now".
  // Interval bounds use the half-open contract [validFromEpoch, validToEpoch);
  // the epoch+3600 fallback keeps legacy hour shapes working.
  const hourEnd = (h) => h.validToEpoch ?? (Number.isFinite(h.epoch) ? h.epoch + 3600 : null);
  const hourStart = (h) => h.validFromEpoch ?? h.epoch;

  let nextPeak = null;
  let currentInterval = null;
  if (nowEpochSeconds != null) {
    // nextPeak ranks only hours that have not wholly elapsed (end > now) with
    // the same rule as the whole-day best, so the actionable target never
    // points at history.
    const futureHours = headlineHours.filter((h) => {
      const end = hourEnd(h);
      return end != null && end > nowEpochSeconds;
    });
    if (futureHours.length) {
      const nextBest = futureHours.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      const nextHeadline = hasEnsemble ? (nextBest.probability ?? 0) : nextBest.score;
      if (nextHeadline > 0) {
        const nStart = hourStart(nextBest);
        const nEnd = nextBest.validToEpoch ?? (Number.isFinite(nStart) ? nStart + 3600 : null);
        nextPeak = {
          probability: hasEnsemble ? nextHeadline : null,
          score: nextBest.score,
          level: hasEnsemble ? probLevelFor(nextHeadline) : levelFor(nextBest.score),
          interval: nextBest.label,
          intervalStartEpoch: nStart,
          intervalEndEpoch: nEnd,
          window: bestQuarterLabel(nextBest),
          ensembleMembers: provenanceFor(nextBest),
        };
      }
    }

    // currentInterval is strictly the interval containing now: never an
    // expired or future substitute.
    const current = targetScored.find((h) => {
      const start = hourStart(h);
      const end = hourEnd(h);
      return Number.isFinite(start) && Number.isFinite(end)
        && nowEpochSeconds >= start && nowEpochSeconds < end;
    });
    if (current) {
      const currentHasEstimate = hasEnsemble && current.probability != null;
      const cHeadline = currentHasEstimate ? current.probability : current.score;
      currentInterval = {
        probability: currentHasEstimate ? current.probability : null,
        score: current.score,
        level: currentHasEstimate ? probLevelFor(cHeadline) : levelFor(current.score),
        interval: current.label,
        intervalStartEpoch: hourStart(current),
        intervalEndEpoch: current.validToEpoch ?? (Number.isFinite(hourStart(current)) ? hourStart(current) + 3600 : null),
        ensembleMembers: provenanceFor(current),
      };
    }
  }

  const result = {
    probability: hasEnsemble ? headline : null,
    rawProbability: hasEnsemble ? best.rawProbability : null,
    // How many members actually informed the best hour, next to the roster
    // size, so consumers can audit estimate provenance.
    ensembleMembers: hasEnsemble
      ? { total: members.length, effectiveAtBest: effective }
      : null,
    score: best.score,
    scoringVersion: SCORING_VERSION,
    calibrationVersion: activeCalibrationVersion(),
    level: hasEnsemble ? probLevelFor(headline) : levelFor(best.score),
    // bestHour remains as a compatibility alias, but its value is now an
    // explicit interval label such as "5-6 PM" rather than an ambiguous point.
    bestHour: hasBest ? best.label : null,
    bestInterval: hasBest ? best.label : null,
    bestEpoch: hasBest ? bestStartEpoch : null,
    bestIntervalStartEpoch: hasBest ? bestStartEpoch : null,
    bestIntervalEndEpoch: hasBest ? bestEndEpoch : null,
    bestWindow: hasBest ? bestQuarterLabel(best) : null,
    reason,
    reasonParts,
    hourly: targetScored.map((h) => ({
      epoch: h.epoch,
      providerEpoch: h.providerEpoch ?? null,
      validFromEpoch: h.validFromEpoch ?? h.epoch,
      validToEpoch: h.validToEpoch ?? (Number.isFinite(h.epoch) ? h.epoch + 3600 : null),
      validForEpoch: h.validForEpoch ?? null,
      label: h.label,
      startLabel: h.startLabel ?? h.label,
      probability: h.probability,
      rawProbability: h.rawProbability,
      ensembleMembers: provenanceFor(h),
      score: h.score,
      precipMm: h.precipMm,
      precipProb: h.precipProb,
      cloudCover: h.cloudTotal,
      sunlitPct: h.sunlitPct,
      rainType: h.rainType,
      sunElevation: Math.round(h.sunElevation * 10) / 10,
      bowEligibleMinutes: Number.isFinite(h.bowEligibleMinutes) ? h.bowEligibleMinutes : null,
      bowEligibleFraction: Number.isFinite(h.bowEligibleFraction)
        ? Math.round(h.bowEligibleFraction * 1000) / 1000
        : null,
      bowWindowStartEpoch: h.bowWindowStartEpoch ?? null,
      bowWindowEndEpoch: h.bowWindowEndEpoch ?? null,
      look: h.bowLook ?? null,
    })),
  };

  // Additive only: absent when the caller does not pass a clock, so existing
  // callers and fixtures see byte-identical output.
  if (nowEpochSeconds != null) {
    result.nextPeak = nextPeak;
    result.currentInterval = currentInterval;
  }

  return result;
}

function probLevelFor(prob) {
  return PROB_LEVELS.find((l) => prob >= l.min).level;
}

/**
 * Refine the best hour to a 15-minute window using minutely data when the
 * provider has it: the sunniest quarter-hour that still has rain in or next
 * to it. Returns a label like "6:45 PM" or null.
 */
function bestQuarterLabel(hour) {
  const qs = hour.quarters;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  if (qs.every((q) => q.sunshineSec == null)) return null;

  let best = null;
  let bestVal = 0;
  qs.forEach((q, i) => {
    const sun = clamp((q.sunshineSec ?? 0) / 900, 0, 1) ** 0.4;
    const rainNearby =
      quarterLiquidMm(q) > 0.02 ||
      quarterLiquidMm(qs[i - 1]) > 0.02 ||
      quarterLiquidMm(qs[i + 1]) > 0.02;
    const val = sun * (rainNearby ? 1 : 0);
    if (val > bestVal) {
      bestVal = val;
      best = q;
    }
  });
  return bestVal > 0 && best ? best.label : null;
}
