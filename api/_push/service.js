import crypto from 'crypto';
import fs from 'fs';
import http2 from 'http2';
import { composeAlert, alertEligible } from '../../core/alerts.js';
import { cellKey, relativePointName } from '../../core/points.js';
import { firebaseCredentialsConfigured, getFirebaseAdminApp } from './firebase-admin.js';
import { createPushRepository } from './repository.js';

const ALERT_TTL_MS = 36 * 60 * 60 * 1000;
const APNS_JWT_MAX_AGE_MS = 50 * 60 * 1000;
const DEFAULT_APNS_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_APNS_CONCURRENCY = 8;
export const ALERT_NOTIFICATION_ROUTE = '/';
export const DEFAULT_ALERT_THRESHOLD = 25;
export const MIN_ALERT_THRESHOLD = 5;
export const MAX_ALERT_THRESHOLD = 95;
export const ALERT_THRESHOLD_STEP = 5;
const PLATFORM = new Set(['android', 'ios']);
let messaging = null;
let repositoryPromise = null;
let dryRun = false;
let apnsConfig = null;
let runtimeEnv = process.env;
let activeCheck = null;
let apnsConnect = http2.connect;
let apnsClient = null;
let apnsJwt = null;
let apnsJwtCreatedAt = 0;
let apnsDeliveryQueue = Promise.resolve();

export class PushValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'PushValidationError';
    this.field = field;
  }
}

function validation(message, field) {
  throw new PushValidationError(message, field);
}

function isSelectableAlertThreshold(value) {
  return Number.isInteger(value)
    && value >= MIN_ALERT_THRESHOLD
    && value <= MAX_ALERT_THRESHOLD
    && value % ALERT_THRESHOLD_STEP === 0;
}

function registrationThreshold(value, fallback = DEFAULT_ALERT_THRESHOLD) {
  return isSelectableAlertThreshold(value) ? value : fallback;
}

export function normalizePushRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) validation('request body must be an object', 'body');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (token.length < 20 || token.length > 4096 || /[\u0000-\u001f\u007f\s]/.test(token)) validation('token is not valid', 'token');
  const platform = String(input.platform || '').toLowerCase();
  if (!PLATFORM.has(platform)) validation('platform must be android or ios', 'platform');
  if (platform === 'ios' && (!/^[a-f0-9]+$/i.test(token) || token.length % 2 !== 0)) {
    validation('iOS token must be an even-length hexadecimal APNs device token', 'token');
  }
  const lat = input.lat;
  const lon = input.lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) validation('lat must be between -90 and 90', 'lat');
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) validation('lon must be between -180 and 180', 'lon');
  const threshold = input.threshold ?? DEFAULT_ALERT_THRESHOLD;
  if (!isSelectableAlertThreshold(threshold)) {
    validation('threshold must be a 5-point step between 5 and 95', 'threshold');
  }
  return {
    token,
    platform,
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    threshold,
    updatedAt: new Date().toISOString(),
  };
}

const PEM_LABEL = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * Rebuild a PEM that survived a trip through an environment variable.
 *
 * Apple's `.p8` is a PKCS#8 PEM, and OpenSSL will only decode it when the
 * armour sits on its own lines. Pasting the file into a dashboard field
 * routinely flattens it to one line, or arrives base64 wrapped, and either way
 * signing fails with "DECODER routines::unsupported" at the first send, long
 * after configuration looked healthy: the key is present, so APNs reports as
 * configured and only delivery breaks. Every recoverable shape is normalized
 * here rather than asking anyone to re-paste a secret.
 */
