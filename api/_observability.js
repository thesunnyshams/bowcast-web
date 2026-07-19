import crypto from 'crypto';

export function observeServerless(req, res, route) {
  const started = Date.now();
  const requestId = String(req.headers?.['x-vercel-id'] || req.headers?.['x-request-id'] || `local-${Date.now()}`).slice(0, 128);
  res.setHeader('X-Request-Id', requestId);
  return {
    done(status, extra = {}) {
      console.log(JSON.stringify({ level: status >= 500 ? 'error' : 'info', message: 'request complete', requestId, method: req.method, route, status, durationMs: Date.now() - started, ...extra }));
    },
  };
}

const DEFAULT_ORIGINS = new Set(['https://bowcast.app', 'capacitor://localhost', 'http://localhost', 'https://localhost']);

export function secureServerless(req, res, { cors = 'public', methods = 'GET, OPTIONS' } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=()');
  const origin = req.headers?.origin;
  if (cors === 'public') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin) {
    const configured = new Set([...DEFAULT_ORIGINS, ...(process.env.API_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)]);
    if (configured.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function createServerlessRateLimit({ limit, windowMs }) {
  const salt = crypto.randomBytes(32);
  const buckets = new Map();
  return (req, res) => {
    const forwarded = req.headers?.['x-forwarded-for'];
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
    const key = crypto.createHmac('sha256', salt).update(ip).digest('hex');
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count++;
    buckets.set(key, bucket);
    if (buckets.size > 2000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
      if (buckets.size > 2000) {
        const oldest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, buckets.size - 2000);
        for (const [bucketKey] of oldest) buckets.delete(bucketKey);
      }
    }
    const remaining = Math.max(0, limit - bucket.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    if (bucket.count <= limit) return true;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return false;
  };
}
