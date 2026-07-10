/**
 * Rainbow likelihood scoring: v3.3.
 *
 * Grounded in published work on rainbow occurrence:
 *  - Carlson et al. 2022, "Global rainbow distribution under current and
 *    future climates" (Global Environ. Change): a regression-tree model whose
 *    predictors are LIQUID precipitation (snow makes no bow), cloud cover,
 *    and sun angle, including their interactions and diurnal timing.
 *  - Liu et al. 2023, "Research on rainbow probabilistic forecast model based
 *    on meteorological conditions in ZhaoSu region" (Meteorol. Appl. 30:e2131,
 *    Brier-validated on 3 years of observed rainbows): ~94% of rainbows
 *    appeared in the hour right AFTER rain ended, so the clearing transition
 *    outweighs rain-overhead; 84% came from plain showers vs 1.2% stratiform;
 *    observed hard gates at Beaufort >= 8 wind (~75 km/h), temperature below
 *    ~8 C, and cloud cover below 40% (no cloud means no rain shaft to light).
 *  - Businger 2021, "The Secrets of the Best Rainbows on Earth" (BAMS):
 *    the best bows come from spaced CONVECTIVE showers with direct sun
 *    reaching the rain between cells; stratiform rain under full overcast
 *    almost never produces bows; drizzle (tiny drops) gives faint, washed-out
 *    bows; shower cells clearing downwind toward the antisolar sky put fresh
 *    rain exactly where the bow forms.
 *
 * Per-hour formula (factors in [0,1] unless noted):
 *
 *   score = 100 · sunFactor · rainNear · elevationQuality
 *               · convective(1–1.15) · alignment(0.88–1.12) · confidence
 *
 * Hard gates (score = 0): not daylight, sun elevation outside (0°, 42°],
 * near/below freezing (frozen precip), total cloud cover > 96% (Carlson et
 * al. 2022: none of 7,094 photographed rainbows occurred above their CART
 * split), or no rain signal at all (neither actual liquid precip in
 * this/adjacent hours nor any precip probability).
 *
 * sunFactor    — from forecast direct-beam sunshine_duration (fraction of the
 *                hour with direct sun, ^0.4 so brief breaks still count — a
 *                rainbow only needs a moment of sun). Falls back to layered
 *                cloud cover (low cloud blocks the sun disc far more than
 *                high cirrus). A half-weight cloud floor guards against the
 *                WMO 120 W/m² sunshine threshold under-counting low sun.
 * rainNear     — liquid rain in the antisolar sky, best of: last hour clearing
 *                out (×1.0, Liu's ~94% post-rain finding), this hour (×0.9),
 *                next hour approaching (×0.6).
 *                Each = dropQuality(mm) · typeWeight, where convective showers
 *                weigh 1.0, stratiform rain 0.55, drizzle 0.25.
 *                If no actual precip but the forecast gives a precipitation
 *                PROBABILITY, use potential mode: 0.45 · (prob/100)^1.2 scaled
 *                by cloud presence (Liu: no rainbows under <40% cloud) — this
 *                is what turns a "maybe a shower" day into a graded low score
 *                instead of a blank zero.
 * windFactor   — strong wind shreds rain curtains and mixes drop sizes: 1.0
 *                below 20 km/h tapering to a hard floor near Beaufort 8.
 * tempFactor   — cold-rain bows are rare (Liu: none below 8 C): tapers from
 *                1.0 above 10 C down to 0.6 near 2 C (freezing gate separate).
 * elevationQuality — lower sun ⇒ taller bow: 1.0 at horizon → 0.6 at 42°.
 * convective   — CAPE bonus: buoyant air means spaced shower cells with gaps
 *                (Businger's ideal), up to ×1.15 at CAPE ≥ 300 J/kg.
 * alignment    — wind blowing FROM the sun's azimuth pushes showers toward
 *                the antisolar sky: ×(1 + 0.12·cos(windFrom − sunAz)).
 * confidence   — 0.3 + 0.7·(precip probability) for actual-precip hours;
 *                1.0 in potential mode (probability already consumed).
 *
 * All thresholds are tunable — adjust against observed rainbow days.
 */

