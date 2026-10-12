// geminiService.js - talks to the Gemini Interactions API (plain REST, no SDK needed).
//
// HOW last_interaction_id KEEPS CONTEXT LIGHT
//  * Every Gemini reply has an `id`. We save it in threads.last_interaction_id.
//  * On the next turn we send ONLY the new message plus previous_interaction_id. Gemini
//    keeps the conversation on ITS side and links the new turn to the old ones, so we
//    never re-upload the history. Request size stays small however long the chat gets.
//  * Each reply has a new id, which replaces the stored one, so the chain moves forward.
//
// HOW FAILOVER AND RECOVERY WORK (see the loop in sendGeminiMessage)
//  * Key problem (HTTP 429, 401, 403, or "API key not valid"): that key is benched in the key
//    pool and the SAME request is sent again with the next key. Up to MAX_KEY_RETRIES (3) retries.
//  * Pool empty: when no key is left, or the retries are used up, it throws ALL_KEYS_EXHAUSTED.
//    errorHandler.js turns that into HTTP 429 API_QUOTA_EXHAUSTED.
//  * Expired session (HTTP 410, 404, or "invalid previous_interaction_id"): the stale ID is
//    cleared from SQLite and the request is retried ONCE as a new conversation. The new chain
//    starts with the last few saved messages so the topic isn't forgotten. This recovery
//    doesn't use up the key retries.
//  * Timeouts, connection failures and Gemini 5xx are NOT retried: they throw GATEWAY_TIMEOUT
//    (HTTP 504). Waiting longer would only hold a queue slot.
//  Errors thrown from here carry an internal `code`; errorHandler.js maps them to responses.

const { KeyPoolError } = require("./keyManager");

const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.8-flash"; // override with GEMINI_MODEL in .env
const HISTORY_LIMIT = 12;                 // saved messages replayed after a session reset
const MAX_KEY_RETRIES = 3;                // failovers to another key, after the first try

/**
 * What sendGeminiMessage throws for failures it understands. `code` is internal:
 *   ALL_KEYS_EXHAUSTED  (429)  every key failed or is cooling down
 *   GATEWAY_TIMEOUT     (504)  Gemini timed out, was unreachable, returned 5xx or an empty answer
 *   INTERNAL_ERROR      (500)  Gemini rejected our request in a way retrying can't fix (a bug)
 *   BAD_REQUEST         (400)  empty message
 */
class GeminiServiceError extends Error {
  constructor(message, code, status, retryAfterSeconds = null) {
    super(message);
    this.name = "GeminiServiceError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.failures = null; // e.g. ["#0:429", "#1:403"], for logs only
  }
}

