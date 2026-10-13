import crypto from 'crypto';
import fs from 'fs';
import { computeLikelihood } from '../core/likelihood.js';
import { normalizeSightingReport, SightingValidationError } from '../core/sightings.js';
import { verifyOrRefreshSightingRecord } from './_prediction-context.js';
import { observeServerless, secureServerless } from './_observability.js';

const COLLECTION = process.env.SIGHTINGS_FIRESTORE_COLLECTION || 'rainbow_sightings_v1';
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateSalt = crypto.randomBytes(32);
const rateBuckets = new Map();
let firestorePromise = null;

function credentialsConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_CONFIG ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT
  );
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) return JSON.parse(decoded);
  } catch (_) {
    // It may be a file path.
  }
  if (fs.existsSync(trimmed)) return JSON.parse(fs.readFileSync(trimmed, 'utf8'));
  throw new Error('Firebase service account configuration is not usable');
}

async function getFirestoreRepository() {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      if (!credentialsConfigured()) throw new Error('Firebase credentials are not configured');
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(COLLECTION)) throw new Error('Invalid Firestore collection name');

      const { applicationDefault, cert, getApps, initializeApp } = await import('firebase-admin/app');
      let app = getApps()[0];
      if (!app) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
        const serviceAccount = raw ? parseServiceAccount(raw) : null;
        app = initializeApp({ credential: serviceAccount ? cert(serviceAccount) : applicationDefault() });
      }
      const { getFirestore } = await import('firebase-admin/firestore');
      return process.env.FIRESTORE_DATABASE_ID
        ? getFirestore(app, process.env.FIRESTORE_DATABASE_ID)
        : getFirestore(app);
    })().catch((error) => {
      firestorePromise = null;
      throw error;
    });
  }
  return firestorePromise;
}

function allowRequest(ip) {
  const now = Date.now();
  if (rateBuckets.size >= 2000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const key = crypto.createHmac('sha256', rateSalt).update(String(ip || '')).digest('hex');
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 2000) {
    const oldest = [...rateBuckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, rateBuckets.size - 2000);
    for (const [bucketKey] of oldest) rateBuckets.delete(bucketKey);
  }
  return {
    allowed: bucket.count <= RATE_LIMIT,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function requestIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  const observation = observeServerless(req, res, '/api/sightings');
  secureServerless(req, res, { cors: 'allowlist', methods: 'POST, OPTIONS' });
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { observation.done(204); return res.status(204).end(); }
  if (req.method !== 'POST') { observation.done(405); return res.status(405).json({ error: 'method not allowed' }); }
  if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
    observation.done(415);
    return res.status(415).json({ error: 'content type must be application/json' });
  }
  if (!credentialsConfigured()) {
    observation.done(503, { storageConfigured: false });
    return res.status(503).json({ error: 'report storage is not configured' });
  }

  const bodyBytes = Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  if (bodyBytes > 16 * 1024) { observation.done(413); return res.status(413).json({ error: 'request body too large' }); }

  const rate = allowRequest(requestIp(req));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    observation.done(429);
    return res.status(429).json({ error: 'too many reports, please try again later' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const normalized = normalizeSightingReport(body);
    const record = await verifyOrRefreshSightingRecord(
      normalized,
      body?.forecast?.verificationToken,
      computeLikelihood,
    );
    const firestore = await getFirestoreRepository();
    let created = true;
    try {
      await firestore.collection(COLLECTION).doc(record.id).create(record);
    } catch (error) {
      if (error.code === 6 || error.code === 'already-exists') created = false;
      else throw error;
    }
    observation.done(created ? 201 : 200, { storage: 'firestore', created });
    return res.status(created ? 201 : 200).json({
      ok: true,
      reportId: record.id,
      duplicate: !created,
      storage: 'firestore',
    });
  } catch (error) {
    if (error instanceof SightingValidationError || error instanceof SyntaxError) {
      observation.done(400);
      return res.status(400).json({
        error: error instanceof SyntaxError ? 'request body must be valid JSON' : error.message,
        ...(error.field ? { field: error.field } : {}),
      });
    }
    console.error('POST /api/sightings error:', error.message);
    observation.done(503, { error: error.message });
    return res.status(503).json({ error: 'report storage temporarily unavailable' });
  }
}
