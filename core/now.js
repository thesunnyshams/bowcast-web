/**
 * "Rainbows right now" ranker.
 *
 * Scores a batch of cities at the current wall-clock hour so the /now page can
 * surface where sunlit rain is most likely on Earth this moment. It reuses the
 * exact map engine (weather + ensemble + scoring); the only differences from
 * likelihood.js are that cities span the globe (so each is formatted in its own
 * timezone) and that we read the hour at the current epoch rather than the
 * day's best. Browser-safe: no Node-only APIs.
 */
import { fetchForecasts } from './weather.js';
import { fetchEnsembles } from './ensemble.js';
import { sunPositionDeg } from './solar.js';
import { scoreLocation } from './scoring.js';

const clockFmtCache = new Map();
function clockFmt(tz) {
  if (!clockFmtCache.has(tz)) {
    clockFmtCache.set(tz, new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }));
  }
  return clockFmtCache.get(tz);
}
const hourFmtCache = new Map();
function hourFmt(tz) {
  if (!hourFmtCache.has(tz)) {
    hourFmtCache.set(tz, new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone: tz }));
  }
  return hourFmtCache.get(tz);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchBatch(locations, ensembleModel, days) {
  const [forecasts, ensembles] = await Promise.all([
    fetchForecasts(locations, { timezone: 'auto', days }),
    fetchEnsembles(locations, ensembleModel, 'auto', days).catch(() => null),
  ]);
  return forecasts.map((forecast, i) => ({ forecast, ens: ensembles?.[i] ?? null }));
}

/**
 * @param {Array} cities  { slug, name, region, country, lat, lon }
 * @returns {{ generatedAt, hasEnsemble, cities: Array }} cities sorted by the
 *   current-hour headline (probability when available, else quality score).
 */
export async function rankNow(cities, { ensembleModel, days = 1, batchSize = 22 } = {}) {
  const nowHourEpoch = Math.floor(Date.now() / 3600000) * 3600;
  const scored = [];
  let hasEnsemble = false;

  // Chunk so one huge multi-location request cannot fail the whole page, and
  // to stay well under provider per-request location limits.
  for (const batch of chunk(cities, batchSize)) {
    let fetched;
    try {
      fetched = await fetchBatch(batch, ensembleModel, days);
    } catch (err) {
      console.warn('now: batch failed, skipping', err.message);
      continue;
    }
    fetched.forEach(({ forecast, ens }, i) => {
      const row = scoreCityNow(batch[i], forecast, ens, nowHourEpoch);
      if (row) {
        if (row.nowIsProb) hasEnsemble = true;
        scored.push(row);
      }
    });
  }

  scored.sort((a, b) => b.rank - a.rank || (b.peakProb ?? 0) - (a.peakProb ?? 0) || a.name.localeCompare(b.name));
  return { generatedAt: new Date().toISOString(), hasEnsemble, cities: scored };
}

function scoreCityNow(city, forecast, ens, nowHourEpoch) {
  if (!forecast?.hours?.length) return null;
  const tz = forecast.timezone || 'UTC';
  const fmtH = hourFmt(tz);

  const hours = forecast.hours.map((h) => {
    const date = new Date(h.epoch * 1000);
    const pos = sunPositionDeg(date, forecast.lat, forecast.lon);
    return { ...h, label: fmtH.format(date), sunElevation: pos.elevation, sunAzimuth: pos.azimuth, quarters: [] };
  });

  // Align ensemble member series to the forecast hour epochs (same as likelihood.js).
  let members = null;
  if (ens?.epochs?.length) {
    const idxByEpoch = new Map(ens.epochs.map((e, j) => [e, j]));
    if (hours.some((h) => idxByEpoch.has(h.epoch))) {
      members = ens.members.map((m) => ({
        precipMm: hours.map((h) => m.precipMm[idxByEpoch.get(h.epoch)] ?? null),
        snowMm: hours.map((h) => m.snowMm[idxByEpoch.get(h.epoch)] ?? null),
        cloudTotal: hours.map((h) => m.cloudTotal[idxByEpoch.get(h.epoch)] ?? null),
        dni: hours.map((h) => m.dni[idxByEpoch.get(h.epoch)] ?? null),
      }));
    }
  }

  const result = scoreLocation(hours, members);

  // Current hour (exact, else the next available hour in the window).
  const nowHour =
    result.hourly.find((h) => h.epoch === nowHourEpoch) ||
    result.hourly.find((h) => h.epoch > nowHourEpoch) ||
    null;
  const nowProb = nowHour?.probability ?? null;
  const nowScore = nowHour?.score ?? 0;
  const nowIsProb = nowProb != null;
  const headline = nowIsProb ? nowProb : nowScore;

  // Best hour still to come today, for a "next chance" nudge.
  let soon = null;
  for (const h of result.hourly) {
    if (h.epoch <= (nowHour?.epoch ?? nowHourEpoch)) continue;
    const v = h.probability ?? h.score ?? 0;
    if (v > (soon?.value ?? 0)) soon = { value: v, prob: h.probability, score: h.score, label: h.label };
  }

  return {
    slug: city.slug,
    name: city.name,
    region: city.region,
    country: city.country,
    lat: city.lat,
    lon: city.lon,
    tz,
    localTime: clockFmt(tz).format(new Date()),
    isDay: (nowHour?.sunElevation ?? -1) > 0,
    nowProb,
    nowScore,
    nowIsProb,
    headline,
    peakProb: result.probability,
    peakScore: result.score,
    peakHour: result.bestHour,
    soon,
    sunlitNow: nowHour?.sunlitPct ?? null, // forecast sun fraction, the sun fallback where satellite is dark
    rank: (nowProb ?? 0) * 1000 + nowScore,
  };
}
