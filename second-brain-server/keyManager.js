// keyManager.js - Round-robin pool of Gemini API keys with cooldown tracking.
//
// HOW IT WORKS
//  * Rotation: every getKey() call starts looking at the slot after the one used last
//    (round-robin), so load is spread evenly across all keys.
//  * Cooldown: when a key hits a limit, the caller reports it. That key gets a
//    "cooldownUntil" timestamp and getKey() skips it while the clock is before that time.
//  * Recovery: there are no timers. A key becomes usable again simply because the current
//    time passes its cooldownUntil, so nothing needs cleaning up and nothing can leak.
//  * Exhaustion: if every key is cooling down, getKey() throws a KeyPoolError carrying an
//    HTTP status and a retry hint, so the route can answer the frontend cleanly.

// Optional: load .env here too so this module also works on its own (e.g. in scripts).
try { require("dotenv").config(); } catch (e) { /* dotenv not installed: fine, env may already be set */ }

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;   // 429: per-minute limits usually clear fast
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 60 * 1000; // 401/403/quota: don't hammer a bad key

/** Thrown by getKey() when no key can be handed out. */
class KeyPoolError extends Error {
  constructor(message, code, status, retryAfterSeconds = null) {
    super(message);
    this.name = "KeyPoolError";
    this.code = code;                       // "NO_KEYS_CONFIGURED" | "ALL_KEYS_UNAVAILABLE"
    this.status = status;                   // HTTP status the route should return
    this.retryAfterSeconds = retryAfterSeconds; // earliest time a key frees up (or null)
  }
}

/**
 * Reads keys from the environment. Supported (all can be mixed, duplicates are removed):
 *   GEMINI_API_KEYS=key1,key2,key3      comma-separated list
 *   GEMINI_KEY_1, GEMINI_KEY_2, ...     numbered keys (sorted by number)
 *   GEMINI_API_KEY=key                  single key (kept for older .env files)
 * Empty values and obvious placeholders like "your_key_here" are ignored, so a 1-key
 * setup, or an untouched .env.example, never breaks startup.
 */
function parseKeysFromEnv(env = process.env) {
  const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
  const found = [];

  if (env.GEMINI_API_KEYS) found.push(...env.GEMINI_API_KEYS.split(",").map(clean));

  Object.keys(env)
    .map((name) => name.match(/^GEMINI_KEY_(\d+)$/))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .forEach((m) => found.push(clean(env[m[0]])));

  if (env.GEMINI_API_KEY) found.push(clean(env.GEMINI_API_KEY));

  const placeholder = /^(your|paste|changeme|example|xxx)|^key\d*$/i; // "your_key_1", "key1", ...
  return [...new Set(found.filter((k) => k && !placeholder.test(k)))];
}

class KeyManager {
  /**
   * @param {string[]} keys  API keys, in rotation order
   * @param {{now?: () => number}} [opts]  `now` can be replaced in tests to fake the clock
   */
  constructor(keys = [], { now = Date.now } = {}) {
    this.now = now;
    this.next = 0; // slot where the next search starts
    this.slots = keys.map((key, index) => ({ key, index, cooldownUntil: 0 }));
  }

  /** Returns the next active key (round-robin). Throws KeyPoolError if none is usable. */
  getKey() {
    const total = this.slots.length;
    if (total === 0) {
      throw new KeyPoolError(
        "No Gemini API keys are configured on the server.",
        "NO_KEYS_CONFIGURED",
        500
      );
    }

    const t = this.now();
    for (let i = 0; i < total; i++) {
      const slot = this.slots[(this.next + i) % total];
      if (slot.cooldownUntil <= t) {
        this.next = (slot.index + 1) % total; // next call starts after this key
        return slot.key;
      }
    }

    // Every key is cooling down: tell the caller when the first one comes back.
    const soonest = Math.min(...this.slots.map((s) => s.cooldownUntil - t));
    throw new KeyPoolError(
      "All API keys are busy or out of quota. Please try again shortly.",
      "ALL_KEYS_UNAVAILABLE",
      503,
      Math.max(1, Math.ceil(soonest / 1000))
    );
  }

  /** Call on HTTP 429. Skips this key for `cooldownMs` (default 60s). Returns false if unknown key. */
  markKeyAsRateLimited(key, cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS) {
    return this._cool(key, cooldownMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  }

  /**
   * Call on quota exhaustion or auth failure (401/403, revoked key). Uses a long
   * cooldown (default 1 hour) so a dead key isn't retried constantly, yet it
   * recovers by itself if you fix it. For a daily quota, pass the time until reset.
   */
  markKeyAsFailed(key, cooldownMs = DEFAULT_FAILURE_COOLDOWN_MS) {
    return this._cool(key, cooldownMs, DEFAULT_FAILURE_COOLDOWN_MS);
  }

  _cool(key, cooldownMs, fallbackMs) {
    const slot = this.slots.find((s) => s.key === key);
    if (!slot) return false;
    const ms = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : fallbackMs;
    // Never shorten an existing cooldown (several in-flight requests may report the same key).
    slot.cooldownUntil = Math.max(slot.cooldownUntil, this.now() + ms);
    return true;
  }

  /** How many keys can be used right now. */
  getActiveKeyCount() {
    const t = this.now();
    return this.slots.filter((s) => s.cooldownUntil <= t).length;
  }

  /** Total keys loaded, active or not. */
  getKeyCount() {
    return this.slots.length;
  }

  /** Position of a key in the pool (0-based), or -1. Safe to log, unlike the key itself. */
  getKeyIndex(key) {
    const slot = this.slots.find((s) => s.key === key);
    return slot ? slot.index : -1;
  }

  /** Health snapshot for debugging. Never includes the key values. */
  getStatus() {
    const t = this.now();
    return this.slots.map((s) => ({
      index: s.index,
      active: s.cooldownUntil <= t,
      cooldownSecondsLeft: Math.max(0, Math.ceil((s.cooldownUntil - t) / 1000)),
    }));
  }
}

// Shared pool for the whole server, built from the environment at startup.
const keyManager = new KeyManager(parseKeysFromEnv());

module.exports = { keyManager, KeyManager, KeyPoolError, parseKeysFromEnv };
