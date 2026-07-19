/**
 * "Rainbows right now" ranker.
 *
 * Scores a batch of cities at the current wall-clock hour so the /now page can
 * surface where sunlit rain is most likely in the interval containing this
 * moment. It reuses the
 * exact map engine (weather + ensemble + scoring); the only differences from
 * likelihood.js are that cities span the globe (so each is formatted in its own
 * timezone) and that we read the hour at the current epoch rather than the
 * day's best. Browser-safe: no Node-only APIs.
 */
import { fetchForecasts } from './weather.js';
import { fetchEnsembles } from './ensemble.js';
import { sunPositionDeg } from './solar.js';
import { scoreLocation } from './scoring.js';
import { alignEnsembleMembers, prepareForecastHours, sliceEnsembleMembers } from './likelihood.js';
import { FORECAST_INTERVAL_SCHEMA_VERSION, intervalAt } from './forecast-time.js';

const clockFmtCache = new Map();
function clockFmt(tz) {
  if (!clockFmtCache.has(tz)) {
    clockFmtCache.set(tz, new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }));
  }
  return clockFmtCache.get(tz);
}
const dateFmtCache = new Map();
function dateFmt(tz) {
  if (!dateFmtCache.has(tz)) {
    dateFmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }));
  }
  return dateFmtCache.get(tz);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchBatch(locations, ensembleModel, days, { fetchForecastsFn, fetchEnsemblesFn }) {
  const providerDays = Math.min(days + 1, 16);
  const [forecasts, ensembles] = await Promise.all([
    fetchForecastsFn(locations, { timezone: 'auto', days: providerDays }),
    fetchEnsemblesFn(locations, ensembleModel, 'auto', providerDays).catch(() => null),
  ]);
  return locations.map((city, i) => ({ city, forecast: forecasts?.[i] ?? null, ens: ensembles?.[i] ?? null }));
}

async function fetchResilient(batch, options, depth = 0) {
  try {
    const fetched = await fetchBatch(batch, options.ensembleModel, options.days, options);
    const usable = fetched.filter((row) => row.forecast?.hours?.length);
    const missing = fetched.filter((row) => !row.forecast?.hours?.length).map((row) => row.city.slug);
    return { fetched: usable, failed: missing, recovered: depth > 0 };
  } catch (error) {
    if (batch.length === 1 || depth >= options.maxRecoveryDepth) {
      console.warn(`now: forecast batch unavailable (${batch.length} cities): ${error.message}`);
      return { fetched: [], failed: batch.map((city) => city.slug), recovered: false };
    }
    const middle = Math.ceil(batch.length / 2);
    const halves = await Promise.all([
      fetchResilient(batch.slice(0, middle), options, depth + 1),
      fetchResilient(batch.slice(middle), options, depth + 1),
    ]);
    return {
      fetched: halves.flatMap((result) => result.fetched),
      failed: halves.flatMap((result) => result.failed),
      recovered: true,
    };
  }
}

/**
 * @param {Array} cities  { slug, name, region, country, lat, lon }
 * @returns {{ generatedAt, hasEnsemble, cities: Array }} cities sorted by the
 *   current-interval headline (probability when available, else quality score).
 */
export async function rankNow(cities, {
  ensembleModel,
  days = 1,
  batchSize = 22,
  maxRecoveryDepth = 1,
  now = Date.now(),
  fetchForecastsFn = fetchForecasts,
  fetchEnsemblesFn = fetchEnsembles,
} = {}) {
  const nowEpoch = Math.floor(now / 1000);
  const scored = [];
  let hasEnsemble = false;

  // Keep requests below provider location limits, but run the small bounded
  // set of batches concurrently. A failed region cannot blank the others.
  const batches = chunk(cities, batchSize);
  const options = { ensembleModel, days, maxRecoveryDepth, fetchForecastsFn, fetchEnsemblesFn };
  const results = await Promise.all(batches.map((batch) => fetchResilient(batch, options)));

  for (const { fetched } of results) {
    fetched.forEach(({ city, forecast, ens }) => {
      const row = scoreCityNow(city, forecast, ens, nowEpoch, now);
      if (row) {
        if (row.nowIsProb) hasEnsemble = true;
        scored.push(row);
      }
    });
  }

  scored.sort((a, b) => b.rank - a.rank || (b.peakProb ?? 0) - (a.peakProb ?? 0) || a.name.localeCompare(b.name));
  const failedCities = [...new Set(results.flatMap((result) => result.failed))];
  return {
    generatedAt: new Date(now).toISOString(),
    intervalSchemaVersion: FORECAST_INTERVAL_SCHEMA_VERSION,
    hasEnsemble,
    coverage: {
      requested: cities.length,
      returned: scored.length,
      failed: failedCities.length,
      complete: failedCities.length === 0 && scored.length === cities.length,
      recoveredBatches: results.filter((result) => result.recovered).length,
    },
    cities: scored,
  };
}

