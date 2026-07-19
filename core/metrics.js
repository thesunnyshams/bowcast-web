export const METRIC_SCHEMA_VERSION = 1;

export const METRIC_EVENTS = Object.freeze([
  'forecast_loaded',
  'window_opened',
  'alert_enabled',
  'share_started',
  'sighting_reported',
]);

export const METRIC_SOURCES = Object.freeze(['web', 'pwa', 'ios', 'android', 'unknown']);

const EVENT_SET = new Set(METRIC_EVENTS);
const SOURCE_SET = new Set(METRIC_SOURCES);
const ALLOWED_FIELDS = new Set(['schemaVersion', 'event', 'source']);

export function metricMeasurementAllowed({ globalPrivacyControl = false, doNotTrack = null } = {}) {
  return globalPrivacyControl !== true && String(doNotTrack || '') !== '1';
}

export class MetricValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'MetricValidationError';
    this.field = field;
  }
}

/**
 * Accept only the three fields needed for an aggregate counter. Rejecting
 * extra fields is a privacy boundary: coordinates, URLs, identifiers, and
 * free-form metadata cannot accidentally enter the metrics store.
 */
export function normalizeMetricEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MetricValidationError('metric must be an object', 'body');
  }
  const extra = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra) throw new MetricValidationError('metric contains an unsupported field', extra);
  if (input.schemaVersion !== METRIC_SCHEMA_VERSION) {
    throw new MetricValidationError('unsupported metric schema version', 'schemaVersion');
  }
  if (!EVENT_SET.has(input.event)) {
    throw new MetricValidationError('unsupported metric event', 'event');
  }
  if (!SOURCE_SET.has(input.source)) {
    throw new MetricValidationError('unsupported metric source', 'source');
  }
  return { event: input.event, source: input.source };
}
