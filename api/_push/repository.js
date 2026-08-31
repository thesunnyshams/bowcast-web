import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { firebaseCredentialsConfigured, getFirebaseAdminApp } from './firebase-admin.js';

const TOKEN_COLLECTION = 'rainbow_push_tokens_v1';
const ALERT_COLLECTION = 'rainbow_push_alerts_v1';

const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');
const alertId = (key) => crypto.createHash('sha256').update(key).digest('hex');

async function atomicJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temp, file);
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export class JsonPushRepository {
  constructor({ tokensFile, alertsFile }) {
    this.tokensFile = tokensFile;
    this.alertsFile = alertsFile;
    this.backend = 'json';
    this.queue = Promise.resolve();
  }

  serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async saveToken(entry) {
    return this.serialized(async () => {
      const tokens = await readJson(this.tokensFile);
      const id = tokenId(entry.token);
      const existing = tokens[id] || tokens[entry.token];
      delete tokens[entry.token];
      tokens[id] = { ...entry, createdAt: existing?.createdAt || entry.updatedAt };
      await atomicJson(this.tokensFile, tokens);
      return { count: Object.keys(tokens).length };
    });
  }

  async deleteToken(token) {
    return this.deleteTokens([token]);
  }

  async deleteTokens(tokenValues) {
    return this.serialized(async () => {
      const tokens = await readJson(this.tokensFile);
      for (const token of tokenValues) {
        delete tokens[tokenId(token)];
        delete tokens[token];
      }
      await atomicJson(this.tokensFile, tokens);
    });
  }

  async listTokens() {
    return Object.values(await readJson(this.tokensFile));
  }

  async claimAlert(key, ttlMs, now = Date.now()) {
    return this.serialized(async () => {
      const alerts = await readJson(this.alertsFile);
      for (const [id, claim] of Object.entries(alerts)) {
        if (!Number.isFinite(claim.claimedAt) || now - claim.claimedAt > ttlMs) delete alerts[id];
      }
      const id = alertId(key);
      if (alerts[id]) return false;
      alerts[id] = { claimedAt: now };
      await atomicJson(this.alertsFile, alerts);
      return true;
    });
  }

  async releaseAlert(key) {
    return this.serialized(async () => {
      const alerts = await readJson(this.alertsFile);
      delete alerts[alertId(key)];
      await atomicJson(this.alertsFile, alerts);
    });
  }
}

export class FirestorePushRepository {
  constructor(firestore, { tokenCollection = TOKEN_COLLECTION, alertCollection = ALERT_COLLECTION } = {}) {
    this.firestore = firestore;
    this.tokens = firestore.collection(tokenCollection);
    this.alerts = firestore.collection(alertCollection);
    this.backend = 'firestore';
  }

  async saveToken(entry) {
    const ref = this.tokens.doc(tokenId(entry.token));
    const existing = await ref.get();
    await ref.set({ ...entry, createdAt: existing.data()?.createdAt || entry.updatedAt }, { merge: true });
    return { count: null };
  }

  async deleteToken(token) {
    await this.tokens.doc(tokenId(token)).delete();
  }

  async deleteTokens(tokens) {
    for (let i = 0; i < tokens.length; i += 400) {
      const batch = this.firestore.batch();
      for (const token of tokens.slice(i, i + 400)) batch.delete(this.tokens.doc(tokenId(token)));
      await batch.commit();
    }
  }

  async listTokens() {
    const snapshot = await this.tokens.get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async claimAlert(key, ttlMs, now = Date.now()) {
    const ref = this.alerts.doc(alertId(key));
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const claimedAt = snapshot.data()?.claimedAt;
      if (Number.isFinite(claimedAt) && now - claimedAt <= ttlMs) return false;
      transaction.set(ref, { claimedAt: now, expiresAt: new Date(now + ttlMs) });
      return true;
    });
  }

  async releaseAlert(key) {
    await this.alerts.doc(alertId(key)).delete();
  }
}

function validCollection(value, fallback) {
  const name = value || fallback;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Invalid push Firestore collection name');
  return name;
}

export async function createPushRepository({ env = process.env, dataDir = path.resolve('data') } = {}) {
  if (firebaseCredentialsConfigured(env)) {
    const app = await getFirebaseAdminApp({ required: true, env });
    const { getFirestore } = await import('firebase-admin/firestore');
    const firestore = env.FIRESTORE_DATABASE_ID ? getFirestore(app, env.FIRESTORE_DATABASE_ID) : getFirestore(app);
    return new FirestorePushRepository(firestore, {
      tokenCollection: validCollection(env.PUSH_TOKEN_COLLECTION, TOKEN_COLLECTION),
      alertCollection: validCollection(env.PUSH_ALERT_COLLECTION, ALERT_COLLECTION),
    });
  }
  return new JsonPushRepository({
    tokensFile: env.PUSH_TOKENS_FILE || path.join(dataDir, 'push-tokens.json'),
    alertsFile: env.PUSH_ALERTS_FILE || path.join(dataDir, 'push-sent.json'),
  });
}
