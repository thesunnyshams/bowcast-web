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
 * where Vercel picks up /api/* as functions.
 *
 * The ring is classified against the terrain DEM here rather than in each
 * client. Every point still ships; the water ones are labelled `land: false`
 * and hidden by the shared keepLandPoints rule. Doing it once per cached area
 * instead of once per visitor is both fewer elevation requests and, more to
 * the point, one answer: the map used to filter, the city pages did not, and
 * the app did not either, so the same coastline read three ways.
 *
 * ?compact=1 drops the per-hour series, which is two thirds of the response and
 * is read by the map alone. The 66 generated city pages only ever use the daily
 * summaries, so they ask for the small version.
 */
import { computeLikelihood } from '../core/likelihood.js';
import { attachPredictionContexts } from './_prediction-context.js';
import { pointsAround } from '../core/points.js';
import { resolveLandPoints } from '../core/land.js';
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
    // resolveLandPoints never rejects: an unreachable DEM returns land: null
    // and the whole ring renders, exactly as it did before this was cached.
    const data = await computeLikelihood(await resolveLandPoints(pointsAround(lat, lon)), {
      ensembleModel: process.env.ENSEMBLE_MODEL,
    });
    // Edge-cache each area for 15 min; serve stale up to 30 min while revalidating.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=900, stale-while-revalidate=1800');
    observation.done(200);
    if (req.query.compact === '1') {
      // No hourly series means no reportable interval, so there is nothing to
      // sign either: skip the token minting rather than paying for it unused.
      const locations = data.locations.map(({ hourly, ...rest }) => rest);
      return res.status(200).json({ ...data, locations });
    }
    res.status(200).json(attachPredictionContexts(data));
  } catch (err) {
    observation.done(502, { error: err.message });
    res.status(502).json({ error: 'weather data temporarily unavailable' });
  }
}
