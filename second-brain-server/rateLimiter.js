// rateLimiter.js - in-memory Token Bucket rate limiter (Express middleware).
//
// HOW THE TOKEN BUCKET WORKS
//  * Each client has a bucket that holds up to `capacity` tokens (15) and starts full.
//  * Every request costs 1 token. Tokens come back at 1 per `refillIntervalMs` (4s),
//    which equals 15 per minute, and the bucket never holds more than `capacity`.
//  * No timers refill buckets. Instead we refill lazily when a request arrives:
//        tokens = min(capacity, tokens + (now - lastUpdate) / refillIntervalMs)
//    Tokens are kept fractional, so "half a token" of waiting time is never lost.
//  * If tokens < 1 the request is blocked. The wait until the next token is exact:
//        retryAfter = ceil((1 - tokens) * refillIntervalMs / 1000) seconds
//    e.g. 0 tokens -> 4s, 0.5 tokens -> 2s. Blocked requests cost nothing.
//  * Bursts are allowed (15 at once), then the client is limited to one request per 4s.

class TokenBucketLimiter {
  constructor({
    capacity = 15,                 // max tokens per bucket
    refillIntervalMs = 4000,       // 1 token every 4s = 15 per minute
    staleAfterMs = 10 * 60 * 1000, // forget clients idle for 10 minutes
    cleanupIntervalMs = 60 * 1000, // how often the sweep runs
    maxBuckets = 100000,           // hard cap so a flood of fake IDs can't exhaust memory
    now = Date.now,                // replaceable in tests to fake the clock
  } = {}) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.maxBuckets = maxBuckets;
    this.now = now;
    this.buckets = new Map(); // clientId -> { tokens, updatedAt }, ordered least -> most recently used

    // Periodic sweep. unref() lets the process exit even though this timer is still running.
    this.timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Tries to spend 1 token for this client. Returns { allowed, remaining, limit, retryAfterSeconds }. */
  take(clientId) {
    const t = this.now();
    let bucket = this.buckets.get(clientId);

    if (bucket) {
      this.buckets.delete(clientId); // re-added below, which moves it to the "recent" end of the Map
      // Lazy refill. Math.max(0, ...) protects against the system clock moving backwards.
      const gained = Math.max(0, t - bucket.updatedAt) / this.refillIntervalMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + gained);
    } else {
      bucket = { tokens: this.capacity, updatedAt: t }; // new clients start with a full bucket
    }
    bucket.updatedAt = t;

    let allowed = false;
    let retryAfterSeconds = 0;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    } else {
      retryAfterSeconds = Math.max(1, Math.ceil(((1 - bucket.tokens) * this.refillIntervalMs) / 1000));
    }

    this.buckets.set(clientId, bucket);
    // Over the cap: drop the least recently used client (first key in the Map).
    if (this.buckets.size > this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value);

    return { allowed, remaining: Math.floor(bucket.tokens), limit: this.capacity, retryAfterSeconds };
  }

  /**
   * Deletes buckets not touched for `staleAfterMs`. Safe: a bucket idle that long has
   * already refilled to full, so a returning client gets a fresh full bucket anyway.
   */
  cleanup() {
    const cutoff = this.now() - this.staleAfterMs;
    for (const [id, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(id);
      else break; // Map is ordered by last use, so everything after this is newer
    }
  }

  /** Stops the cleanup timer (for tests or a graceful shutdown). */
  stop() {
    clearInterval(this.timer);
  }
}

/** Passed to next() when a client is out of tokens; errorHandler.js turns it into the 429 response. */
class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
    this.code = "RATE_LIMITED";
    this.retryAfterSeconds = retryAfterSeconds; // exact seconds until the next token
  }
}

/**
 * Identifies the caller: a client-supplied session ID (header "x-session-id") if present
 * and well-formed, otherwise the IP address.
 * NOTE: a session ID is chosen by the client, so someone could rotate IDs to dodge the
 * limit. Pass `useSessionHeader: false` to rate limit by IP only.
 */
function getClientId(req, useSessionHeader = true) {
  const sid = useSessionHeader ? req.headers && req.headers["x-session-id"] : null;
  if (typeof sid === "string" && /^[\w.-]{8,64}$/.test(sid)) return "session:" + sid;
  return "ip:" + (req.ip || "unknown");
}

/** Builds the Express middleware. Run it BEFORE any route that calls the AI API. */
function createRateLimiter(options = {}) {
  const { useSessionHeader = true, ...limiterOptions } = options;
  const limiter = new TokenBucketLimiter(limiterOptions);

  function rateLimiter(req, res, next) {
    const result = limiter.take(getClientId(req, useSessionHeader));

    res.set("X-RateLimit-Limit", String(result.limit));
    res.set("X-RateLimit-Remaining", String(result.remaining));
    res.locals.rateLimit = result; // lets later handlers (e.g. /api/test-limit) read the state

    if (!result.allowed) {
      // Blocked before any database or Gemini work. errorHandler.js sends HTTP 429 USER_RATE_LIMIT
      // with the Retry-After header.
      return next(new RateLimitError(result.retryAfterSeconds));
    }
    next();
  }

  rateLimiter.limiter = limiter; // exposed for tests / shutdown
  return rateLimiter;
}

// Shared limiter: 15 requests per minute per client.
const rateLimiter = createRateLimiter();

module.exports = { rateLimiter, createRateLimiter, TokenBucketLimiter, getClientId, RateLimitError };
