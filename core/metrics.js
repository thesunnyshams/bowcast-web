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

/**
 * Is this page somewhere whose events should be counted?
 *
 * `METRICS_SERVER_URL` is absolute, so a page served from localhost posts to
 * the production endpoint exactly like the live site does. Production's CORS
 * allowlist rejects it, so nothing has actually been polluted, but an allowlist
 * on the far end is a weaker guarantee than not sending, and the calibration
 * standard in `docs/FLIGHT-WORKSHEET.md` A7 depends on this store holding real
 * readers only.
 *
 * A packaged app is deliberately still measurable: it serves from a local or
 * custom scheme but its user is a real one. `public/analytics.js` applies the
 * same host rule with the opposite answer for Capacitor, because Vercel Web
 * Analytics must not run inside the packaged apps at all.
 */
export function measurableOrigin({ protocol = '', hostname = '', packaged = false } = {}) {
  if (packaged) return true;
  if (protocol !== 'https:') return false;
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '0.0.0.0' || host === '::1') return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host.includes(':') && /^(?:fc|fd|fe[89ab])/.test(host)) return false;
  return true;
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