function scoreCityNow(city, forecast, ens, nowEpoch, nowMs = Date.now()) {
  if (!forecast?.hours?.length) return null;
  const tz = forecast.timezone || 'UTC';
  const today = dateFmt(tz).format(new Date(nowMs));
  const forecastStartEpoch = forecast.forecastStartEpoch ?? null;
  const preparedHours = prepareForecastHours(forecast);
  const hours = preparedHours.filter((h) => (
    (forecastStartEpoch == null || h.epoch >= forecastStartEpoch)
    && dateFmt(tz).format(new Date(h.epoch * 1000)) === today
  ));
  if (!hours.length) return null;

  // Score today with one hidden hour on either side so clearing and approaching
  // transitions survive the local-midnight publication boundary.
  const targetStart = preparedHours.indexOf(hours[0]);
  const targetEnd = preparedHours.indexOf(hours[hours.length - 1]) + 1;
  const contextStart = Math.max(0, targetStart - 1);
  const contextEnd = Math.min(preparedHours.length, targetEnd + 1);
  const contextHours = preparedHours.slice(contextStart, contextEnd);
  const alignedMembers = alignEnsembleMembers(ens, preparedHours);
  const contextMembers = sliceEnsembleMembers(alignedMembers, contextStart, contextEnd);
  const result = scoreLocation(contextHours, contextMembers, {
    targetStartIndex: targetStart - contextStart,
    targetEndIndex: targetEnd - contextStart,
  });

  // A current-hour claim requires the interval that actually contains now.
  // At an exact boundary, the just-ended interval is excluded.
  const nowHour = intervalAt(result.hourly, nowEpoch);
  if (!nowHour) return null;
  const nowWeather = intervalAt(hours, nowEpoch);
  const nowProb = nowHour?.probability ?? null;
  const nowScore = nowHour?.score ?? 0;
  const nowIsProb = nowProb != null;
  const headline = nowIsProb ? nowProb : nowScore;
  const directLiquid = [nowWeather?.rainMm, nowWeather?.showersMm]
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  const hasDirectLiquidField = Number.isFinite(nowWeather?.rainMm)
    || Number.isFinite(nowWeather?.showersMm);
  const fallbackLiquid = Number.isFinite(nowWeather?.precipMm) && Number.isFinite(nowWeather?.snowMm)
    ? Math.max(0, nowWeather.precipMm - nowWeather.snowMm)
    : null;
  const liquidMm = hasDirectLiquidField ? directLiquid : fallbackLiquid;
  const frozenPhase = (nowWeather?.snowMm ?? 0) > 0.1 || (nowWeather?.tempC ?? 10) < 0.5;
  const liquidPhaseNow = Number.isFinite(liquidMm) && liquidMm > 0.05 && !frozenPhase;

  // Best hour still to come today, for a "next chance" nudge.
  let soon = null;
  for (const h of result.hourly) {
    if (h.validFromEpoch < nowHour.validToEpoch) continue;
    const v = h.probability ?? h.score ?? 0;
    if (v > (soon?.value ?? 0)) soon = { value: v, prob: h.probability, score: h.score, label: h.label };
  }

  const currentSun = sunPositionDeg(new Date(nowMs), forecast.lat, forecast.lon);

  return {
    slug: city.slug,
    name: city.name,
    region: city.region,
    country: city.country,
    lat: city.lat,
    lon: city.lon,
    tz,
    localTime: clockFmt(tz).format(new Date(nowMs)),
    isDay: currentSun.elevation > 0,
    nowInterval: nowHour.label,
    nowIntervalStartEpoch: nowHour.validFromEpoch,
    nowIntervalEndEpoch: nowHour.validToEpoch,
    nowProb,
    nowScore,
    nowIsProb,
    ensembleMembers: nowHour.ensembleMembers ?? null,
    headline,
    peakProb: result.probability,
    peakScore: result.score,
    peakHour: result.bestHour,
    peakInterval: result.bestInterval,
    soon,
    sunlitNow: nowHour?.sunlitPct ?? null, // forecast sun fraction, the sun fallback where satellite is dark
    liquidPhaseNow,
    rank: (nowProb ?? 0) * 1000 + nowScore,
  };
}