const MAX_BOW_ELEVATION = 42; // degrees; primary-bow geometric cutoff
const DRIZZLE_CODES = new Set([51, 53, 55, 56, 57]);

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
  if (mm < 0.2) return 0.35; // trace — few drops to refract
  if (mm < 0.5) return 0.75; // light
  if (mm <= 4) return 1.0; // light–moderate: ideal, big drops, sky not blackened
  if (mm <= 8) return 0.6; // heavy: sky darkens
  return 0.3; // torrential
}

/**
 * Rain signal for one hour: dropQuality × type weight (convective showers
 * beat stratiform rain beat drizzle), liquid only.
 * Returns { q, type } with type 'showers' | 'rain' | 'drizzle' | null.
 */
function rainSignal(h) {
  if (!h) return { q: 0, type: null };
  const showers = h.showersMm ?? 0;
  const rain = h.rainMm ?? Math.max(0, (h.precipMm ?? 0) - showers - (h.snowMm ?? 0));
  const liquid = showers + rain;
  if (liquid <= 0.05) return { q: 0, type: null };
  if ((h.tempC ?? 10) < 0.5) return { q: 0, type: null }; // frozen — no bow

  const drizzle = DRIZZLE_CODES.has(h.weatherCode);
  const rainWeight = drizzle ? 0.25 : 0.55;
  const typeWeight = (showers * 1.0 + rain * rainWeight) / liquid;
  const type = showers >= rain ? 'showers' : drizzle ? 'drizzle' : 'rain';
  return { q: dropQuality(liquid) * typeWeight, type };
}

/** Chance the sun disc actually shines during the hour. */
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
  return Math.max(sunlitFrac ** 0.4, 0.5 * cloudBased);
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
 * Ensemble probability — Monte Carlo estimate of P(rainbow ingredients).
 *
 * Each ensemble member is one physically consistent "possible atmosphere".
 * For member m at hour i we ask: does THIS member put liquid rain in/next to
 * the hour while leaving enough gap for the sun disc? Averaging that over
 * all members integrates the scoring physics over forecast uncertainty —
 * and, unlike multiplying marginal probabilities, it respects the rain/cloud
 * correlation inside each member (rainy members are cloudier members).
 *
 * m: { precipMm: number[], snowMm: number[], cloudTotal: number[],
 *       dni: number[] (direct normal irradiance, W/m², optional) },
 * arrays parallel to `hours` (nulls where the member has no data).
 */
function memberHourP(m, i, hours) {
  const h = hours[i];
  if (!h.isDay || h.sunElevation <= 0 || h.sunElevation > MAX_BOW_ELEVATION) return 0;
  if ((m.snowMm?.[i] ?? 0) > 0.1) return 0; // frozen precip — no bow
  // Carlson 2022 cloud gate (ensemble mirror of scoreHour's).
  if ((m.cloudTotal?.[i] ?? 0) > 96) return 0;

  const liq = (j) => (j >= 0 && j < hours.length ? m.precipMm?.[j] ?? 0 : 0);
  // Same temporal weights as scoreHour: the post-rain clearing hour leads.
  const rainNear = Math.max(
    1.0 * dropQuality(liq(i - 1)),
    0.9 * dropQuality(liq(i)),
    0.6 * dropQuality(liq(i + 1)),
  );
  if (rainNear <= 0) return 0;

  // Sun signal: prefer per-member direct normal irradiance — the actual solar
  // beam on the rain, ~700-900 W/m² in sun and ~0 under cloud. Cloud-cover
  // inference badly under-counts broken-cloud sun (a Hawaii trade-wind hour
  // can run 60% cloud with DNI 800), which is why the old probabilities read
  // far too low. Ramp around the WMO 120 W/m² sunshine threshold. Fall back
  // to a softened cloud curve only if this member has no DNI data.
  const dni = (j) => (j >= 0 && j < hours.length ? m.dni?.[j] ?? null : null);
  const sunAt = (j) => {
    const v = dni(j);
    if (v == null) return null;
    return clamp((v - 80) / 240, 0, 1); // 80 -> 0, 320 -> 1, 120 W/m² ≈ 0.17
  };
  const s0 = sunAt(i);
  let sun;
  if (s0 == null) {
    const cloud = m.cloudTotal?.[i];
    sun = cloud == null ? 0.5 : clamp(1 - 0.7 * (cloud / 100), 0, 1); // >96 gated above
  } else {
    sun = Math.max(s0, 0.6 * (sunAt(i - 1) ?? 0), 0.6 * (sunAt(i + 1) ?? 0));
  }
  if (sun <= 0) return 0;
  // Occurrence-flavored, not intensity-product. Averaging rainNear × sun
  // collapsed toward zero (a 0.4-rain × 0.9-sun member contributed 0.36, not
  // "1 member with sunlit rain"), understating broken-cloud regimes ~4x.
  // A member with liquid rain present has a bow chance that scales with the
  // direct sun on it; rain intensity affects brightness (the score's job),
  // not whether a bow occurs. So: gate on rain, weight by sun.
  return sun;
}

