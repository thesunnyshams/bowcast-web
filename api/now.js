/**
 * Vercel serverless function: cached worldwide rainbow ranking.
 *
 * Computing every city in each visitor's browser is slow and multiplies
 * upstream weather requests. The edge cache shares one result for ten minutes;
 * the page can still fall back to the browser-safe core if this route is down.
 */
import { rankNow } from '../core/now.js';
import { CITIES } from '../core/cities.js';
import { createServerlessRateLimit, observeServerless, secureServerless } from './_observability.js';

const allowRequest = createServerlessRateLimit({ limit: 30, windowMs: 10 * 60 * 1000 });

export default async function handler(req, res) {
  const observation = observeServerless(req, res, '/api/now');
  secureServerless(req, res);
  if (!allowRequest(req, res)) {
    observation.done(429);
    return res.status(429).json({ error: 'too many requests, please try again later' });
  }
  if (req.method && req.method !== 'GET') {
    observation.done(405);
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const data = await rankNow(CITIES, {
      ensembleModel: process.env.ENSEMBLE_MODEL,
    });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    observation.done(200, { returnedCities: data.coverage?.returned ?? data.cities.length, requestedCities: CITIES.length });
    return res.status(200).json(data);
  } catch (error) {
    observation.done(502, { error: error.message });
    return res.status(502).json({ error: 'worldwide forecast temporarily unavailable' });
  }
}
