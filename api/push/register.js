import { PushValidationError, registerToken } from '../_push/service.js';
import { PushAppCheckError, verifyPushAppCheckRequest } from '../_push/app-check.js';
import { ensurePushInitialized, isJsonRequest, requestBodyBytes } from '../_push/runtime.js';
import { createServerlessRateLimit, observeServerless, secureServerless } from '../_observability.js';

const allowRequest = createServerlessRateLimit({ limit: 30, windowMs: 10 * 60 * 1000 });

export function createRegisterHandler({
  initialize = ensurePushInitialized,
  register = registerToken,
  verifyAppCheck = verifyPushAppCheckRequest,
} = {}) {
  return async function registerHandler(req, res) {
    const observation = observeServerless(req, res, '/api/push/register');
    secureServerless(req, res, { cors: 'native', methods: 'POST, OPTIONS' });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      observation.done(204);
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      observation.done(405);
      return res.status(405).json({ error: 'method not allowed' });
    }
    if (!isJsonRequest(req)) {
      observation.done(415);
      return res.status(415).json({ error: 'content type must be application/json' });
    }
    if (requestBodyBytes(req) > 16 * 1024) {
      observation.done(413);
      return res.status(413).json({ error: 'request body too large' });
    }
    if (!allowRequest(req, res)) {
      observation.done(429);
      return res.status(429).json({ error: 'too many push requests, please try again later' });
    }
    try {
      const appCheck = await verifyAppCheck(req);
      await initialize();
      const result = await register(req.body);
      observation.done(200, { storage: result.storage, appCheck: appCheck?.status || 'unknown' });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof PushAppCheckError) {
        const status = error.code === 'configuration' ? 503 : 401;
        observation.done(status, { errorType: error.name });
        return res.status(status).json({
          error: status === 401 ? 'valid app attestation required' : 'push attestation temporarily unavailable',
        });
      }
      if (error instanceof PushValidationError) {
        observation.done(400);
        return res.status(400).json({ error: error.message, field: error.field });
      }
      observation.done(503, { errorType: error?.name || 'Error' });
      return res.status(503).json({ error: 'push registration temporarily unavailable' });
    }
  };
}

export default createRegisterHandler();
