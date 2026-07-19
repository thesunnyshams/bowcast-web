import { ACTIVE_PROBABILITY_CALIBRATION } from './trained-calibration.js';

// 3.6: per-member liquid rain, snowfall normalized to water equivalent, and
// effective-member denominators with a minimum coverage floor. Geometry-only
// zeroes cannot activate ensemble mode when every eligible hour is incomplete.
// Estimated-chance selection semantics changed, so any trained calibration
// must be regenerated against this version.
export const SCORING_VERSION = '3.6';
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
