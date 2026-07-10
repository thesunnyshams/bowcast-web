export async function fetchForecasts(locations, { timezone = 'auto', days = 7 } = {}) {
  const lats = locations.map((l) => l.lat).join(',');
  const lons = locations.map((l) => l.lon).join(',');

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lats);
  url.searchParams.set('longitude', lons);
  url.searchParams.set('hourly', 'precipitation_probability,precipitation,rain,showers,snowfall,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,sunshine_duration,cape,wind_direction_10m,wind_speed_10m,temperature_2m,is_day');
  url.searchParams.set('minutely_15', 'precipitation,sunshine_duration');
  url.searchParams.set('timezone', timezone);
  url.searchParams.set('forecast_days', String(days));
  url.searchParams.set('timeformat', 'unixtime');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  }

  let data = await res.json();

  // Normalize: single coordinate returns object, multiple returns array
  if (!Array.isArray(data)) {
    data = [data];
  }

  return locations.map((location, idx) => {
    const result = data[idx];
    const hourly = result.hourly;

    const hours = hourly.time.map((epoch, i) => ({
      epoch,
      precipMm: hourly.precipitation[i] ?? 0,
      rainMm: hourly.rain?.[i] ?? null,
      showersMm: hourly.showers?.[i] ?? null,
      snowMm: hourly.snowfall?.[i] ?? null,
      precipProb: hourly.precipitation_probability?.[i] ?? null,
      weatherCode: hourly.weather_code?.[i] ?? null,
      cloudTotal: hourly.cloud_cover?.[i] ?? null,
      cloudLow: hourly.cloud_cover_low?.[i] ?? null,
      cloudMid: hourly.cloud_cover_mid?.[i] ?? null,
      cloudHigh: hourly.cloud_cover_high?.[i] ?? null,
      sunshineSec: hourly.sunshine_duration?.[i] ?? null,
      cape: hourly.cape?.[i] ?? null,
      windDirDeg: hourly.wind_direction_10m?.[i] ?? null,
      windKmh: hourly.wind_speed_10m?.[i] ?? null,
      tempC: hourly.temperature_2m?.[i] ?? null,
      isDay: hourly.is_day?.[i] ?? 1,
    }));

    const minutely = result.minutely_15?.time ? result.minutely_15.time.map((epoch, i) => ({
      epoch,
      precipMm: result.minutely_15.precipitation[i] ?? 0,
      sunshineSec: result.minutely_15.sunshine_duration?.[i] ?? null,
    })) : [];

    return {
      name: location.name,
      lat: location.lat,
      lon: location.lon,
      timezone: result.timezone || 'UTC', // resolved IANA zone when 'auto' was requested
      utcOffsetSeconds: result.utc_offset_seconds ?? 0,
      hours,
      minutely,
    };
  });
}