function normalizePrivateKey(value) {
  const unescaped = String(value).replace(/\\n/g, '\n').trim();
  const candidates = [unescaped];
  // A whole PEM, base64 wrapped a second time to survive transport.
  if (!unescaped.includes('-----BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(unescaped)) {
    try {
      const decoded = Buffer.from(unescaped, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) candidates.push(decoded.trim());
    } catch {
      // Not base64 after all; the original candidate stands.
    }
  }
  for (const candidate of candidates) {
    const match = candidate.match(PEM_LABEL);
    if (!match) continue;
    const label = match[1];
    const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
    if (!body) continue;
    return armour(label, body);
  }
  // A key body with the armour lost entirely. Apple ships `.p8` as PKCS#8, so
  // that is the only label this can be, and DER for a P-256 key is about 138
  // bytes: long enough to distinguish from a stray identifier, short enough
  // that a whole certificate chain will not be mistaken for one.
  const bare = unescaped.replace(/\s/g, '');
  if (!unescaped.includes('-----') && /^[A-Za-z0-9+/]+={0,2}$/.test(bare) && bare.length >= 100) {
    return armour('PRIVATE KEY', bare);
  }
  return unescaped;
}

function armour(label, body) {
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function readSecret(value, file) {
  if (value) return normalizePrivateKey(value);
  if (file) return normalizePrivateKey(fs.readFileSync(file, 'utf8'));
  return null;
}

function loadApnsConfig(env) {
  const key = readSecret(env.APNS_PRIVATE_KEY, env.APNS_PRIVATE_KEY_PATH);
  if (!key && !env.APNS_KEY_ID && !env.APNS_TEAM_ID) return null;
  if (!key || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) {
    throw new Error('APNs requires APNS_PRIVATE_KEY, APNS_KEY_ID, APNS_TEAM_ID, and APNS_TOPIC');
  }
  return { key, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC, production: env.APNS_PRODUCTION === '1' };
}

/** The endpoint a config addresses, as a word rather than a boolean. */
function apnsEnvironment(config) {
  return config.production ? 'production' : 'sandbox';
}

/**
 * Whether the topic and the endpoint disagree about which app they serve.
 *
 * `APNS_TOPIC` and `APNS_PRODUCTION` have to move together, and they are two
 * separate fields in a dashboard, so changing one and forgetting the other is
 * the likely way this breaks. It authenticates cleanly and then fails per
 * device with `DeviceTokenNotForTopic`, which reads as a stale token rather
 * than as a misconfiguration, and because that reason counts as invalid the
 * run deletes the registration it could not deliver to. The `.dev` bundle only
 * ever ships as a development build, so it belongs to the sandbox endpoint,
 * and the App Store bundle belongs to the production one.
 */
function apnsPairingFault(config) {
  if (!config) return null;
  const topicIsDevelopment = config.topic.endsWith('.dev');
  if (topicIsDevelopment === !config.production) return null;
  return config.production
    ? 'a development topic is addressed to the production endpoint'
    : 'an App Store topic is addressed to the sandbox endpoint';
}

export function pushStatus() {
  return { enabled: dryRun || !!messaging || !!apnsConfig, dryRun, android: dryRun || !!messaging, ios: dryRun || !!apnsConfig };
}

export function pushEnabled() {
  return pushStatus().enabled;
}

function closeApnsClient(client = apnsClient) {
  if (!client) return;
  if (apnsClient === client) apnsClient = null;
  try { client.close(); } catch (_) {}
}

export async function initPush({ env = process.env, connectApns = http2.connect } = {}) {
  closeApnsClient();
  runtimeEnv = env;
  apnsConnect = connectApns;
  apnsJwt = null;
  apnsJwtCreatedAt = 0;
  apnsDeliveryQueue = Promise.resolve();
  dryRun = env.PUSH_DRY_RUN === '1';
  repositoryPromise = createPushRepository({ env });
  apnsConfig = loadApnsConfig(env);
  messaging = null;
  if (firebaseCredentialsConfigured(env)) {
    const { getMessaging } = await import('firebase-admin/messaging');
    messaging = getMessaging(await getFirebaseAdminApp({ required: true, env }));
  }
  const status = pushStatus();
  // The topic and endpoint are named here because an environment switch is
  // otherwise unobservable: a deployment addressing the wrong app logs exactly
  // what a correct one logs until a device rejects it. A bundle identifier is
  // public, unlike everything else this file holds.
  console.log(JSON.stringify({
    level: 'info', message: 'push initialized',
    enabled: status.enabled, dryRun: status.dryRun, android: status.android, ios: status.ios,
    apnsTopic: apnsConfig?.topic ?? null,
    apnsEnvironment: apnsConfig ? apnsEnvironment(apnsConfig) : null,
  }));
  const pairingFault = apnsPairingFault(apnsConfig);
  if (pairingFault) {
    console.warn(JSON.stringify({
      level: 'warn', message: 'apns topic and environment disagree', detail: pairingFault,
      apnsTopic: apnsConfig.topic, apnsEnvironment: apnsEnvironment(apnsConfig),
    }));
  }
  return status;
}

async function repository() {
  if (!repositoryPromise) repositoryPromise = createPushRepository();
  return repositoryPromise;
}

export async function registerToken(input) {
  const entry = normalizePushRegistration(input);
  const repo = await repository();
  const result = await repo.saveToken(entry);
  return { ...result, storage: repo.backend };
}

export async function unregisterToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) validation('token is not valid', 'token');
  await (await repository()).deleteToken(token.trim());
}

