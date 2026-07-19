/**
 * Forecast validity intervals shared by provider parsing, scoring, Now, and
 * observation reporting. Open-Meteo's accumulated values are timestamped at
 * the end of the period they describe, so Bowcast normalizes them to explicit
 * half-open intervals: validFromEpoch <= instant < validToEpoch.
 *
 * Browser-safe and dependency-free.
 */

export const FORECAST_INTERVAL_SCHEMA_VERSION = 1;
export const HOUR_SECONDS = 60 * 60;
export const QUARTER_HOUR_SECONDS = 15 * 60;

/** Normalize a provider interval-end timestamp into Bowcast interval fields. */
export function precedingInterval(providerEpoch, durationSeconds) {
  if (!Number.isFinite(providerEpoch)) throw new TypeError('providerEpoch must be finite');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError('durationSeconds must be positive');
  }
  const validFromEpoch = providerEpoch - durationSeconds;
  const validToEpoch = providerEpoch;
  return {
    // `epoch` remains the start-of-period key expected by geometry, scoring,
    // alerts, charts, and historical API consumers.
    epoch: validFromEpoch,
    providerEpoch,
    validFromEpoch,
    validToEpoch,
    validForEpoch: validFromEpoch + durationSeconds / 2,
  };
}

/** True when an instant belongs to an interval using the shared half-open rule. */
export function intervalContains(interval, epoch) {
  const start = interval?.validFromEpoch ?? interval?.epoch;
  const end = interval?.validToEpoch;
  return Number.isFinite(epoch)
    && Number.isFinite(start)
    && Number.isFinite(end)
    && epoch >= start
    && epoch < end;
}

/** Select the interval containing an instant. Never substitutes a future row. */
export function intervalAt(intervals, epoch) {
  return intervals?.find((interval) => intervalContains(interval, epoch)) ?? null;
}

/** Join endpoint labels while dropping a repeated AM/PM suffix. */
export function formatInterval(formatter, validFromEpoch, validToEpoch) {
  if (!formatter || !Number.isFinite(validFromEpoch) || !Number.isFinite(validToEpoch)) return null;
  const startLabel = formatter.format(new Date(validFromEpoch * 1000));
  const endLabel = formatter.format(new Date(validToEpoch * 1000));
  // A repeated clock hour at the autumn DST transition needs its zone
  // abbreviation or the interval would render as the meaningless "1-1 AM".
  if (startLabel === endLabel) {
    const options = formatter.resolvedOptions();
    const detailed = new Intl.DateTimeFormat(options.locale || 'en-US', {
      hour: 'numeric',
      ...(options.minute ? { minute: '2-digit' } : {}),
      hour12: true,
      timeZone: options.timeZone,
      timeZoneName: 'short',
    });
    return `${detailed.format(new Date(validFromEpoch * 1000))}-${detailed.format(new Date(validToEpoch * 1000))}`;
  }
  const suffix = / (AM|PM)$/;
  const startSuffix = startLabel.match(suffix);
  const endSuffix = endLabel.match(suffix);
  if (startSuffix && endSuffix && startSuffix[1] === endSuffix[1]) {
    return `${startLabel.replace(suffix, '')}-${endLabel}`;
  }
  return `${startLabel}-${endLabel}`;
}
