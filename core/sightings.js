/**
 * Privacy-preserving schema for anonymous rainbow observation reports.
 *
 * This module stays dependency-free so the same validation contract can be
 * used by the browser, Express, serverless functions, and future exporters.
 */

export const SIGHTING_SCHEMA_VERSION = 1;
export const LOCATION_PRECISION_DEGREES = 0.01;

const SOURCES = new Set(['web', 'pwa', 'ios', 'android', 'unknown']);
const OUTCOMES = new Set(['seen', 'not_seen']);
const EVIDENCE = new Set(['ensemble', 'deterministic', 'observed', 'mixed', 'unknown']);
const RAIN_TYPES = new Set(['showers', 'rain', 'drizzle', 'possible']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class SightingValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SightingValidationError';
    this.field = field;
  }
}

function fail(message, field) {
  throw new SightingValidationError(message, field);
}

function finiteNumber(value, field, min, max, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`, field);
  }
  if (value < min || value > max) {
    fail(`${field} must be between ${min} and ${max}`, field);
  }
  return value;
}

function optionalNumber(value, field, min, max, decimals = 2) {
  if (value == null) return null;
  const n = finiteNumber(value, field, min, max);
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function parseDate(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = value < 100_000_000_000 ? value * 1000 : value;
  }
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) fail(`${field} must be a valid timestamp`, field);
  return date;
}

function optionalDate(value, field) {
  return value == null ? null : parseDate(value, field).toISOString();
}

function optionalEnum(value, field, values, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !values.has(value)) {
    fail(`${field} is not supported`, field);
  }
  return value;
}

function roundCoordinate(value) {
  const rounded = Math.round(value / LOCATION_PRECISION_DEGREES) * LOCATION_PRECISION_DEGREES;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(2));
}

/**
 * Validate a client report and return the stable, training-friendly record.
 * Exact coordinates, free-form place labels, request headers, and IP addresses
 * are deliberately absent from the returned object.
 */
export function normalizeSightingReport(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('request body must be a JSON object', 'body');
  }
  if (input.consent !== true) fail('consent must be true', 'consent');

  const id = input.id ?? input.clientSubmissionId;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    fail('id must be a UUID generated for this report', 'id');
  }

  let outcome = input.outcome;
  if (outcome == null && typeof input.sawRainbow === 'boolean') {
    outcome = input.sawRainbow ? 'seen' : 'not_seen';
  }
  if (!OUTCOMES.has(outcome)) fail('outcome must be seen or not_seen', 'outcome');

  const observed = input.observedAt == null ? new Date(now) : parseDate(input.observedAt, 'observedAt');
  if (observed.getTime() < now - 48 * 60 * 60 * 1000) {
    fail('observedAt cannot be more than 48 hours old', 'observedAt');
  }
  if (observed.getTime() > now + 15 * 60 * 1000) {
    fail('observedAt cannot be more than 15 minutes in the future', 'observedAt');
  }

  const lat = finiteNumber(input.lat, 'lat', -90, 90);
  const lon = finiteNumber(input.lon, 'lon', -180, 180);
  const forecast = input.forecast == null ? {} : input.forecast;
  if (typeof forecast !== 'object' || Array.isArray(forecast)) {
    fail('forecast must be an object', 'forecast');
  }
  const conditions = forecast.conditions == null ? {} : forecast.conditions;
  if (typeof conditions !== 'object' || Array.isArray(conditions)) {
    fail('forecast.conditions must be an object', 'forecast.conditions');
  }

  const generatedAt = optionalDate(forecast.generatedAt, 'forecast.generatedAt');
  if (generatedAt) {
    const generatedMs = Date.parse(generatedAt);
    if (generatedMs > observed.getTime() + 24 * 60 * 60 * 1000 || generatedMs < observed.getTime() - 14 * 24 * 60 * 60 * 1000) {
      fail('forecast.generatedAt is outside the accepted observation window', 'forecast.generatedAt');
    }
  }

  let validForEpoch = forecast.validForEpoch ?? forecast.bestEpoch ?? null;
  if (validForEpoch != null) {
    validForEpoch = finiteNumber(validForEpoch, 'forecast.validForEpoch', 0, 10_000_000_000_000);
    validForEpoch = Math.round(validForEpoch > 100_000_000_000 ? validForEpoch / 1000 : validForEpoch);
  }

  let validFromEpoch = forecast.validFromEpoch ?? null;
  let validToEpoch = forecast.validToEpoch ?? null;
  if (validFromEpoch != null || validToEpoch != null) {
    if (validFromEpoch == null || validToEpoch == null) {
      fail('forecast validity bounds must be supplied together', 'forecast.validFromEpoch');
    }
    validFromEpoch = finiteNumber(validFromEpoch, 'forecast.validFromEpoch', 0, 10_000_000_000_000);
    validToEpoch = finiteNumber(validToEpoch, 'forecast.validToEpoch', 0, 10_000_000_000_000);
    validFromEpoch = Math.round(validFromEpoch > 100_000_000_000 ? validFromEpoch / 1000 : validFromEpoch);
    validToEpoch = Math.round(validToEpoch > 100_000_000_000 ? validToEpoch / 1000 : validToEpoch);
    if (validFromEpoch >= validToEpoch) {
      fail('forecast validity interval must have positive duration', 'forecast.validToEpoch');
    }
    if (validForEpoch != null && (validForEpoch < validFromEpoch || validForEpoch >= validToEpoch)) {
      fail('forecast representative time must fall inside its validity interval', 'forecast.validForEpoch');
    }
  }

  let ensembleModel = forecast.ensembleModel ?? null;
  if (ensembleModel != null && (typeof ensembleModel !== 'string' || !MODEL_RE.test(ensembleModel))) {
    fail('forecast.ensembleModel is not valid', 'forecast.ensembleModel');
  }

  return {
    schemaVersion: SIGHTING_SCHEMA_VERSION,
    id: id.toLowerCase(),
    acceptedAt: new Date(now).toISOString(),
    observedAt: observed.toISOString(),
    outcome,
    source: optionalEnum(input.source, 'source', SOURCES, 'unknown'),
    location: {
      lat: roundCoordinate(lat),
      lon: roundCoordinate(lon),
      precisionDegrees: LOCATION_PRECISION_DEGREES,
    },
    forecast: {
      generatedAt,
      validForEpoch,
      validFromEpoch,
      validToEpoch,
      probabilityPct: optionalNumber(forecast.probabilityPct ?? forecast.probability, 'forecast.probabilityPct', 0, 100, 1),
      rawProbabilityPct: optionalNumber(forecast.rawProbabilityPct ?? forecast.rawProbability, 'forecast.rawProbabilityPct', 0, 100, 1),
      conditionsScore: optionalNumber(forecast.conditionsScore ?? forecast.score, 'forecast.conditionsScore', 0, 100, 1),
      ensembleModel,
      scoringVersion: forecast.scoringVersion == null ? null : (
        typeof forecast.scoringVersion === 'string' && VERSION_RE.test(forecast.scoringVersion)
          ? forecast.scoringVersion
          : fail('forecast.scoringVersion is not valid', 'forecast.scoringVersion')
      ),
      calibrationVersion: forecast.calibrationVersion == null ? null : (
        typeof forecast.calibrationVersion === 'string' && VERSION_RE.test(forecast.calibrationVersion)
          ? forecast.calibrationVersion
          : fail('forecast.calibrationVersion is not valid', 'forecast.calibrationVersion')
      ),
      trust: 'client',
      evidence: optionalEnum(forecast.evidence, 'forecast.evidence', EVIDENCE, 'unknown'),
      conditions: {
        precipMm: optionalNumber(conditions.precipMm, 'forecast.conditions.precipMm', 0, 500, 2),
        precipProbabilityPct: optionalNumber(conditions.precipProbabilityPct ?? conditions.precipProb, 'forecast.conditions.precipProbabilityPct', 0, 100, 1),
        cloudCoverPct: optionalNumber(conditions.cloudCoverPct ?? conditions.cloudCover, 'forecast.conditions.cloudCoverPct', 0, 100, 1),
        sunlitPct: optionalNumber(conditions.sunlitPct, 'forecast.conditions.sunlitPct', 0, 100, 1),
        sunElevationDeg: optionalNumber(conditions.sunElevationDeg ?? conditions.sunElevation, 'forecast.conditions.sunElevationDeg', -90, 90, 1),
        rainType: optionalEnum(conditions.rainType, 'forecast.conditions.rainType', RAIN_TYPES),
      },
    },
  };
}
