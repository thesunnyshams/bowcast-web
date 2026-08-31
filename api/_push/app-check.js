import { firebaseCredentialsConfigured, getFirebaseAdminApp } from './firebase-admin.js';

const APP_CHECK_HEADER = 'x-firebase-appcheck';
const MAX_APP_CHECK_TOKEN_BYTES = 8192;

export class PushAppCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PushAppCheckError';
    this.code = code;
  }
}

export function pushAppCheckRequired(env = process.env) {
  return env.PUSH_REQUIRE_APP_CHECK === '1';
}

export function allowedPushAppIds(env = process.env) {
  return new Set(
    String(env.PUSH_ALLOWED_APP_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function requestHeader(req, name) {
  const direct = req.headers?.[name];
  if (Array.isArray(direct)) return direct[0];
  if (typeof direct === 'string') return direct;
  const value = req.get?.(name) ?? req.header?.(name);
  return typeof value === 'string' ? value : '';
}

function normalizedToken(req) {
  const token = requestHeader(req, APP_CHECK_HEADER).trim();
  if (
    token.length < 16
    || Buffer.byteLength(token, 'utf8') > MAX_APP_CHECK_TOKEN_BYTES
    || /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new PushAppCheckError('unauthorized', 'valid app attestation required');
  }
  return token;
}

function verifiedAppId(result) {
  return result?.appId || result?.app_id || result?.token?.app_id || result?.token?.sub || result?.sub || '';
}

async function appCheckVerifier(env, verifyTokenFn) {
  if (verifyTokenFn) return verifyTokenFn;
  if (!firebaseCredentialsConfigured(env)) {
    throw new PushAppCheckError('configuration', 'Firebase credentials are not configured');
  }
  try {
    const [{ getAppCheck }, app] = await Promise.all([
      import('firebase-admin/app-check'),
      getFirebaseAdminApp({ required: true, env }),
    ]);
    return (value) => getAppCheck(app).verifyToken(value);
  } catch {
    throw new PushAppCheckError('configuration', 'push app attestation verifier is unavailable');
  }
}

export async function verifyPushAppCheckRequest(
  req,
  { env = process.env, verifyTokenFn = null } = {},
) {
  const enforced = pushAppCheckRequired(env);
  const rawToken = requestHeader(req, APP_CHECK_HEADER).trim();

  if (!enforced && !rawToken) {
    return { enforced: false, status: 'absent', appId: null };
  }

  const allowedAppIds = allowedPushAppIds(env);
  if (enforced && allowedAppIds.size === 0) {
    throw new PushAppCheckError('configuration', 'push app attestation allowlist is not configured');
  }

  if (!enforced) {
    try {
      const token = normalizedToken(req);
      const verify = await appCheckVerifier(env, verifyTokenFn);
      const result = await verify(token);
      const appId = verifiedAppId(result);
      if (!appId) return { enforced: false, status: 'invalid', appId: null };
      if (allowedAppIds.size > 0 && !allowedAppIds.has(appId)) {
        return { enforced: false, status: 'non_allowlisted', appId };
      }
      return { enforced: false, status: 'verified', appId };
    } catch (error) {
      const status = error instanceof PushAppCheckError && error.code === 'configuration'
        ? 'unavailable'
        : 'invalid';
      return { enforced: false, status, appId: null };
    }
  }

  const token = normalizedToken(req);
  const verify = await appCheckVerifier(env, verifyTokenFn);
  try {
    const result = await verify(token);
    const appId = verifiedAppId(result);
    if (!appId || !allowedAppIds.has(appId)) {
      throw new PushAppCheckError('unauthorized', 'valid app attestation required');
    }
    return { enforced: true, status: 'verified', appId };
  } catch (error) {
    if (error instanceof PushAppCheckError) throw error;
    throw new PushAppCheckError('unauthorized', 'valid app attestation required');
  }
}
