const DEFAULT_GEOCODING_ORIGIN = 'https://geocoding-api.open-meteo.com';
const PLACE_SEARCH_TIMEOUT_MS = 8_000;

export class PlaceSearchError extends Error {
  constructor(message, code = 'upstream') {
    super(message);
    this.name = 'PlaceSearchError';
    this.code = code;
  }
}

export function normalizePlaceQuery(value) {
  const query = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 2) {
    throw new PlaceSearchError('search query must contain at least two characters', 'invalid_query');
  }
  if (query.length > 80) {
    throw new PlaceSearchError('search query must contain at most 80 characters', 'invalid_query');
  }
  return query;
}

function normalizeOrigin(value) {
  const candidate = String(value || DEFAULT_GEOCODING_ORIGIN).trim();
  const url = new URL(candidate);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new PlaceSearchError('geocoding origin must be an HTTPS origin', 'configuration');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new PlaceSearchError('geocoding origin must not include a path', 'configuration');
  }
  return url.origin;
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const latitude = finiteCoordinate(result.latitude, -90, 90);
  const longitude = finiteCoordinate(result.longitude, -180, 180);
  const name = typeof result.name === 'string' ? result.name.trim() : '';
  if (!name || latitude === null || longitude === null) return null;

  return {
    id: String(result.id ?? `${latitude},${longitude}`),
    name,
    latitude,
    longitude,
    country: typeof result.country === 'string' ? result.country.trim() : null,
    countryCode: typeof result.country_code === 'string' ? result.country_code.trim() : null,
    admin1: typeof result.admin1 === 'string' ? result.admin1.trim() : null,
    timezone: typeof result.timezone === 'string' ? result.timezone.trim() : null,
    population: Number.isFinite(Number(result.population)) ? Number(result.population) : null,
  };
}

export async function searchPlaces(queryValue, {
  apiKey = process.env.OPEN_METEO_API_KEY,
  fetchImpl = fetch,
  origin = process.env.GEOCODING_API_ORIGIN,
  timeoutMs = PLACE_SEARCH_TIMEOUT_MS,
} = {}) {
  const query = normalizePlaceQuery(queryValue);
  const url = new URL('/v1/search', `${normalizeOrigin(origin)}/`);
  url.searchParams.set('name', query);
  url.searchParams.set('count', '8');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  if (apiKey) url.searchParams.set('apikey', apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlaceSearchError(`geocoding service returned ${response.status}`);
    }
    const payload = await response.json();
    return (Array.isArray(payload?.results) ? payload.results : [])
      .map(normalizeResult)
      .filter(Boolean);
  } catch (error) {
    if (error instanceof PlaceSearchError) throw error;
    if (controller.signal.aborted) throw new PlaceSearchError('place search timed out', 'timeout');
    throw new PlaceSearchError('place search is temporarily unavailable');
  } finally {
    clearTimeout(timeout);
  }
}
