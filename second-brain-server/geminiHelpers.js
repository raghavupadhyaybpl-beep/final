// geminiHelpers.js - small utilities for one-shot Gemini calls that must return usable output.
//
//   const { safeJSONParse, callGeminiWithRetry } = require("./geminiHelpers");
//   const { keyManager } = require("./keyManager");
//   const text = await callGeminiWithRetry('Reply ONLY with JSON: {"nodes": [...]}', keyManager);
//   const mindMap = safeJSONParse(text); // object, or null if the model's output wasn't valid JSON
//
// These are stateless (nothing is stored on Google's side, no thread, no previous_interaction_id).
// Chat turns should keep using sendGeminiMessage() in geminiService.js.

const {
  GeminiServiceError,
  extractText,
  callGeminiRaw,
  coolDownKey,
  allKeysExhausted,
  toServiceError,
  isKeyProblem,
  DEFAULT_MODEL,
} = require("./geminiService");

// ---------------------------------------------------------------------------
// safeJSONParse
// ---------------------------------------------------------------------------

/**
 * Parses JSON that came from a language model. Models often wrap JSON in markdown fences
 * (```json ... ```) or add a sentence before/after it, which makes JSON.parse throw.
 *
 * Steps: 1) take the contents of a ``` fence if there is one (or strip stray backticks),
 *        2) JSON.parse it, 3) if that fails, retry on just the part from the first { or [
 *        to the last } or ].
 * Returns the parsed value, or null (after logging) if nothing parses. It never throws.
 * Note: the text "null" is valid JSON and also returns null; the log tells the two apart.
 */
