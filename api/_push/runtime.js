import crypto from 'crypto';

import { initPush } from './service.js';

let initialization = null;

export function ensurePushInitialized() {
  if (!initialization) {
    initialization = initPush().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

export function isJsonRequest(req) {
  return String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
    === 'application/json';
}

export function requestBodyBytes(req) {
  try {
    return Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  } catch {
    return Infinity;
  }
}

export function bearerMatches(req, secret) {
  if (typeof secret !== 'string' || secret.length < 16) return false;
  const supplied = String(req.headers?.authorization || '');
  const expected = `Bearer ${secret}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function normalizeForecastOrigin(value) {
  const url = new URL(String(value || 'https://bowcast.app'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PUSH_FORECAST_ORIGIN must be a plain HTTPS origin');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('PUSH_FORECAST_ORIGIN must not include a path');
  }
  return url.origin;
}
