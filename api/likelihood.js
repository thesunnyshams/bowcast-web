/**
 * Vercel serverless function: cached rainbow-likelihood forecast.
 *
 * Runs the same engine the app uses (computeLikelihood over a 9-point ring)
 * once per ~1 km area, and lets Vercel's edge cache it for 15 minutes, so every
 * visitor is served from cache instead of each browser hitting Open-Meteo
 * directly. This ends the per-IP daily rate limit that made the map silently
 * fall back to quality scores.
 *
 * Lives in public/ so the existing deploy pipeline copies it to the site root,
 * where Vercel picks up /api/* as functions. The land filter (dropping ring
 * points over open water) stays on the client, which uses the cheap, un-limited
 * elevation and geocoding APIs and filters this full-ring result before drawing.
 */
import { computeLikelihood } from '../core/likelihood.js';
import { attachPredictionContexts } from './_prediction-context.js';
import { pointsAround } from '../core/points.js';
import { createServerlessRateLimit, observeServerless, secureServerless } from './_observability.js';

const allowRequest = createServerlessRateLimit({ limit: 120, windowMs: 10 * 60 * 1000 });

export default async function handler(req, res) {
  const observation = observeServerless(req, res, '/api/likelihood');
  secureServerless(req, res);
  if (!allowRequest(req, res)) {
    observation.done(429);
    return res.status(429).json({ error: 'too many requests, please try again later' });
  }
  if (req.method && req.method !== 'GET') {
    observation.done(405);
    return res.status(405).json({ error: 'method not allowed' });
  }
  const missing = req.query.lat == null && req.query.lon == null;
  const lat = missing ? 48.4284 : Number(req.query.lat);
  const lon = missing ? -123.3656 : Number(req.query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    observation.done(400);
    return res.status(400).json({ error: 'lat and lon must be valid coordinates' });
  }
  try {
    const data = await computeLikelihood(pointsAround(lat, lon), {
      ensembleModel: process.env.ENSEMBLE_MODEL,
    });
    // Edge-cache each area for 15 min; serve stale up to 30 min while revalidating.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    observation.done(200);
    res.status(200).json(attachPredictionContexts(data));
  } catch (err) {
    observation.done(502, { error: err.message });
    res.status(502).json({ error: 'weather data temporarily unavailable' });
  }
}
