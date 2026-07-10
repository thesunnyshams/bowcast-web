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
 * Build { title, body } for one alert-worthy location entry from
 * computeLikelihood (probability, name, bestHour, bestEpoch, bow).
 *
 * "Rainbow: 72% chance in the next hour"
 * "Face West-Northwest, sun 11° above the horizon, best 6:40-7:15 PM."
 */
export function composeAlert(best, nowMs = Date.now()) {
  const p = best.probability ?? 0;
  const msUntil = best.bestEpoch != null ? best.bestEpoch * 1000 - nowMs : null;
  // "Next hour" covers a best hour that is imminent or already under way.
  const soon = msUntil != null && msUntil > -45 * 60000 && msUntil < 90 * 60000;
  const when = soon ? 'in the next hour' : best.bestHour ? `around ${best.bestHour}` : 'today';
  const title = `Rainbow: ${p}% chance ${when}${wherePhrase(best.name)}`;

  const bits = [];
  if (best.bow?.look) bits.push(`Face ${best.bow.look}`);
  if (best.bow?.sunElevation != null) bits.push(`sun ${best.bow.sunElevation}° above the horizon`);
  if (best.bow?.window) bits.push(`best ${best.bow.window}`);
  const body = bits.length
    ? `${bits.join(', ')}.`
    : 'Sunlit rain is possible nearby. Put the sun at your back.';
  return { title, body };
}
