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
import { pointsAround } from '../core/points.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // safe to call cross-origin
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'lat and lon query parameters are required' });
    return;
  }
  try {
    const data = await computeLikelihood(pointsAround(lat, lon), {
      ensembleModel: process.env.ENSEMBLE_MODEL,
    });
    // Edge-cache each area for 15 min; serve stale up to 30 min while revalidating.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'weather data temporarily unavailable' });
  }
}