const base64url = (value) => Buffer.from(value).toString('base64url');

export function createApnsJwt(config, now = Date.now()) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const payload = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const data = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: config.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${data}.${signature}`;
}

/**
 * Describe a provider key that will not sign, without revealing any of it.
 *
 * Only shape: how long it is, whether it carries PEM armour, how many lines it
 * has, and which character classes it uses. That is enough to tell a flattened
 * PEM from a bare key body from a file path pasted into the variable, and none
 * of it can reconstruct the secret.
 */
function describeUnusableKey(key) {
  const value = String(key || '');
  return {
    keyChars: value.length,
    hasBeginArmour: value.includes('-----BEGIN'),
    hasEndArmour: value.includes('-----END'),
    lineCount: value.split('\n').length,
    base64Only: /^[A-Za-z0-9+/=\s]+$/.test(value),
    looksLikePath: /^[\w./\\:-]+$/.test(value) && value.length < 256,
  };
}

function currentApnsJwt(now = Date.now()) {
  if (!apnsJwt || now - apnsJwtCreatedAt >= APNS_JWT_MAX_AGE_MS) {
    try {
      apnsJwt = createApnsJwt(apnsConfig, now);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'APNs provider key could not sign',
        errorType: error.code || error.name || 'Error',
        ...describeUnusableKey(apnsConfig?.key),
      }));
      throw error;
    }
    apnsJwtCreatedAt = now;
  }
  return apnsJwt;
}

function getApnsClient() {
  if (apnsClient && !apnsClient.closed && !apnsClient.destroyed) return apnsClient;
  const authority = apnsConfig.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  const client = apnsConnect(authority);
  apnsClient = client;
  client.on('error', () => closeApnsClient(client));
  client.on('goaway', () => closeApnsClient(client));
  client.on('close', () => { if (apnsClient === client) apnsClient = null; });
  if (typeof client.setTimeout === 'function') {
    client.setTimeout(60_000, () => closeApnsClient(client));
  }
  return client;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function apnsResult(entry, status, reason = '', error = '') {
  const invalid = status === 410
    || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'ExpiredToken', 'Unregistered'].includes(reason);
  const retryable = status === 429 || status >= 500 || status === 0;
  return { entry, ok: status === 200, invalid, retryable, status, reason, error };
}

async function sendApnsRequest(delivery) {
  const client = getApnsClient();
  const timeoutMs = positiveInteger(
    runtimeEnv.APNS_REQUEST_TIMEOUT_MS,
    DEFAULT_APNS_REQUEST_TIMEOUT_MS,
    60_000,
  );
  return new Promise((resolve) => {
    let request;
    let status = 0;
    let response = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      client.removeListener('error', onSessionError);
      resolve(result);
    };
    const onSessionError = (error) => finish(apnsResult(delivery.entry, 0, 'SessionError', error.message));
    client.once('error', onSessionError);
    try {
      request = client.request({
        ':method': 'POST', ':path': `/3/device/${delivery.entry.token}`,
        authorization: `bearer ${currentApnsJwt()}`, 'apns-topic': apnsConfig.topic,
        'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
      });
    } catch (error) {
      finish(apnsResult(delivery.entry, 0, 'RequestError', error.message));
      return;
    }
    timer = setTimeout(() => {
      try { request.close?.(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
      finish(apnsResult(delivery.entry, 0, 'RequestTimeout', 'APNs request timed out'));
    }, timeoutMs);
    timer.unref?.();
    request.on('response', (headers) => { status = Number(headers[':status']); });
    request.on('data', (chunk) => { response += chunk; });
    request.on('error', (error) => finish(apnsResult(delivery.entry, 0, 'StreamError', error.message)));
    request.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(response || '{}').reason || ''; } catch (_) {}
      finish(apnsResult(delivery.entry, status, reason));
    });
    // expo-notifications builds content.data from userInfo["body"] alone for
    // remote pushes, so a top-level custom key never reaches the app. The
    // route has to be nested under body to survive.
    request.end(JSON.stringify({
      aps: {
        alert: { title: delivery.notification.title, body: delivery.notification.body },
        sound: 'default',
      },
      body: { url: ALERT_NOTIFICATION_ROUTE },
    }));
  });
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function sendApns(deliveries) {
  if (!deliveries.length) return [];
  if (!apnsConfig) return deliveries.map(({ entry }) => apnsResult(entry, 0, 'NotConfigured'));
  // Authenticate one stream first. Apple permits only one token-authenticated
  // stream until a request with valid authentication has reached APNs.
  const first = await sendApnsRequest(deliveries[0]);
  if (deliveries.length === 1) return [first];
  const concurrency = positiveInteger(runtimeEnv.APNS_MAX_CONCURRENCY, DEFAULT_APNS_CONCURRENCY, 32);
  const rest = await mapWithConcurrency(deliveries.slice(1), concurrency, sendApnsRequest);
  return [first, ...rest];
}

function queueApns(deliveries) {
  const result = apnsDeliveryQueue.then(
    () => sendApns(deliveries),
    () => sendApns(deliveries),
  );
  apnsDeliveryQueue = result.then(() => undefined, () => undefined);
  return result;
}

function fcmResult(entry, result) {
  if (result.success) return { entry, ok: true, invalid: false, retryable: false, reason: '' };
  const code = result.error?.code || 'messaging/unknown-error';
  const invalid = code === 'messaging/registration-token-not-registered'
    || code === 'messaging/invalid-registration-token';
  return { entry, ok: false, invalid, retryable: !invalid, reason: code };
}

async function sendFcm(deliveries) {
  if (!deliveries.length) return [];
  if (!messaging) return deliveries.map(({ entry }) => ({ entry, ok: false, invalid: false, retryable: true, reason: 'NotConfigured' }));
  const groups = new Map();
  for (const delivery of deliveries) {
    const key = JSON.stringify(delivery.notification);
    if (!groups.has(key)) groups.set(key, { notification: delivery.notification, entries: [] });
    groups.get(key).entries.push(delivery.entry);
  }
  const results = [];
  for (const { notification, entries } of groups.values()) {
    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500);
      const response = await messaging.sendEachForMulticast({
        data: { url: ALERT_NOTIFICATION_ROUTE },
        notification,
        tokens: batch.map((entry) => entry.token),
      });
      response.responses.forEach((result, index) => results.push(fcmResult(batch[index], result)));
    }
  }
  return results;
}

async function deliver(deliveries) {
  if (dryRun) return deliveries.map(({ entry }) => ({ entry, ok: true, invalid: false, retryable: false, reason: 'DryRun' }));
  try {
    const [android, ios] = await Promise.all([
      sendFcm(deliveries.filter(({ entry }) => entry.platform === 'android')),
      queueApns(deliveries.filter(({ entry }) => entry.platform === 'ios')),
    ]);
    return [...android, ...ios];
  } catch (error) {
    return deliveries.map(({ entry }) => ({ entry, ok: false, invalid: false, retryable: true, reason: error.name || 'DeliveryError' }));
  }
}

/** Cells one run may evaluate before it starts rotating through the rest. */
const DEFAULT_PUSH_MAX_CELLS = 500;
/** One rotation step per cron tick. The cron fires every fifteen minutes. */
const CELL_ROTATION_MS = 15 * 60 * 1000;

/**
 * The cells a single run is allowed to evaluate.
 *
 * Every cell costs one upstream forecast fan-out per run, spent before any
 * threshold is tested, and a registration nobody can deliver to is never found
 * invalid so it survives until `PUSH_TOKEN_MAX_AGE_DAYS`. Unbounded, that lets
 * whoever registers the most tokens set the bill. Above the budget the run
 * takes a window of a stably sorted list and advances one window per tick, so
 * every cell is still reached, just less often. At or below it, this is a
 * no-op and nothing rotates.
 */
function scheduledCells(cells, now = Date.now()) {
  const ordered = [...cells.entries()];
  const budget = positiveInteger(runtimeEnv.PUSH_MAX_CELLS, DEFAULT_PUSH_MAX_CELLS, 10000);
  if (ordered.length <= budget) return ordered;
  ordered.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const windows = Math.ceil(ordered.length / budget);
  const start = (Math.floor(now / CELL_ROTATION_MS) % windows) * budget;
  const window = [];
  for (let offset = 0; offset < budget; offset += 1) window.push(ordered[(start + offset) % ordered.length]);
  console.warn(JSON.stringify({
    level: 'warn',
    message: 'push cell budget exceeded',
    cells: ordered.length,
    evaluated: window.length,
  }));
  return window;
}

async function runPushCheck(computeForCell, threshold = 25) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) validation('threshold must be between 0 and 100', 'threshold');
  const repo = await repository();
  const allEntries = await repo.listTokens();
  const maxAgeDays = Number(runtimeEnv.PUSH_TOKEN_MAX_AGE_DAYS || 180);
  const cutoff = Date.now() - (Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 180) * 24 * 60 * 60 * 1000;
  const expired = allEntries.filter((entry) => {
    const timestamp = Date.parse(entry.updatedAt || entry.createdAt || entry.addedAt || '');
    return Number.isFinite(timestamp) && timestamp < cutoff;
  });
  if (expired.length) await repo.deleteTokens(expired.map((entry) => entry.token));
  const expiredTokens = new Set(expired.map((entry) => entry.token));
  const entries = allEntries.filter((entry) => !expiredTokens.has(entry.token) && PLATFORM.has(entry.platform) && Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
  const cells = new Map();
  for (const entry of entries) {
    const key = cellKey(entry.lat, entry.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(entry);
  }
  let sent = 0;
  let failed = 0;
  let failedCells = 0;
  let alerts = 0;
  const invalid = [];
  const cellConcurrency = positiveInteger(runtimeEnv.PUSH_CELL_CONCURRENCY, 4, 12);
  const scheduled = scheduledCells(cells);
  await mapWithConcurrency(scheduled, cellConcurrency, async ([cell, cellEntries]) => {
    const [lat, lon] = cell.split(',').map(Number);
    let data;
    try {
      data = await computeForCell(lat, lon);
    } catch (error) {
      failedCells++;
      console.error(JSON.stringify({ level: 'error', message: 'push cell forecast failed', errorType: error.code || error.name || 'Error' }));
      return;
    }
    // A passed peak must never page a phone. Threshold the still-actionable
    // nextPeak when present, falling back to the whole-day probability for
    // legacy shapes. Each recipient is evaluated against their own threshold.
    const actionableP = (location) => (location.nextPeak?.probability ?? location.probability) ?? 0;
    const actionableLocations = (data.locations || []).filter(
      (location) => alertEligible(location),
    );
    if (!actionableLocations.length) return;
    const date = data.locations?.[0]?.days?.[0]?.date || new Date().toISOString().slice(0, 10);
    const claimed = [];
    for (const entry of cellEntries) {
      const recipientThreshold = registrationThreshold(entry.threshold, threshold);
      const candidates = actionableLocations.filter(
        (location) => actionableP(location) >= recipientThreshold,
      );
      if (!candidates.length) continue;
      const best = candidates.reduce(
        (winner, location) => (actionableP(location) > actionableP(winner) ? location : winner),
      );
      const intervalKey = `${best.nextPeak?.intervalStartEpoch ?? best.bestIntervalStartEpoch ?? best.bestEpoch ?? best.bestInterval ?? best.bestHour}|${best.nextPeak?.intervalEndEpoch ?? best.bestIntervalEndEpoch ?? ''}`;
      const key = `${cell}|${date}|${intervalKey}`;
      const recipientKey = `${key}|${crypto.createHash('sha256').update(entry.token).digest('hex')}`;
      if (dryRun || await repo.claimAlert(recipientKey, ALERT_TTL_MS)) {
        claimed.push({
          entry,
          recipientKey,
          notification: composeAlert({
            ...best,
            name: relativePointName(entry.lat, entry.lon, best),
          }),
        });
      }
    }
    if (!claimed.length) return;
    let results;
    try {
      results = await deliver(claimed);
    } catch (error) {
      failed += claimed.length;
      failedCells++;
      if (!dryRun) await Promise.all(claimed.map(({ recipientKey }) => repo.releaseAlert(recipientKey)));
      console.error(JSON.stringify({ level: 'error', message: 'push cell delivery failed', errorType: error.code || error.name || 'Error' }));
      return;
    }
    const resultByToken = new Map(results.map((result) => [result.entry.token, result]));
    let cellSent = 0;
    for (const delivery of claimed) {
      const result = resultByToken.get(delivery.entry.token);
      if (result?.ok) {
        sent++;
        cellSent++;
      } else {
        failed++;
        // A rejected send used to raise the `failed` count and say nothing else,
        // so a scheduled run could report a failure with no way to tell a dead
        // HTTP/2 session from a wrong topic from a rejected provider token. The
        // token, the coordinates and the payload stay out of this line; the
        // provider's own verdict is what makes it diagnosable.
        console.error(JSON.stringify({
          level: 'error',
          message: 'push delivery rejected',
          platform: delivery.entry.platform,
          status: result?.status ?? null,
          reason: result?.reason || 'NoResult',
          detail: String(result?.error || '').slice(0, 200) || undefined,
          retryable: !!result?.retryable,
          invalid: !!result?.invalid,
        }));
        if (!dryRun && (result?.retryable || result?.invalid || !result)) {
          await repo.releaseAlert(delivery.recipientKey);
        }
      }
      if (result?.invalid) invalid.push(delivery.entry.token);
    }
    if (cellSent > 0) alerts++;
  });
  if (invalid.length) await repo.deleteTokens(invalid);
  return { cells: cells.size, evaluatedCells: scheduled.length, sent, failed, failedCells, alerts, removedInvalidTokens: invalid.length, removedExpiredTokens: expired.length, storage: repo.backend };
}

export async function checkAndNotifyAll(computeForCell, threshold = 25) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) validation('threshold must be between 0 and 100', 'threshold');
  if (activeCheck) return activeCheck;
  activeCheck = runPushCheck(computeForCell, threshold);
  try {
    return await activeCheck;
  } finally {
    activeCheck = null;
  }
}
