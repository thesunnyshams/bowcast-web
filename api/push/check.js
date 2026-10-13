import { checkAndNotifyAll, PushValidationError } from '../_push/service.js';
import {
  bearerMatches,
  ensurePushInitialized,
  normalizeForecastOrigin,
} from '../_push/runtime.js';
import { observeServerless, secureServerless } from '../_observability.js';

async function fetchCellForecast(fetchImpl, origin, lat, lon) {
  const url = new URL('/api/likelihood', `${origin}/`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('compact', '1');
  const configuredTimeout = Number(process.env.PUSH_FORECAST_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 60_000)
    : 25_000;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`forecast endpoint returned ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.locations)) {
    throw new Error('forecast endpoint returned an invalid response');
  }
  return payload;
}

export function createPushCheckHandler({
  check = checkAndNotifyAll,
  fetchImpl = fetch,
  forecastOrigin = process.env.PUSH_FORECAST_ORIGIN,
  initialize = ensurePushInitialized,
  // CRON_SECRET is Vercel's own name: it supplies the matching
  // `Authorization: Bearer` header on every scheduled invocation, so the value
  // never enters the app or this repository. The Express route in server.js
  // guards the same path with PUSH_CRON_SECRET, its own local and Docker
  // variable. Both are right for their runtime; neither name works in the
  // other. An unset or short secret fails closed in bearerMatches.
  secret = process.env.CRON_SECRET,
} = {}) {
  return async function pushCheckHandler(req, res) {
    const observation = observeServerless(req, res, '/api/push/check');
    secureServerless(req, res, { cors: 'private', methods: 'GET' });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      observation.done(405);
      return res.status(405).json({ error: 'method not allowed' });
    }
    if (!bearerMatches(req, secret)) {
      observation.done(401);
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const origin = normalizeForecastOrigin(forecastOrigin);
      await initialize();
      const result = await check(
        (lat, lon) => fetchCellForecast(fetchImpl, origin, lat, lon),
        25,
      );
      observation.done(200, {
        alerts: result.alerts,
        cells: result.cells,
        failed: result.failed,
        sent: result.sent,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof PushValidationError) {
        observation.done(400);
        return res.status(400).json({ error: error.message, field: error.field });
      }
      observation.done(502, { errorType: error?.name || 'Error' });
      return res.status(502).json({ error: 'push check failed' });
    }
  };
}

export default createPushCheckHandler();