/** Internal: a failed call to Google (HTTP error, timeout or network failure). */
class UpstreamError extends Error {
  constructor(message, { status = 0, code = "HTTP", retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.code = code; // "HTTP" | "TIMEOUT" | "NETWORK"
    this.retryAfterMs = retryAfterMs;
  }
}

/** System guidance: "Second Brain" persona + the thread's topic. */
function buildSystemInstruction(topic) {
  // The title is user-typed and goes into a prompt: strip quotes/newlines and cap the length.
  const t = String(topic || "").replace(/["\r\n]+/g, " ").trim().slice(0, 80);
  const hasTopic = t && t.toLowerCase() !== "general";
  return [
    `You are the user's "Second Brain": a warm, practical idea partner and memory aid, chatting on a phone.`,
    `Server date (UTC): ${new Date().toUTCString()}; the user's local date may differ by a few hours. Answer simple questions such as today's day or date directly.`,
    hasTopic
      ? `This chat thread is called "${t}". Treat it as its own project: stay on this topic and never bring in details from other threads or projects.`
      : `This is the user's general thread. Keep it separate from any specific project.`,
    `Be concise (under about 130 words unless asked for more) with short paragraphs or a few bullets. When the user shares an idea, explain it clearly: what it is, who it's for, how it could work, first steps and main risks.`,
    `You cannot browse the internet. For facts you can't be sure of (costs, prices, laws, market data), give a rough range with your assumptions, say plainly it is an estimate, and end with one final line: VERIFY: <a short Google search query to check it>. Omit that line when no verification is needed.`,
  ].join("\n");
}

/** Input for a new session: recent saved messages + the new message, as one text block. */
function buildTranscript(history, message) {
  if (!history.length) return message;
  const lines = history.map(
    (m) => `${m.sender === "user" ? "User" : "Assistant"}: ${String(m.content).slice(0, 1500)}`
  );
  return `Earlier in this conversation:\n${lines.join("\n")}\n\nUser's new message:\n${message}`;
}

/**
 * Pulls the reply text out of an interaction. Current format: `steps` with
 * type "model_output". Also accepts `output_text` and the older `outputs` list.
 */
function extractText(d) {
  if (!d || typeof d !== "object") return "";
  if (typeof d.output_text === "string" && d.output_text.trim()) return d.output_text.trim();
  const parts = [];
  for (const step of Array.isArray(d.steps) ? d.steps : []) {
    if (!step || step.type !== "model_output") continue; // skips "thought", user_input, etc.
    if (typeof step.content === "string") parts.push(step.content);
    else if (Array.isArray(step.content)) {
      for (const block of step.content) if (block && block.type === "text" && block.text) parts.push(block.text);
    }
  }
  if (!parts.length) {
    for (const o of Array.isArray(d.outputs) ? d.outputs : []) if (o && o.type === "text" && o.text) parts.push(o.text);
  }
  return parts.join("\n").trim();
}

// ---- classifying upstream failures ----
// "This key is the problem": rate limit / quota (429), or auth failure (401, 403, invalid key).
const isKeyProblem = (e) =>
  e.status === 429 || e.status === 401 || e.status === 403 ||
  (e.status === 400 && /api key not valid|api_key_invalid/i.test(e.message));
// "The saved session is the problem": expired/unknown interaction ID.
const isStaleInteraction = (e) =>
  e.status === 404 || e.status === 410 || (e.status === 400 && /interaction/i.test(e.message));

const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45000;

/** One HTTP call to Google with the given key. Returns parsed JSON or throws UpstreamError. */
async function callGeminiRaw(key, body, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), // runs outside the queue's wait timer, so it needs its own
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new UpstreamError(timedOut ? "Gemini request timed out" : "Could not reach Gemini", {
      code: timedOut ? "TIMEOUT" : "NETWORK",
    });
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }

  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const retryHeader = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    throw new UpstreamError(message, {
      status: res.status,
      retryAfterMs: Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : null,
    });
  }
  return data;
}

/** Benches a failing key in the key pool so the next getKey() skips it. */
function coolDownKey(keyManager, key, e) {
  if (e.status === 429) {
    // Daily quota won't clear in a minute; a per-minute limit will.
    if (/per day|daily/i.test(e.message)) keyManager.markKeyAsFailed(key);
    else keyManager.markKeyAsRateLimited(key, e.retryAfterMs || 60000);
  } else {
    keyManager.markKeyAsFailed(key); // 401/403/invalid key: long cooldown
  }
}

/** The unified "no key could serve this request" error. */
function allKeysExhausted(failures, retryAfterSeconds) {
  const err = new GeminiServiceError(
    "All Gemini API keys are exhausted or cooling down.",
    "ALL_KEYS_EXHAUSTED",
    429,
    retryAfterSeconds || 60
  );
  err.failures = failures; // the real causes (429 vs 403...) go to the server log, not to the client
  return err;
}

/** Converts a failure that failover/recovery can't fix into an error for errorHandler. */
function toServiceError(e) {
  console.error(`[gemini] failed: ${e.code} ${e.status || ""} ${e.message}`);
  // Timeout, connection refused, or Gemini itself failing (5xx): an upstream problem -> 504.
  if (e.code === "TIMEOUT" || e.code === "NETWORK" || e.status >= 500) {
    return new GeminiServiceError("The AI service did not respond properly.", "GATEWAY_TIMEOUT", 504);
  }
  // Any other rejection (e.g. 400 on our own request) is a bug on our side, not a reason to retry.
  return new GeminiServiceError("Gemini rejected the request.", "INTERNAL_ERROR", 500);
}

