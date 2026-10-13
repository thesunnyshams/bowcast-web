import { ACTIVE_PROBABILITY_CALIBRATION } from './trained-calibration.js';

// 3.8: four corrections, all of which change published numbers.
//  - The >96% cloud fraction no longer vetoes an interval that also reports
//    direct sun; the conflict costs half weight instead of everything.
//  - Wind and temperature gates now reach the headline estimated chance
//    through per-member series, not only the deterministic fallback score.
//  - Sub-hour timing is scored: 15-minute sunshine and rain must overlap, so
//    "sun at 5:50, shower at 5:05" no longer reads as a sunlit shower.
//  - The drizzle discount keys on intensity and CAPE rather than on the WMO
//    code alone, and absent CAPE reads as "no signal" instead of "no
//    convection".
// 3.7: the deterministic score enforces the documented physical gates.
// Explicit zero sunshine cannot borrow a cloud-based floor, precipitation
// probability alone cannot stand in for forecast liquid rain, and frozen
// precipitation is rejected regardless of temperature. Any trained
// calibration must be regenerated against this version.
export const SCORING_VERSION = '3.8';
export const IDENTITY_CALIBRATION_VERSION = 'identity-v1';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function validCalibrationArtifact(artifact) {
  if (!artifact || artifact.schemaVersion !== 1 || artifact.kind !== 'ensemble-platt-calibration') return false;
  if (artifact.baseScoringVersion !== SCORING_VERSION || typeof artifact.version !== 'string') return false;
  const parameters = artifact.parameters;
  if (!parameters) return false;
  const values = [parameters.intercept, parameters.slope, parameters.epsilon, parameters.maxAdjustmentPct];
  if (!values.every(Number.isFinite)) return false;
  return parameters.slope >= 0
    && parameters.slope <= 8
    && parameters.epsilon > 0
    && parameters.epsilon < 0.5
    && parameters.maxAdjustmentPct >= 0
    && parameters.maxAdjustmentPct <= 25;
}

export function calibrateEstimatedChance(rawProbabilityPct, artifact = ACTIVE_PROBABILITY_CALIBRATION) {
  if (!Number.isFinite(rawProbabilityPct)) return null;
  const raw = clamp(rawProbabilityPct, 0, 100);
  if (!validCalibrationArtifact(artifact) || artifact.version === IDENTITY_CALIBRATION_VERSION) {
    return Math.round(raw);
  }

  const { intercept, slope, epsilon, maxAdjustmentPct } = artifact.parameters;
  const p = clamp(raw / 100, epsilon, 1 - epsilon);
  const logit = Math.log(p / (1 - p));
  const candidate = 100 * sigmoid(intercept + slope * logit);
  const bounded = clamp(candidate, raw - maxAdjustmentPct, raw + maxAdjustmentPct);
  return Math.round(clamp(bounded, 0, 100));
}

export function activeCalibrationVersion() {
  return validCalibrationArtifact(ACTIVE_PROBABILITY_CALIBRATION)
    ? ACTIVE_PROBABILITY_CALIBRATION.version
    : IDENTITY_CALIBRATION_VERSION;
}
