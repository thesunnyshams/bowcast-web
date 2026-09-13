import { searchPlaces, PlaceSearchError } from './_place-search.js';
import { createServerlessRateLimit, observeServerless, secureServerless } from './_observability.js';

const allowRequest = createServerlessRateLimit({ limit: 60, windowMs: 10 * 60 * 1000 });

export function createPlacesHandler({ searchPlacesFn = searchPlaces } = {}) {
  return async function placesHandler(req, res) {
    const observation = observeServerless(req, res, '/api/places');
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
      const places = await searchPlacesFn(req.query?.q);
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600');
      observation.done(200, { returnedPlaces: places.length });
      return res.status(200).json({ places });
    } catch (error) {
      if (error instanceof PlaceSearchError && error.code === 'invalid_query') {
        observation.done(400);
        return res.status(400).json({ error: error.message, field: 'q' });
      }
      observation.done(502, { errorType: error?.code || error?.name || 'Error' });
      return res.status(502).json({ error: 'place search temporarily unavailable' });
    }
  };
}

export default createPlacesHandler();
