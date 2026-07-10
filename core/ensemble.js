/**
 * Ensemble forecast provider — Open-Meteo Ensemble API.
 *
 * Returns per-member hourly series so scoring can compute P(rainbow) as the
 * fraction of members with sunlit rain (Monte Carlo over forecast
 * uncertainty). All provider-specific parsing stays in this file.
 *
 * Default model: ICON-EPS via `icon_seamless` (40 members). Pass a different
 * model id (e.g. `gfs_seamless`, `gem_global`) as the second argument.
 * Runs in both Node and the browser (no Node-only APIs).
 */
export async function fetchEnsembles(locations, model, timezone = 'auto', days = 7) {
  const url = new URL('https://ensemble-api.open-meteo.com/v1/ensemble');
  url.searchParams.set('latitude', locations.map((l) => l.lat).join(','));
  url.searchParams.set('longitude', locations.map((l) => l.lon).join(','));
  url.searchParams.set('hourly', 'precipitation,snowfall,cloud_cover,direct_normal_irradiance');
  url.searchParams.set('models', model || 'icon_seamless');
  // ICON-EPS provides 7.5 days; keep in sync with the deterministic fetch.
  url.searchParams.set('forecast_days', String(days));
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('timeformat', 'unixtime');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo ensemble API error: ${res.status} ${res.statusText}`);
  }

  let data = await res.json();
  if (!Array.isArray(data)) {
    data = [data];
  }

  return locations.map((location, idx) => {
    const hourly = data[idx].hourly;

    // Variables come back per member: unsuffixed = control run, then
    // `precipitation_member01` ... `_memberNN`. Discover suffixes generically.
    const suffixes = Object.keys(hourly)
      .filter((k) => /^precipitation(_member\d+)?$/.test(k))
      .map((k) => k.slice('precipitation'.length));

    const members = suffixes.map((sfx) => ({
      precipMm: hourly['precipitation' + sfx] ?? [],
      snowMm: hourly['snowfall' + sfx] ?? [],
      cloudTotal: hourly['cloud_cover' + sfx] ?? [],
      dni: hourly['direct_normal_irradiance' + sfx] ?? [],
    }));

    return {
      name: location.name,
      lat: location.lat,
      lon: location.lon,
      epochs: hourly.time,
      members,
    };
  });
}
