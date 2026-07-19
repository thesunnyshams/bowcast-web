/**
 * Forecast pipeline: fetch weather + ensemble, score every hour of every
 * local day for every location, and assemble the week outlook.
 *
 * Environment-agnostic: the Node server wraps this with caching and serves
 * it at /api/likelihood; the packaged mobile app calls it directly in the
 * WebView, so phones need no backend at all.
 */
import { fetchForecasts } from './weather.js';
import { fetchEnsembles } from './ensemble.js';
import { sunPositionDeg } from './solar.js';
import { scoreLocation } from './scoring.js';
import { bowGeometry, formatWindow } from './geometry.js';
import {
  FORECAST_INTERVAL_SCHEMA_VERSION,
  formatInterval,
  HOUR_SECONDS,
  QUARTER_HOUR_SECONDS,
} from './forecast-time.js';

const DISPLAY_DAYS = 7;
const PROVIDER_DAYS = DISPLAY_DAYS + 1;

/** Align every ensemble signal to the deterministic forecast hours. */
export function alignEnsembleMembers(ensemble, hours) {
  if (!ensemble?.epochs?.length) return null;
  const idxByEpoch = new Map(ensemble.epochs.map((epoch, i) => [epoch, i]));
  if (!hours.some((hour) => idxByEpoch.has(hour.epoch))) return null;
  return ensemble.members.map((member) => ({
    precipMm: hours.map((hour) => member.precipMm[idxByEpoch.get(hour.epoch)] ?? null),
    rainMm: hours.map((hour) => member.rainMm?.[idxByEpoch.get(hour.epoch)] ?? null),
    snowMm: hours.map((hour) => member.snowMm[idxByEpoch.get(hour.epoch)] ?? null),
    cloudTotal: hours.map((hour) => member.cloudTotal[idxByEpoch.get(hour.epoch)] ?? null),
    dni: hours.map((hour) => member.dni[idxByEpoch.get(hour.epoch)] ?? null),
  }));
}

/** Keep every aligned ensemble signal when scoring one local calendar day. */
export function sliceEnsembleMembers(members, start, end) {
  if (!members) return null;
  return members.map((member) => ({
    precipMm: member.precipMm.slice(start, end),
    rainMm: member.rainMm?.slice(start, end) ?? [],
    snowMm: member.snowMm.slice(start, end),
    cloudTotal: member.cloudTotal.slice(start, end),
    dni: member.dni.slice(start, end),
  }));
}

// Formatters are built per resolved IANA timezone (worldwide support) and
// memoized: all points in one request share a zone, but requests differ.
const formatterCache = new Map();
function formattersFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, {
      hour: new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone }),
      quarter: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }),
      date: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }),
      weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }),
    });
  }
  return formatterCache.get(timeZone);
}

/**
 * Add local interval labels and solar geometry to normalized provider hours.
 * Period aggregates use their explicit bounds; solar position uses the
 * interval midpoint instead of the provider endpoint.
 */
export function prepareForecastHours(forecast) {
  const fmt = formattersFor(forecast.timezone || 'UTC');
  const minutelyByEpoch = new Map((forecast.minutely || []).map((m) => [m.epoch, m]));

  return (forecast.hours || []).map((h) => {
    const validFromEpoch = h.validFromEpoch ?? h.epoch;
    const validToEpoch = h.validToEpoch ?? validFromEpoch + HOUR_SECONDS;
    const validForEpoch = h.validForEpoch ?? (validFromEpoch + validToEpoch) / 2;
    const pos = sunPositionDeg(new Date(validForEpoch * 1000), forecast.lat, forecast.lon);
    const bow = bowGeometry(validFromEpoch, forecast.lat, forecast.lon, validToEpoch);

    const quarters = [];
    for (const offset of [0, 900, 1800, 2700]) {
      const m = minutelyByEpoch.get(validFromEpoch + offset);
      if (m) {
        const quarterStart = m.validFromEpoch ?? m.epoch;
        const quarterEnd = m.validToEpoch ?? quarterStart + QUARTER_HOUR_SECONDS;
        quarters.push({
          ...m,
          epoch: quarterStart,
          validFromEpoch: quarterStart,
          validToEpoch: quarterEnd,
          validForEpoch: m.validForEpoch ?? (quarterStart + quarterEnd) / 2,
          label: formatInterval(fmt.quarter, quarterStart, quarterEnd),
        });
      }
    }

    return {
      ...h,
      epoch: validFromEpoch,
      validFromEpoch,
      validToEpoch,
      validForEpoch,
      label: formatInterval(fmt.hour, validFromEpoch, validToEpoch),
      startLabel: fmt.hour.format(new Date(validFromEpoch * 1000)),
      providerIsDay: h.providerIsDay ?? h.isDay ?? null,
      // `isDay` remains useful for display, while the explicit bow fields let
      // scoring retain a short sunrise, sunset, or 42-degree crossing window
      // that the interval midpoint alone would miss.
      isDay: bow || pos.elevation > 0 ? 1 : 0,
      sunElevation: pos.elevation,
      sunAzimuth: pos.azimuth,
      bowEligibleMinutes: bow?.eligibleMinutes ?? 0,
      bowEligibleFraction: bow ? bow.eligibleMinutes / ((validToEpoch - validFromEpoch) / 60) : 0,
      bowWindowStartEpoch: bow?.startEpoch ?? null,
      bowWindowEndEpoch: bow?.endEpoch ?? null,
      bowSunElevation: bow?.sunElevation ?? null,
      bowSunAzimuth: bow?.sunAzimuth ?? null,
      bowLook: bow?.look ?? null,
      quarters,
    };
  });
}

