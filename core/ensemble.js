import { fetchWithTimeout } from './http.js';
import { HOUR_SECONDS, precedingInterval } from './forecast-time.js';

/**
 * Ensemble forecast provider: Open-Meteo Ensemble API.
 *
 * Returns per-member hourly series so scoring can compute P(rainbow) as the
 * fraction of members with sunlit rain (Monte Carlo over forecast
 * uncertainty). All provider-specific parsing stays in this file.
 *
 * Default model: ICON-EPS via `icon_seamless` (40 members). Pass a different
 * model id (e.g. `gfs_seamless`, `gem_global`) as the second argument.
 * Runs in both Node and the browser (no Node-only APIs).
 */
export function normalizeEnsembleResult(location, result) {
  const hourly = result.hourly;

  // Variables come back per member: unsuffixed = control run, then
  // `precipitation_member01` ... `_memberNN`. Discover suffixes generically.
  const suffixes = Object.keys(hourly)
    .filter((k) => /^precipitation(_member\d+)?$/.test(k))
    .map((k) => k.slice('precipitation'.length));

  // Snowfall arrives in centimetres of snow depth; Bowcast works in
  // millimetres of water equivalent throughout (provider guidance: 7 cm of
  // snow is about 10 mm of water, so mm = cm * 10/7).
  const snowWaterEquivalentMm = (arr) =>
    (arr ?? []).map((v) => (v == null ? null : (v * 10) / 7));

  const members = suffixes.map((sfx) => ({
    precipMm: hourly['precipitation' + sfx] ?? [],
    // Per-member liquid rain, when the model provides it. This is the
    // intended liquid signal; total precipitation includes snow.
    rainMm: hourly['rain' + sfx] ?? [],
    snowMm: snowWaterEquivalentMm(hourly['snowfall' + sfx]),
    cloudTotal: hourly['cloud_cover' + sfx] ?? [],
    dni: hourly['direct_normal_irradiance' + sfx] ?? [],
  }));

  const providerEpochs = hourly.time;
  return {
    name: location.name,
    lat: location.lat,
    lon: location.lon,
    // The member arrays stay unchanged. Their keys move from provider interval
    // ends to Bowcast interval starts in exactly the same way as deterministic
    // weather, so member signals still align one-to-one.
    epochs: providerEpochs.map((epoch) => precedingInterval(epoch, HOUR_SECONDS).epoch),
    providerEpochs,
    members,
  };
}

export async function fetchEnsembles(locations, model, timezone = 'auto', days = 7) {
  const url = new URL('https://ensemble-api.open-meteo.com/v1/ensemble');
  url.searchParams.set('latitude', locations.map((l) => l.lat).join(','));
  url.searchParams.set('longitude', locations.map((l) => l.lon).join(','));
  url.searchParams.set('hourly', 'precipitation,rain,snowfall,cloud_cover,direct_normal_irradiance');
  url.searchParams.set('models', model || 'icon_seamless');
  // ICON-EPS provides 7.5 days; keep in sync with the deterministic fetch.
  url.searchParams.set('forecast_days', String(days));
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('timeformat', 'unixtime');

  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo ensemble API error: ${res.status} ${res.statusText}`);
  }

  let data = await res.json();
  if (!Array.isArray(data)) {
    data = [data];
  }

  return locations.map((location, idx) => normalizeEnsembleResult(location, data[idx]));
}
