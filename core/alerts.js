/**
 * Notification copy, shared by server push (src/push.js) and the in-app
 * web notifications (app.js). Lead with the number, then tell the reader
 * what to do with their feet and eyes. Browser-safe, dependency-free.
 */

/** Ring-point names ("12 km NW") read as an offset; real places as "near X". */
function wherePhrase(name) {
  if (!name || name === 'Your spot') return '';
  if (/^\d+ km [A-Z]{1,2}$/.test(name)) return `, ${name} of you`;
  return ` near ${name}`;
}

/**
 * An alert is actionable only while its peak interval has not ended: active
 * (now inside the interval) or still upcoming. A location without interval
 * timing is never alertable; an alert that cannot say when is a guess.
 */
export function alertEligible(best, nowMs = Date.now()) {
  // A nextPeak, when present, is the actionable target: it is future by
  // construction, so eligibility keys off its interval end.
  const np = best.nextPeak ?? null;
  if (np) {
    const npEnd = np.intervalEndEpoch
      ?? (np.intervalStartEpoch != null ? np.intervalStartEpoch + 3600 : null);
    if (npEnd != null) return nowMs < npEnd * 1000;
  }
  const startEpoch = best.bestIntervalStartEpoch ?? best.bestEpoch ?? null;
  if (startEpoch == null) return false;
  const endEpoch = best.bestIntervalEndEpoch ?? startEpoch + 3600;
  return nowMs < endEpoch * 1000;
}

/**
 * Build { title, body } for one alert-worthy location entry from
 * computeLikelihood (probability, name, bestInterval, interval bounds, bow).
 *
 * "Rainbow: 72% estimated chance in the next hour"
 * "Face West-Northwest, sun 11° above the horizon, best 6:40-7:15 PM."
 */
export function composeAlert(best, nowMs = Date.now()) {
  // Prefer the forward-looking nextPeak (value, interval label, and interval
  // bounds) so the copy points at what is still to come. Legacy shapes with
  // no nextPeak fall back to the retrospective best fields, unchanged.
  const np = best.nextPeak ?? null;
  const p = (np?.probability ?? best.probability) ?? 0;
  const startEpoch = np?.intervalStartEpoch ?? best.bestIntervalStartEpoch ?? best.bestEpoch ?? null;
  const endEpoch = np?.intervalEndEpoch
    ?? best.bestIntervalEndEpoch
    ?? (startEpoch != null ? startEpoch + 3600 : null);
  const startsInMs = startEpoch != null ? startEpoch * 1000 - nowMs : null;
  const active = startEpoch != null && endEpoch != null
    && startEpoch * 1000 <= nowMs
    && nowMs < endEpoch * 1000;
  const startsSoon = startsInMs != null && startsInMs >= 0 && startsInMs < 90 * 60000;
  const soon = active || startsSoon;
  const intervalLabel = np?.interval ?? best.bestInterval ?? best.bestHour;
  const when = soon ? 'in the next hour' : intervalLabel ? `during ${intervalLabel}` : 'today';
  const title = `Rainbow: ${p}% estimated chance ${when}${wherePhrase(best.name)}`;

  const bow = np?.bow ?? best.bow;
  const bits = [];
  if (bow?.look) bits.push(`Face ${bow.look}`);
  if (bow?.sunElevation != null) bits.push(`sun ${bow.sunElevation}° above the horizon`);
  if (bow?.window) bits.push(`best ${bow.window}`);
  const body = bits.length
    ? `${bits.join(', ')}.`
    : 'Sunlit rain is possible nearby. Put the sun at your back.';
  return { title, body };
}