/** Builds the service. Dependencies are injectable so it can be tested without network or database. */
function createGeminiService({
  keyManager,
  getHistory = () => [],
  clearInteractionId = () => {},
  fetchImpl = globalThis.fetch,
  model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 45000,
} = {}) {

  // Thin wrappers: the real logic is module-level (above) so geminiHelpers.js can share it.
  const callGemini = (key, body) => callGeminiRaw(key, body, { fetchImpl, timeoutMs });
  const coolDown = (key, e) => coolDownKey(keyManager, key, e);

  /**
   * Sends one user message and returns { reply, interactionId, continued, keyIndex }.
   * The caller saves the messages and interactionId (see db.saveExchange).
   * Throws GeminiServiceError, or KeyPoolError when no keys are configured at all.
   */
  async function sendGeminiMessage({ threadId, topic, message, previousInteractionId = null }) {
    if (typeof message !== "string" || !message.trim()) {
      throw new GeminiServiceError("Message is empty.", "BAD_REQUEST", 400);
    }
    const system = buildSystemInstruction(topic);
    let prevId = previousInteractionId || null;
    let keyRetries = 0;          // failovers used so far (max MAX_KEY_RETRIES)
    let sessionRecovered = false; // the one allowed reset of an expired session
    const failures = [];          // "#keyIndex:status" for each key that failed, for the log

    for (;;) {
      // ---- pick a key ----
      let key;
      try {
        key = keyManager.getKey();
      } catch (e) {
        // Every key is cooling down (maybe because of failures just above): the unified error.
        if (e instanceof KeyPoolError && e.code === "ALL_KEYS_UNAVAILABLE") {
          throw allKeysExhausted(failures, e.retryAfterSeconds);
        }
        throw e; // NO_KEYS_CONFIGURED: a setup problem, reported as a 500
      }

      // Continuing a session: send just the new message. No session: replay our own saved history.
      let history = [];
      if (!prevId) {
        try { history = getHistory(threadId, HISTORY_LIMIT) || []; } catch (e) { /* no history is fine */ }
      }
      const body = { model, input: buildTranscript(history, message), system_instruction: system, store: true };
      if (prevId) body.previous_interaction_id = prevId;

      try {
        const data = await callGemini(key, body);
        const reply = extractText(data);
        if (!reply) throw new GeminiServiceError("The AI returned an empty answer.", "GATEWAY_TIMEOUT", 504);
        return {
          reply,
          interactionId: data.id || data.interaction_id || null, // becomes threads.last_interaction_id
          continued: Boolean(prevId),
          keyIndex: keyManager.getKeyIndex(key),
        };
      } catch (e) {
        if (e instanceof GeminiServiceError) throw e;

        // ---- key failover: bench this key, try the same request with the next one ----
        if (isKeyProblem(e)) {
          failures.push(`#${keyManager.getKeyIndex(key)}:${e.status}`);
          console.warn(`[gemini] key #${keyManager.getKeyIndex(key)} -> HTTP ${e.status}, benched`);
          coolDown(key, e);
          if (keyRetries < MAX_KEY_RETRIES) {
            keyRetries++;
            continue; // loop: getKey() hands out a different key (or throws if none is left)
          }
          throw allKeysExhausted(failures, e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : 60);
        }

        // ---- expired session (410 etc.): forget the stale ID and start a new conversation ----
        if (prevId && isStaleInteraction(e) && !sessionRecovered) {
          console.warn(`[gemini] session ${prevId} expired (HTTP ${e.status}); restarting thread ${threadId}`);
          sessionRecovered = true;
          prevId = null; // the retry sends no previous_interaction_id
          try { clearInteractionId(threadId); } catch (dbErr) { console.error("[gemini] could not clear stale id:", dbErr); }
          continue;
        }

        throw toServiceError(e);
      }
    }
  }

  return { sendGeminiMessage };
}

// Default instance wired to the real key pool and database (db.js is loaded only when needed).
const { keyManager } = require("./keyManager");
const service = createGeminiService({
  keyManager,
  getHistory: (threadId, limit) => require("./db").getMessages(threadId, limit),
  clearInteractionId: (threadId) => require("./db").clearThreadInteractionId(threadId),
});

module.exports = {
  sendGeminiMessage: service.sendGeminiMessage,
  createGeminiService,
  GeminiServiceError,
  extractText,
  buildSystemInstruction,
  // shared with geminiHelpers.js
  UpstreamError,
  callGeminiRaw,
  coolDownKey,
  allKeysExhausted,
  toServiceError,
  isKeyProblem,
  DEFAULT_MODEL,
};
