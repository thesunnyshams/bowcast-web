/**
 * Select the forecast value for a sighting share card.
 *
 * A submitted report carries the interval that contained the observation.
 * Prefer that snapshot even when its probability is explicitly null, so a
 * whole-day peak can never be presented as the conditions at sighting time.
 */
export function sightingShareValue(location, forecastSnapshot) {
  const source = forecastSnapshot && typeof forecastSnapshot === 'object'
    ? forecastSnapshot
    : location;
  const probability = Number.isFinite(source?.probability) ? source.probability : null;
  const score = Number.isFinite(source?.score) ? source.score : 0;
  return {
    hasEstimate: probability != null,
    value: probability != null ? `${probability}%` : `${score}/100`,
    caption: probability != null ? 'Bowcast estimated chance' : 'Bowcast conditions score',
  };
}

function finiteEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number > 100_000_000_000 ? Math.round(number / 1000) : Math.round(number);
}

function matchingHour(location, forecastSnapshot) {
  const target = finiteEpoch(forecastSnapshot?.validFromEpoch ?? forecastSnapshot?.validForEpoch);
  if (target == null || !Array.isArray(location?.hourly)) return null;
  return location.hourly.find((hour) => {
    const from = finiteEpoch(hour?.validFromEpoch ?? hour?.epoch);
    const to = finiteEpoch(hour?.validToEpoch);
    return from === target || (from != null && to != null && target >= from && target < to);
  }) || null;
}

function issuedLabel(value) {
  const date = new Date(value || NaN);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Build the portable share object used by native share intents and the Web
 * Share API. The link and every important forecast qualifier also live in the
 * text because receiving apps may ignore individual share fields.
 */
export function sightingSharePayload(location, forecastSnapshot, {
  url = 'https://bowcast.app/map/',
} = {}) {
  const value = sightingShareValue(location, forecastSnapshot);
  const hour = matchingHour(location, forecastSnapshot);
  const interval = hour?.label || forecastSnapshot?.interval || null;
  const look = hour?.look || location?.currentInterval?.bow?.look || location?.nextPeak?.bow?.look || null;
  const issued = issuedLabel(forecastSnapshot?.generatedAt);
  const place = location?.name && location.name !== 'Your spot' ? ` near ${location.name}` : '';
  const details = [
    `${value.caption}: ${value.value}`,
    interval ? `Forecast interval: ${interval}` : null,
    look ? `Viewing direction: ${look}` : null,
    issued ? `Forecast issued: ${issued}` : null,
  ].filter(Boolean);
  return {
    title: 'Rainbow spotted with Bowcast',
    text: `Rainbow spotted${place}. ${details.join('. ')}.`,
    url,
    value: value.value,
    caption: value.caption,
    interval,
    look,
    issued,
  };
}