/** P(rainbow ingredients at hour i) in whole percent, or null without members. */
function hourProbability(members, i, hours) {
  if (!members || members.length === 0) return null;
  const sum = members.reduce((acc, m) => acc + memberHourP(m, i, hours), 0);
  return Math.round((100 * sum) / members.length);
}

/** CAPE ⇒ buoyant, cellular showers with sunny gaps between them. */
function convectiveFactor(cape) {
  return 1 + 0.15 * clamp((cape ?? 0) / 300, 0, 1);
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

  if (!h.isDay || h.sunElevation <= 0 || h.sunElevation > MAX_BOW_ELEVATION) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  // Carlson et al. 2022: none of 7,094 photographed rainbows occurred under
  // > 96% total cloud cover (their CART split). Near-total overcast leaves no
  // sun disc to light the rain, even when a few minutes of sunshine register.
  // (The ensemble memberHourP path keeps its own soft 0.05 overcast floor: a
  // probabilistic estimate should fold in the chance of an unresolved break.)
  if ((h.cloudTotal ?? 0) > 96) {
    return { score: 0, rainSource: null, rainType: null, sunlitPct };
  }

  // Liu et al. 2023: ~94% of observed rainbows appeared in the hour right
  // after rain ended, so the clearing transition carries the top weight.
  const candidates = [
    { source: 'clearing', weight: 1.0, hour: prev },
    { source: 'now', weight: 0.9, hour: h },
    { source: 'approaching', weight: 0.6, hour: next },
  ].map((c) => {
    const { q, type } = rainSignal(c.hour);
    return { ...c, value: q * c.weight, type };
  });
  let best = candidates.reduce((a, b) => (b.value > a.value ? b : a));

  let rainNear;
  let confidence;
  let rainType;
  if (best.value > 0) {
    rainNear = best.value;
    rainType = best.type;
    confidence = 0.3 + 0.7 * ((best.hour.precipProb ?? 70) / 100);
  } else {
    // Potential mode: no deterministic precip, but the ensemble says showers
    // are possible — grade it instead of collapsing to zero. Scale by cloud
    // presence: Liu observed no rainbows under <40% cloud (a rain shaft
    // needs a cloud), which disciplines clear-sky probability blips.
    const prob = Math.max(h.precipProb ?? 0, prev?.precipProb ?? 0);
    if (prob <= 0 || (h.tempC ?? 10) < 0.5) {
      return { score: 0, rainSource: null, rainType: null, sunlitPct };
    }
    const cloudPresence = clamp((h.cloudTotal ?? 50) / 40, 0.1, 1);
    rainNear = 0.45 * (prob / 100) ** 1.2 * cloudPresence;
    rainType = 'possible';
    confidence = 1; // probability already consumed by rainNear
    best = { source: 'possible' };
  }

  const score =
    100 *
    sunFactor(h) *
    rainNear *
    elevationQuality(h.sunElevation) *
    convectiveFactor(h.cape) *
    alignmentFactor(h.windDirDeg, h.sunAzimuth) *
    windFactor(h.windKmh) *
    tempFactor(h.tempC) *
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
  possible: { possible: 'a chance of a passing shower' },
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

/** Explain a zero-score day, from most to least fundamental missing piece. */
function zeroReason(hours) {
  const anyLiquid = hours.some((h) => rainSignal(h).q > 0);
  const anyProb = hours.some((h) => h.isDay && (h.precipProb ?? 0) > 0);
  if (!anyLiquid && !anyProb) {
    return 'Bone-dry forecast: no rain means no rainbow today.';
  }

  const lowSunHours = hours.filter(
    (h) => h.isDay && h.sunElevation > 0 && h.sunElevation <= MAX_BOW_ELEVATION,
  );
  const rainAtLowSun = lowSunHours.some(
    (h, i, arr) => rainSignal(h).q > 0 || rainSignal(arr[i - 1]).q > 0 || rainSignal(arr[i + 1]).q > 0,
  );
  if (anyLiquid && !rainAtLowSun) {
    return 'Rain comes only while the sun is too high (or set) for a bow.';
  }
  return 'Rain around, but no direct sun forecast to light it up while the sun is low.';
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
 *   { precipMm: number[], snowMm: number[], cloudTotal: number[] } with
 *   arrays parallel to `hours`. When present, `probability` is computed and
 *   becomes the headline: best hour, level, and reason key off it, while
 *   `score` remains the deterministic conditions-quality number.
 * @returns {{probability, score, level, bestHour, bestEpoch, bestWindow, reason, hourly}}
 */
export function scoreLocation(hours, members = null) {
  const hasEnsemble = Array.isArray(members) && members.length > 0;
  const scored = hours.map((h, i) => ({
    ...h,
    ...scoreHour(h, hours[i - 1], hours[i + 1]),
    probability: hourProbability(members, i, hours),
  }));

  // Headline hour: member agreement when we have an ensemble (quality as
  // tiebreak), otherwise the deterministic score.
  const rank = (h) => (hasEnsemble ? (h.probability ?? 0) * 1000 + h.score : h.score);
  const best = scored.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const headline = hasEnsemble ? (best.probability ?? 0) : best.score;

  let reason;
  if (headline === 0) {
    reason = hasEnsemble
      ? `${zeroReason(hours)} (0 of ${members.length} forecast members produce sunlit rain.)`
      : zeroReason(hours);
  } else {
    const phrases = RAIN_PHRASE[best.rainType] ?? RAIN_PHRASE.possible;
    const rainPhrase = phrases[best.rainSource] ?? 'a chance of a passing shower';
    reason = hasEnsemble
      ? `Best around ${best.label}: ${best.probability}% of ${members.length} forecast members see sunlit rain (${sunPhrase(best.sunlitPct, best)} with ${rainPhrase}).`
      : `Best around ${best.label}: ${sunPhrase(best.sunlitPct, best)} with ${rainPhrase} (score ${best.score}/100).`;
  }

  return {
    probability: hasEnsemble ? headline : null,
    score: best.score,
    level: hasEnsemble ? probLevelFor(headline) : levelFor(best.score),
    bestHour: headline > 0 ? best.label : null,
    bestEpoch: headline > 0 ? best.epoch : null,
    bestWindow: headline > 0 ? bestQuarterLabel(best) : null,
    reason,
    hourly: scored.map((h) => ({
      epoch: h.epoch,
      label: h.label,
      probability: h.probability,
      score: h.score,
      precipMm: h.precipMm,
      precipProb: h.precipProb,
      cloudCover: h.cloudTotal,
      sunlitPct: h.sunlitPct,
      rainType: h.rainType,
      sunElevation: Math.round(h.sunElevation * 10) / 10,
    })),
  };
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
      (q.precipMm ?? 0) > 0.02 ||
      (qs[i - 1]?.precipMm ?? 0) > 0.02 ||
      (qs[i + 1]?.precipMm ?? 0) > 0.02;
    const val = sun * (rainNearby ? 1 : 0.3);
    if (val > bestVal) {
      bestVal = val;
      best = q;
    }
  });
  return bestVal > 0 && best ? best.label : null;
}
