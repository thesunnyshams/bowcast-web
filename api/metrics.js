import { MetricValidationError, normalizeMetricEvent } from '../core/metrics.js';
// The Admin SDK helper is generic despite its directory: src/firebase-admin.js
// is a re-export of this same module, so this is the one credential-parsing
// implementation rather than a third copy of it.
import { firebaseCredentialsConfigured, getFirebaseAdminApp } from './_push/firebase-admin.js';
import { createServerlessRateLimit, observeServerless, secureServerless } from './_observability.js';

// Kept identical to FirestoreMetricRepository in src/metrics.js: same
// collection, same document id, same fields. The Express server and this
// function write one store, so scripts/analyze-metrics.js reads both.
const COLLECTION = process.env.METRICS_FIRESTORE_COLLECTION || 'bowcast_metrics_v1';
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Matches checkMetricRate in server.js.
const allowRequest = createServerlessRateLimit({ limit: 60, windowMs: 15 * 60 * 1000 });

let firestorePromise = null;
let lastPrunedDate = null;

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const cutoffKey = (now, retentionDays) => dayKey(now - retentionDays * DAY_MS);
const documentId = (date, source, event) => `${date}_${source}_${event}`;

async function getFirestore() {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(COLLECTION)) throw new Error('Invalid metrics Firestore collection name');
      const app = await getFirebaseAdminApp({ required: true });
      const { FieldValue, getFirestore: getFirestoreClient } = await import('firebase-admin/firestore');
      const firestore = process.env.FIRESTORE_DATABASE_ID
        ? getFirestoreClient(app, process.env.FIRESTORE_DATABASE_ID)
        : getFirestoreClient(app);
      return { collection: firestore.collection(COLLECTION), FieldValue, firestore };
    })().catch((error) => {
      firestorePromise = null;
      throw error;
    });
  }
  return firestorePromise;
}

/**
 * Retention is a privacy property, not a housekeeping detail: the 90-day limit
 * is what README and docs/PRD.md promise. `expiresAt` lets a Firestore TTL
 * policy do the same work, but pruning here keeps the promise true whether or
 * not that policy is configured. Once a day has been swept the query returns
 * empty, so a warm instance pays nothing.
 */
async function pruneExpiredDays({ collection, firestore }, date) {
  if (lastPrunedDate === date) return;
  const cutoff = cutoffKey(Date.parse(`${date}T00:00:00.000Z`), RETENTION_DAYS);
  while (true) {
    const snapshot = await collection.where('date', '<', cutoff).limit(400).get();
    if (snapshot.empty) break;
    const batch = firestore.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
    if (snapshot.docs.length < 400) break;
  }
  lastPrunedDate = date;
}

/**
 * One counter per day, source, and event. Nothing per request is stored, so
 * the store cannot answer who or where, only how many.
 */
async function recordMetricEvent({ event, source }, now = Date.now()) {
  const store = await getFirestore();
  const date = dayKey(now);
  await pruneExpiredDays(store, date);
  await store.collection.doc(documentId(date, source, event)).set({
    schemaVersion: 1,
    date,
    source,
    event,
    count: store.FieldValue.increment(1),
    updatedAt: new Date(now),
    expiresAt: new Date(now + RETENTION_DAYS * DAY_MS),
  }, { merge: true });
}

export function createMetricsHandler({
  record = recordMetricEvent,
  storageConfigured = () => firebaseCredentialsConfigured(),
} = {}) {
  return async function metricsHandler(req, res) {
    const observation = observeServerless(req, res, '/api/metrics');
    secureServerless(req, res, { cors: 'allowlist', methods: 'POST, OPTIONS' });
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') { observation.done(204); return res.status(204).end(); }
    if (req.method !== 'POST') { observation.done(405); return res.status(405).json({ error: 'method not allowed' }); }
    if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
      observation.done(415);
      return res.status(415).json({ error: 'content type must be application/json' });
    }
    if (!storageConfigured()) {
      observation.done(503, { storageConfigured: false });
      return res.status(503).json({ error: 'metrics storage is not configured' });
    }

    const bodyBytes = Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    if (bodyBytes > 16 * 1024) { observation.done(413); return res.status(413).json({ error: 'request body too large' }); }

    if (!allowRequest(req, res)) {
      observation.done(429);
      return res.status(429).json({ error: 'too many metric events, please try again later' });
    }

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      // normalizeMetricEvent is the privacy boundary. It rejects every field
      // outside the allowlist, so coordinates, identifiers, referrers, and
      // free-form metadata cannot reach storage even if a client sends them.
      const metric = normalizeMetricEvent(body);
      await record(metric);
      observation.done(204, { storage: 'firestore' });
      return res.status(204).end();
    } catch (error) {
      if (error instanceof MetricValidationError || error instanceof SyntaxError) {
        // The rejected field name is client-supplied text. It goes back to the
        // caller that sent it and stays out of the log line.
        observation.done(400);
        return res.status(400).json({
          error: error instanceof SyntaxError ? 'request body must be valid JSON' : error.message,
          ...(error.field ? { field: error.field } : {}),
        });
      }
      console.error('POST /api/metrics error:', error.message);
      observation.done(503, { error: error.message });
      return res.status(503).json({ error: 'metrics storage temporarily unavailable' });
    }
  };
}

export default createMetricsHandler();
