import crypto from 'crypto';
import { intervalAt } from '../core/forecast-time.js';

const TOKEN_SCHEMA_VERSION = 1;
const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;
const OFFLINE_REPORT_GRACE_SECONDS = 48 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{32,128}$/;

function explicitSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  if (/replace-with|example|changeme/i.test(secret)) return null;
  return secret;
}

export function resolveSigningSecret(secret, env = process.env) {
  const configured = explicitSecret(secret ?? env.SIGHTING_SIGNING_SECRET);
  if (configured) return configured;
  const serviceAccount = env.FIREBASE_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT;
  if (typeof serviceAccount !== 'string' || serviceAccount.length < 128) return null;
  return crypto.createHash('sha256')
    .update('bowcast-sighting-signing-v1\0')
    .update(serviceAccount)
    .digest('hex');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signature(encoded, secret) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

function finite(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function roundCoordinate(value) {
  return Number((Math.round(value * 100) / 100).toFixed(2));
}

export function predictionContextEnabled(secret) {
  return Boolean(resolveSigningSecret(secret));
}

export function signPredictionContext(payload, secret) {
  const key = resolveSigningSecret(secret);
  if (!key) return null;
  const encoded = encode(payload);
  return `${encoded}.${signature(encoded, key)}`;
}

export function verifyPredictionContext(token, secret, {
  now = Date.now(),
  expiredGraceSeconds = 0,
} = {}) {
  const key = resolveSigningSecret(secret);
  if (!key || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const [encoded, supplied] = token.split('.');
  const expected = signature(encoded, key);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  const nowSec = Math.floor(now / 1000);
  if (payload?.v !== TOKEN_SCHEMA_VERSION || !finite(payload.iat, 0, nowSec + 300)) return null;
  if (!finite(payload.exp, nowSec - expiredGraceSeconds, nowSec + TOKEN_LIFETIME_SECONDS + 300)) return null;
  if (!finite(payload.lat, -90, 90) || !finite(payload.lon, -180, 180) || !finite(payload.validForEpoch, 0, 10_000_000_000)) return null;
  if (payload.validFromEpoch != null || payload.validToEpoch != null) {
    if (!finite(payload.validFromEpoch, 0, 10_000_000_000) || !finite(payload.validToEpoch, 0, 10_000_000_000)) return null;
    if (payload.validFromEpoch >= payload.validToEpoch) return null;
    if (payload.validForEpoch < payload.validFromEpoch || payload.validForEpoch >= payload.validToEpoch) return null;
  }
  if (!finite(payload.rawProbabilityPct, 0, 100) || !finite(payload.probabilityPct, 0, 100) || !finite(payload.conditionsScore, 0, 100)) return null;
  if (typeof payload.scoringVersion !== 'string' || typeof payload.calibrationVersion !== 'string') return null;
  return payload;
}

function contextForHour(result, location, hour, nowSec) {
  if (!Number.isFinite(hour.rawProbability) || !Number.isFinite(hour.probability)) return null;
  const validFromEpoch = hour.validFromEpoch ?? hour.epoch;
  const validToEpoch = hour.validToEpoch;
  return {
    v: TOKEN_SCHEMA_VERSION,
    iat: nowSec,
    exp: nowSec + TOKEN_LIFETIME_SECONDS,
    nonce: crypto.randomBytes(12).toString('base64url'),
    lat: roundCoordinate(location.lat),
    lon: roundCoordinate(location.lon),
    generatedAt: result.generatedAt,
    validForEpoch: hour.validForEpoch ?? hour.epoch,
    ...(Number.isFinite(validFromEpoch) && Number.isFinite(validToEpoch)
      ? { validFromEpoch, validToEpoch }
      : {}),
    rawProbabilityPct: hour.rawProbability,
    probabilityPct: hour.probability,
    conditionsScore: hour.score,
    scoringVersion: location.scoringVersion,
    calibrationVersion: location.calibrationVersion,
    ensembleModel: result.ensembleModel || 'icon_seamless',
    evidence: 'ensemble',
    conditions: {
      precipMm: hour.precipMm ?? null,
      precipProbabilityPct: hour.precipProb ?? null,
      cloudCoverPct: hour.cloudCover ?? null,
      sunlitPct: hour.sunlitPct ?? null,
      sunElevationDeg: hour.sunElevation ?? null,
      rainType: hour.rainType ?? null,
    },
  };
}

export function attachPredictionContexts(result, secret, { now = Date.now() } = {}) {
  const key = resolveSigningSecret(secret);
  if (!key || !result?.locations) return result;
  const nowSec = Math.floor(now / 1000);
  return {
    ...result,
    locations: result.locations.map((location) => ({
      ...location,
      hourly: (location.hourly || []).map((hour) => {
        const payload = contextForHour(result, location, hour, nowSec);
        return payload ? { ...hour, reportToken: signPredictionContext(payload, key) } : hour;
      }),
    })),
  };
}

export function trustSightingRecord(record, token, secret, options = {}) {
  const payload = verifyPredictionContext(token, secret, {
    ...options,
    expiredGraceSeconds: options.expiredGraceSeconds ?? OFFLINE_REPORT_GRACE_SECONDS,
  });
  if (!payload) {
    return {
      ...record,
      forecast: { ...record.forecast, trust: 'client' },
    };
  }

  const observedEpoch = Date.parse(record.observedAt) / 1000;
  const coordinatesMatch = roundCoordinate(record.location.lat) === payload.lat
    && roundCoordinate(record.location.lon) === payload.lon;
  const timeMatches = payload.validFromEpoch != null && payload.validToEpoch != null
    ? observedEpoch >= payload.validFromEpoch && observedEpoch < payload.validToEpoch
    : Math.abs(observedEpoch - payload.validForEpoch) <= 90 * 60;
  const observationWithinContext = observedEpoch >= payload.iat - 5 * 60 && observedEpoch <= payload.exp;
  if (!coordinatesMatch || !timeMatches || !observationWithinContext) {
    return {
      ...record,
      forecast: { ...record.forecast, trust: 'client' },
    };
  }

  return {
    ...record,
    forecast: {
      generatedAt: payload.generatedAt,
      validForEpoch: payload.validForEpoch,
      validFromEpoch: payload.validFromEpoch ?? null,
      validToEpoch: payload.validToEpoch ?? null,
      probabilityPct: payload.probabilityPct,
      rawProbabilityPct: payload.rawProbabilityPct,
      conditionsScore: payload.conditionsScore,
      ensembleModel: payload.ensembleModel,
      evidence: payload.evidence,
      scoringVersion: payload.scoringVersion,
      calibrationVersion: payload.calibrationVersion,
      trust: 'forecast_verified',
      predictionId: crypto.createHash('sha256').update(JSON.stringify({
        lat: payload.lat,
        lon: payload.lon,
        validForEpoch: payload.validForEpoch,
        validFromEpoch: payload.validFromEpoch ?? null,
        validToEpoch: payload.validToEpoch ?? null,
        rawProbabilityPct: payload.rawProbabilityPct,
        conditionsScore: payload.conditionsScore,
        scoringVersion: payload.scoringVersion,
        calibrationVersion: payload.calibrationVersion,
        ensembleModel: payload.ensembleModel,
      })).digest('hex'),
      conditions: payload.conditions,
    },
  };
}

export async function verifyOrRefreshSightingRecord(
  record,
  token,
  computeLikelihood,
  secret,
  options = {},
) {
  const verified = trustSightingRecord(record, token, secret, options);
  if (verified.forecast.trust === 'forecast_verified' || !predictionContextEnabled(secret)) return verified;

  try {
    const result = await computeLikelihood(
      [{ lat: record.location.lat, lon: record.location.lon }],
      { ensembleModel: options.ensembleModel || process.env.ENSEMBLE_MODEL },
    );
    const signed = attachPredictionContexts(result, secret, options);
    const location = signed?.locations?.[0];
    const observedEpoch = Date.parse(record.observedAt) / 1000;
    const hours = location?.hourly || [];
    const hour = intervalAt(hours, observedEpoch) || hours.reduce((nearest, candidate) => (
      !nearest || Math.abs((candidate.validForEpoch ?? candidate.epoch) - observedEpoch) < Math.abs((nearest.validForEpoch ?? nearest.epoch) - observedEpoch)
        ? candidate
        : nearest
    ), null);
    if (!hour?.reportToken) return verified;
    return trustSightingRecord(record, hour.reportToken, secret, options);
  } catch (_) {
    // Forecast verification must never discard an otherwise valid opted-in report.
    return verified;
  }
}