export async function computeLikelihood(locations, {
  ensembleModel,
  timezone = 'auto',
  now = Date.now(),
  fetchForecastsFn = fetchForecasts,
  fetchEnsemblesFn = fetchEnsembles,
} = {}) {
  const resolvedEnsembleModel = ensembleModel || 'icon_seamless';
  // Ensemble failure must not break the result: probabilities just turn off
  // and the app falls back to deterministic quality scores.
  const [forecasts, ensembles] = await Promise.all([
    // Provider rows are interval endpoints. One padding day supplies the
    // midnight endpoint needed to complete the seventh displayed day.
    fetchForecastsFn(locations, { timezone, days: PROVIDER_DAYS }),
    fetchEnsemblesFn(locations, resolvedEnsembleModel, timezone, PROVIDER_DAYS).catch((err) => {
      console.warn('ensemble fetch failed, probabilities disabled:', err.message);
      return null;
    }),
  ]);

  const resolvedTz = forecasts[0]?.timezone || 'UTC';
  const locationsResult = forecasts.map((forecast, idx) => {
    const fmt = formattersFor(forecast.timezone || resolvedTz);
    const preparedHours = prepareForecastHours(forecast);
    const forecastStartEpoch = forecast.forecastStartEpoch ?? preparedHours[0]?.epoch ?? null;
    // The raw midnight endpoint describes the previous day's last hour.
    // Exclude it, then retain exactly seven local dates below.
    const firstPublishedMatch = forecastStartEpoch == null
      ? 0
      : preparedHours.findIndex((h) => h.epoch >= forecastStartEpoch);
    const firstPublishedIndex = firstPublishedMatch < 0 ? preparedHours.length : firstPublishedMatch;
    const hours = preparedHours.slice(firstPublishedIndex);

    // Group the 7-day hour list into local calendar days and score each
    // day independently (hours are chronological, so days are contiguous).
    const dayRanges = [];
    hours.forEach((h, i) => {
      const date = fmt.date.format(new Date(h.epoch * 1000));
      const current = dayRanges[dayRanges.length - 1];
      if (current && current.date === date) {
        current.end = i + 1;
      } else {
        dayRanges.push({ date, start: i, end: i + 1 });
      }
    });

    // Ensemble member series aligned to the forecast hour epochs.
    // Align against the padded provider series, not only the published hours.
    // The immediately preceding endpoint is valuable context for a clearing
    // shower at local midnight, even though that prior interval is not itself
    // displayed as part of today.
    const alignedMembers = alignEnsembleMembers(ensembles?.[idx], preparedHours);

    // Day 0 is the only day that straddles "now": its peak can be in the past,
    // so it gets a clock and the forward-looking nextPeak/currentInterval.
    // Later days are wholly in the future and keep the whole-day peak only.
    const nowEpochSeconds = Math.floor(now / 1000);
    const days = dayRanges.slice(0, DISPLAY_DAYS).map(({ date, start, end }, dayIndex) => {
      const absoluteStart = firstPublishedIndex + start;
      const absoluteEnd = firstPublishedIndex + end;
      const contextStart = Math.max(0, absoluteStart - 1);
      const contextEnd = Math.min(preparedHours.length, absoluteEnd + 1);
      const dayHours = preparedHours.slice(contextStart, contextEnd);
      const dayMembers = sliceEnsembleMembers(alignedMembers, contextStart, contextEnd);
      return {
        date,
        weekday: fmt.weekday.format(new Date(hours[start].epoch * 1000)),
        intervalStartEpoch: hours[start].validFromEpoch,
        intervalEndEpoch: hours[end - 1].validToEpoch,
        intervalCount: end - start,
        ...scoreLocation(dayHours, dayMembers, {
          ...(dayIndex === 0 ? { nowEpochSeconds } : {}),
          targetStartIndex: absoluteStart - contextStart,
          targetEndIndex: absoluteEnd - contextStart,
        }),
      };
    });

    const today = days[0];

    // Bow geometry for a day's best hour: when inside that hour the arc is
    // geometrically possible, where to face, how high the sun sits. Pure
    // solar math, so it costs nothing and works for every location.
    const bowForInterval = (startEpoch, endEpoch) => {
      if (startEpoch == null) return null;
      const g = bowGeometry(
        startEpoch,
        forecast.lat,
        forecast.lon,
        endEpoch,
      );
      if (!g) return null;
      return {
        window: formatWindow(
          fmt.quarter.format(new Date(g.startEpoch * 1000)),
          fmt.quarter.format(new Date(g.endEpoch * 1000)),
        ),
        look: g.look,
        lookAzimuth: Math.round(g.lookAzimuth),
        sunAzimuth: Math.round(g.sunAzimuth),
        sunElevation: Math.round(g.sunElevation),
      };
    };
    const bowFor = (d) => bowForInterval(
      d.bestIntervalStartEpoch ?? d.bestEpoch,
      d.bestIntervalEndEpoch,
    );
    const nextPeak = today.nextPeak
      ? {
        ...today.nextPeak,
        bow: bowForInterval(today.nextPeak.intervalStartEpoch, today.nextPeak.intervalEndEpoch),
      }
      : null;

    return {
      name: forecast.name,
      lat: forecast.lat,
      lon: forecast.lon,
      probability: today.probability,
      rawProbability: today.rawProbability,
      ensembleMembers: today.ensembleMembers,
      score: today.score,
      scoringVersion: today.scoringVersion,
      calibrationVersion: today.calibrationVersion,
      level: today.level,
      bestHour: today.bestHour,
      bestInterval: today.bestInterval,
      bestEpoch: today.bestEpoch,
      bestIntervalStartEpoch: today.bestIntervalStartEpoch,
      bestIntervalEndEpoch: today.bestIntervalEndEpoch,
      bestWindow: today.bestWindow,
      // Forward-looking outputs for the actionable surfaces: nextPeak is the
      // best interval still ahead (null once the day's rainbow window has
      // wholly passed); currentInterval is the interval containing now.
      // bestHour/bestInterval above stay retrospective (whole-day peak).
      nextPeak,
      currentInterval: today.currentInterval ?? null,
      bow: bowFor(today),
      reason: today.reason,
      hourly: today.hourly, // full hourly detail is today-only to keep the payload lean
      days: days.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        intervalStartEpoch: d.intervalStartEpoch,
        intervalEndEpoch: d.intervalEndEpoch,
        intervalCount: d.intervalCount,
        probability: d.probability,
        rawProbability: d.rawProbability,
        ensembleMembers: d.ensembleMembers,
        score: d.score,
        level: d.level,
        bestHour: d.bestHour,
        bestInterval: d.bestInterval,
        bestEpoch: d.bestEpoch,
        bestIntervalStartEpoch: d.bestIntervalStartEpoch,
        bestIntervalEndEpoch: d.bestIntervalEndEpoch,
        bow: bowFor(d),
        reason: d.reason,
      })),
    };
  });

  // Week outlook: the single best town/day in the region, so the UI has
  // something to point at even when today is a wall of zeros.
  let outlook = null;
  let outlookRank = 0;
  locationsResult.forEach((loc) => {
    loc.days.forEach((d, dayIndex) => {
      // Day 0's peak may already be in the past. Rank it by its nextPeak (the
      // still-actionable interval) so the outlook never points at history; a
      // day whose window has wholly elapsed contributes nothing. Later days
      // are wholly future, so their whole-day best stands.
      const peak = dayIndex === 0
        ? (loc.nextPeak
          ? { probability: loc.nextPeak.probability, score: loc.nextPeak.score,
              bestHour: loc.nextPeak.interval, bestInterval: loc.nextPeak.interval }
          : null)
        : { probability: d.probability, score: d.score,
            bestHour: d.bestHour, bestInterval: d.bestInterval };
      if (!peak) return;
      const rank = (peak.probability ?? 0) * 1000 + peak.score;
      if (rank > outlookRank) {
        outlookRank = rank;
        outlook = {
          date: d.date,
          weekday: d.weekday,
          dayIndex,
          town: loc.name,
          probability: peak.probability,
          score: peak.score,
          bestHour: peak.bestHour,
          bestInterval: peak.bestInterval,
        };
      }
    });
  });

  return {
    generatedAt: new Date(now).toISOString(),
    intervalSchemaVersion: FORECAST_INTERVAL_SCHEMA_VERSION,
    ensembleModel: resolvedEnsembleModel,
    timezone: resolvedTz,
    outlook,
    locations: locationsResult,
  };
}
