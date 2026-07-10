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

export async function computeLikelihood(locations, { ensembleModel, timezone = 'auto' } = {}) {
  // Ensemble failure must not break the result: probabilities just turn off
  // and the app falls back to deterministic quality scores.
  const [forecasts, ensembles] = await Promise.all([
    fetchForecasts(locations, { timezone }),
    fetchEnsembles(locations, ensembleModel, timezone).catch((err) => {
      console.warn('ensemble fetch failed, probabilities disabled:', err.message);
      return null;
    }),
  ]);

  const resolvedTz = forecasts[0]?.timezone || 'UTC';
  const fmt = formattersFor(resolvedTz);

  const locationsResult = forecasts.map((forecast, idx) => {
    const minutelyByEpoch = new Map(forecast.minutely.map((m) => [m.epoch, m]));

    const hours = forecast.hours.map((h) => {
      const date = new Date(h.epoch * 1000);
      const label = fmt.hour.format(date);
      const pos = sunPositionDeg(date, forecast.lat, forecast.lon);

      const quarters = [];
      for (const offset of [0, 900, 1800, 2700]) {
        const m = minutelyByEpoch.get(h.epoch + offset);
        if (m) {
          quarters.push({
            epoch: m.epoch,
            label: fmt.quarter.format(new Date(m.epoch * 1000)),
            precipMm: m.precipMm,
            sunshineSec: m.sunshineSec,
          });
        }
      }

      return {
        ...h,
        label,
        sunElevation: pos.elevation,
        sunAzimuth: pos.azimuth,
        quarters,
      };
    });

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
    const ens = ensembles?.[idx] ?? null;
    let alignedMembers = null;
    if (ens?.epochs?.length) {
      const idxByEpoch = new Map(ens.epochs.map((e, j) => [e, j]));
      if (hours.some((h) => idxByEpoch.has(h.epoch))) {
        alignedMembers = ens.members.map((m) => ({
          precipMm: hours.map((h) => m.precipMm[idxByEpoch.get(h.epoch)] ?? null),
          snowMm: hours.map((h) => m.snowMm[idxByEpoch.get(h.epoch)] ?? null),
          cloudTotal: hours.map((h) => m.cloudTotal[idxByEpoch.get(h.epoch)] ?? null),
        }));
      }
    }

    const days = dayRanges.map(({ date, start, end }) => {
      const dayHours = hours.slice(start, end);
      const dayMembers = alignedMembers
        ? alignedMembers.map((m) => ({
            precipMm: m.precipMm.slice(start, end),
            snowMm: m.snowMm.slice(start, end),
            cloudTotal: m.cloudTotal.slice(start, end),
          }))
        : null;
      return {
        date,
        weekday: fmt.weekday.format(new Date(dayHours[0].epoch * 1000)),
        ...scoreLocation(dayHours, dayMembers),
      };
    });

    const today = days[0];

    // Bow geometry for a day's best hour: when inside that hour the arc is
    // geometrically possible, where to face, how high the sun sits. Pure
    // solar math, so it costs nothing and works for every location.
    const bowFor = (d) => {
      if (d.bestEpoch == null) return null;
      const g = bowGeometry(d.bestEpoch, forecast.lat, forecast.lon);
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

    return {
      name: forecast.name,
      lat: forecast.lat,
      lon: forecast.lon,
      probability: today.probability,
      score: today.score,
      level: today.level,
      bestHour: today.bestHour,
      bestEpoch: today.bestEpoch,
      bestWindow: today.bestWindow,
      bow: bowFor(today),
      reason: today.reason,
      hourly: today.hourly, // full hourly detail is today-only to keep the payload lean
      days: days.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        probability: d.probability,
        score: d.score,
        level: d.level,
        bestHour: d.bestHour,
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
      const rank = (d.probability ?? 0) * 1000 + d.score;
      if (rank > outlookRank) {
        outlookRank = rank;
        outlook = {
          date: d.date,
          weekday: d.weekday,
          dayIndex,
          town: loc.name,
          probability: d.probability,
          score: d.score,
          bestHour: d.bestHour,
        };
      }
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    timezone: resolvedTz,
    outlook,
    locations: locationsResult,
  };
}