function safeJSONParse(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    console.error(`[safeJSONParse] nothing to parse (got ${rawText === null ? "null" : typeof rawText})`);
    return null;
  }

  let text = rawText.replace(/^\uFEFF/, "").trim(); // BOM + whitespace

  // A complete fence, with or without a language tag, possibly surrounded by prose.
  const fenced = text.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced) {
    text = fenced[1].trim();
  } else {
    // No closing fence (e.g. a cut-off answer) or single backticks: strip them from both ends.
    text = text.replace(/^`{1,3}[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "").replace(/`{1,3}\s*$/, "").trim();
  }

  try {
    return JSON.parse(text);
  } catch (firstError) {
    // Prose around the JSON: try the span from the first opening bracket to the last closing one.
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (secondError) { /* fall through to the log below */ }
    }
    const preview = rawText.replace(/\s+/g, " ").slice(0, 120);
    console.error(`[safeJSONParse] invalid JSON (${firstError.message}). Starts with: "${preview}"`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// callGeminiWithRetry
// ---------------------------------------------------------------------------

// Where array pools last stopped, so consecutive calls spread over the keys (round-robin).
const rotation = new WeakMap();

/**
 * Wraps either kind of pool in the same four operations:
 *   size()            how many keys there are
 *   next()            the next usable key (or null if every key is benched)
 *   bench(key, err)   stop using this key for the rest of the call (KeyManager: for its cooldown)
 *   label(key)        a safe name for logs, like "#2" (never the key itself)
 */
function makeKeySource(keyPool) {
  // A KeyManager (keyManager.js): shares cooldowns with the chat endpoint, so a key that was
  // rate limited here is skipped by /api/chat too.
  if (keyPool && typeof keyPool.getKey === "function") {
    return {
      size: () => keyPool.getKeyCount(),
      next: () => keyPool.getKey(), // throws KeyPoolError when every key is cooling down
      bench: (key, err) => coolDownKey(keyPool, key, err),
      label: (key) => "#" + keyPool.getKeyIndex(key),
    };
  }
  // A plain array of key strings.
  if (Array.isArray(keyPool)) {
    const keys = [...new Set(keyPool.filter((k) => typeof k === "string" && k.trim()))];
    const benched = new Set(); // keys that hit 429/401/403 during THIS call
    return {
      size: () => keys.length,
      next: () => {
        const start = rotation.get(keyPool) || 0;
        for (let i = 0; i < keys.length; i++) {
          const key = keys[(start + i) % keys.length];
          if (!benched.has(key)) {
            rotation.set(keyPool, (start + i + 1) % keys.length); // next call starts after this key
            return key;
          }
        }
        return null;
      },
      bench: (key) => benched.add(key),
      label: (key) => "#" + keys.indexOf(key),
    };
  }
  throw new TypeError("keyPool must be an array of API keys or a KeyManager");
}

/**
 * Sends one prompt to Gemini and returns the reply text. If a key fails, it logs the attempt and
 * immediately retries the same prompt with the next key, up to one retry per key in the pool.
 *
 * What counts as a key failure and is retried:
 *   HTTP 429, 401, 403, or "API key not valid"  -> that key is benched (not reused in this call)
 *   network error (connection refused/reset)    -> the key may be fine, so it can be tried again
 * Not retried (retrying wouldn't help, and each timeout can take up to 45 seconds): timeouts,
 * Gemini 5xx, and rejections of the request itself (HTTP 400/404).
 *
 * @param {string} prompt
 * @param {string[]|object} keyPool  array of API keys, or the shared KeyManager
 * @param {object} [options]
 * @param {string} [options.model]       default GEMINI_MODEL or gemini-3.8-flash
 * @param {string} [options.system]      optional system instruction
 * @param {number} [options.maxRetries]  default: the number of keys in the pool
 * @param {Function} [options.fetchImpl] for tests
 * @param {number} [options.timeoutMs]   per attempt, default GEMINI_TIMEOUT_MS or 45000
 * @throws GeminiServiceError: ALL_KEYS_EXHAUSTED (429) when no key is usable, GATEWAY_TIMEOUT (504)
 *         for timeouts / network failures / Gemini 5xx, INTERNAL_ERROR (500) for a rejected request.
 *         These are the same errors errorHandler.js already maps to HTTP responses.
 */
async function callGeminiWithRetry(prompt, keyPool, options = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new GeminiServiceError("Prompt is empty.", "BAD_REQUEST", 400);
  }
  const source = makeKeySource(keyPool);
  const size = source.size();
  if (size === 0) throw new GeminiServiceError("No Gemini API keys were provided.", "INTERNAL_ERROR", 500);

  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : size;
  const maxAttempts = maxRetries + 1;
  const body = {
    model: options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL,
    input: prompt,
    store: false, // one-shot: don't keep this interaction on Google's side
  };
  if (options.system) body.system_instruction = options.system;

  const failures = []; // "#1:429", "#0:network", ... for the final log / error
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ---- pick the next key ----
    let key;
    try {
      key = source.next();
    } catch (poolError) {
      // KeyManager: every key is cooling down.
      if (poolError && poolError.code === "ALL_KEYS_UNAVAILABLE") throw allKeysExhausted(failures, poolError.retryAfterSeconds);
      throw poolError;
    }
    if (key === null) throw allKeysExhausted(failures, 60); // array pool: every key was benched in this call

    try {
      const data = await callGeminiRaw(key, body, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
      const text = extractText(data);
      if (!text) throw new GeminiServiceError("The AI returned an empty answer.", "GATEWAY_TIMEOUT", 504);
      if (attempt > 1) console.log(`[gemini-retry] succeeded on attempt ${attempt}/${maxAttempts} with key ${source.label(key)}`);
      return text;
    } catch (e) {
      if (e instanceof GeminiServiceError) throw e; // empty answer etc.: already final
      lastError = e;

      const keyProblem = isKeyProblem(e);
      const networkProblem = e.code === "NETWORK";
      if (!keyProblem && !networkProblem) throw toServiceError(e); // timeout, 5xx, 400...: don't retry

      failures.push(`${source.label(key)}:${keyProblem ? e.status : "network"}`);
      console.warn(
        `[gemini-retry] attempt ${attempt}/${maxAttempts} failed (key ${source.label(key)}, ` +
        `${keyProblem ? "HTTP " + e.status : "network error"}); ` +
        (attempt < maxAttempts ? "retrying with the next key" : "no retries left")
      );
      if (keyProblem) source.bench(key, e); // network errors don't bench the key: it may be fine
    }
  }

  // Retries used up. If the last failure was a key problem the pool is effectively exhausted;
  // otherwise Gemini was unreachable.
  if (lastError && isKeyProblem(lastError)) {
    throw allKeysExhausted(failures, lastError.retryAfterMs ? Math.ceil(lastError.retryAfterMs / 1000) : 60);
  }
  console.error(`[gemini-retry] giving up after ${maxAttempts} attempts: ${failures.join(", ")}`);
  throw new GeminiServiceError("Could not reach the AI service.", "GATEWAY_TIMEOUT", 504);
}

module.exports = { safeJSONParse, callGeminiWithRetry };
