// Per-process, in-memory sliding window keyed by IP + endpoint name. Fine for a
// single instance; becomes inaccurate across multiple replicas behind a load
// balancer -- same caveat as the state/nonce store, both move to a shared store
// (Redis) together if this ever runs multi-replica. Hand-rolled rather than a
// dependency to match how the rest of this file already does rate limiting
// (see tutor-service's checkAndRecordRateLimit, same idea against SQLite).
const rateLimitBuckets = new Map(); // "name:ip" -> timestamps[]

function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
  return bucket.length > maxRequests;
}

function rateLimit(name, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = (req.get('x-forwarded-for') || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(`${name}:${ip}`, maxRequests, windowMs)) {
      return res.status(429).send('Too many requests. Try again shortly.');
    }
    next();
  };
}

module.exports = { isRateLimited, rateLimit };
