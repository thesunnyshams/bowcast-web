import fs from 'fs';

let appPromise = null;

function parseServiceAccount(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) return JSON.parse(decoded);
  } catch (_) {
    // It may be a file path, which is handled below.
  }

  if (fs.existsSync(trimmed)) return JSON.parse(fs.readFileSync(trimmed, 'utf8'));
  throw new Error('Firebase service account is neither JSON, base64 JSON, nor a readable path');
}

export function firebaseCredentialsConfigured(env = process.env) {
  return Boolean(
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    env.FIREBASE_SERVICE_ACCOUNT ||
    env.GOOGLE_APPLICATION_CREDENTIALS ||
    env.FIREBASE_CONFIG ||
    env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_PROJECT
  );
}

/** Initialize or reuse the default Admin SDK app without logging credentials. */
export async function getFirebaseAdminApp({ required = false, env = process.env } = {}) {
  if (appPromise) return appPromise;

  appPromise = (async () => {
    const { applicationDefault, cert, getApps, initializeApp } = await import('firebase-admin/app');
    const existing = getApps()[0];
    if (existing) return existing;

    if (!firebaseCredentialsConfigured(env)) {
      if (required) throw new Error('Firebase credentials are not configured');
      return null;
    }

    const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON || env.FIREBASE_SERVICE_ACCOUNT;
    const serviceAccount = raw ? parseServiceAccount(raw) : null;
    return initializeApp({ credential: serviceAccount ? cert(serviceAccount) : applicationDefault() });
  })().catch((error) => {
    appPromise = null;
    throw error;
  });

  return appPromise;
}
