// errorHandler.js - ONE place that turns internal errors into HTTP responses.
//
// HOW IT WORKS
//  * Everything in the pipeline (rate limiter, queue, key pool, Gemini service, body parser)
//    reports problems by passing an error to next(err). Each error carries a short internal
//    `code`. This middleware, mounted LAST in server.js, picks the response from that code.
//  * Internal codes are never shown to users. Clients get one of the public codes in RESPONSES
//    below, with fixed wording. second-brain_3.html reads the status (and, for 429, the
//    code/message) to choose what to show:
//
//      Internal code (where it comes from)                 -> HTTP  public code           frontend shows
//      RATE_LIMITED       (rateLimiter: 15 req/min bucket)    429   USER_RATE_LIMIT       "Too many requests..." + wait time
//      ALL_KEYS_EXHAUSTED (geminiService: every key failed    429   API_QUOTA_EXHAUSTED   "Daily query limit reached..."
//      ALL_KEYS_UNAVAILABLE  or is cooling down)
//      SERVER_BUSY        (concurrencyQueue: line is full)    503   SERVER_BUSY           "Server busy, please wait..."
//      QUEUE_TIMEOUT      (waited too long in the queue)      504   GATEWAY_TIMEOUT       "The server hit a problem..."
//      GATEWAY_TIMEOUT    (Gemini timeout / refused / 5xx)    504   GATEWAY_TIMEOUT       "The server hit a problem..."
//      INVALID_AI_OUTPUT  (Gemini's answer wasn't usable JSON) 422   UNPROCESSABLE_AI_OUTPUT "The AI returned an answer we couldn't read..."
//      entity.parse.failed (malformed JSON body)              400   BAD_REQUEST
//      entity.too.large   (body over the size limit)          413   PAYLOAD_TOO_LARGE
//      CLIENT_ABORTED     (browser closed while queued)       (nothing is sent; nobody is listening)
//      SQLite errors      (locked database, bad query...)     500   INTERNAL_ERROR        "The server hit a problem..."
//      anything else      (a bug, NO_KEYS_CONFIGURED, ...)    500   INTERNAL_ERROR        "The server hit a problem..."
//
//  * Both 429s also carry "retry": true, meaning "the same request may succeed if repeated shortly".
//  * Stack traces and error messages are NEVER sent to clients unless NODE_ENV=development.
//  * Retry-After is sent for the user rate limit (exact seconds until a token refills) and for
//    503 busy. It is deliberately NOT sent for API_QUOTA_EXHAUSTED: the frontend would append
//    "try again in 60s" to a message that says "daily limit".

// Public responses. Wording is fixed here so clients never see internal details.
const RESPONSES = {
  USER_RATE_LIMIT:     { status: 429, error: "Too many requests. Please wait a moment.", retry: true },
  // Reached only after the key pool already tried to rotate to another key and none could serve the request.
  API_QUOTA_EXHAUSTED: { status: 429, error: "Rate limit reached. Rotating keys...", retry: true },
  SERVER_BUSY:         { status: 503, error: "Server busy, please wait a moment..." },
  GATEWAY_TIMEOUT:     { status: 504, error: "The server hit a problem. Please try again." },
  // Structured endpoints (mind map, slides): Gemini answered, but not with JSON we can use. Repeating may work.
  UNPROCESSABLE_AI_OUTPUT: { status: 422, error: "The AI returned an answer we couldn't read. Please try again.", retry: true },
  INTERNAL_ERROR:      { status: 500, error: "Internal server error" },
  BAD_REQUEST:         { status: 400, error: "Invalid request body." },
  PAYLOAD_TOO_LARGE:   { status: 413, error: "Request is too large." },
};

// Internal error code -> public code.
const CODE_MAP = {
  RATE_LIMITED: "USER_RATE_LIMIT",
  ALL_KEYS_EXHAUSTED: "API_QUOTA_EXHAUSTED",
  ALL_KEYS_UNAVAILABLE: "API_QUOTA_EXHAUSTED", // KeyPoolError from the key manager itself
  SERVER_BUSY: "SERVER_BUSY",
  QUEUE_TIMEOUT: "GATEWAY_TIMEOUT",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  INVALID_AI_OUTPUT: "UNPROCESSABLE_AI_OUTPUT",
};

// Only an explicit NODE_ENV=development shows details. Unset or "production" shows nothing,
// so forgetting to set NODE_ENV can't leak internals.
const isDev = () => process.env.NODE_ENV === "development";

/** better-sqlite3 throws SqliteError with codes like SQLITE_BUSY (locked) or SQLITE_CONSTRAINT_*. */
const isSqliteError = (err) =>
  Boolean(err) && (err.name === "SqliteError" || (typeof err.code === "string" && err.code.startsWith("SQLITE_")));

/** Returns the public code (a key of RESPONSES) for an error. */
function classify(err) {
  if (err && CODE_MAP[err.code]) return CODE_MAP[err.code];
  // Errors thrown by express.json(): without this, a typo in the JSON body would be a 500.
  if (err && err.type === "entity.parse.failed") return "BAD_REQUEST";
  if (err && err.type === "entity.too.large") return "PAYLOAD_TOO_LARGE";
  return "INTERNAL_ERROR"; // unknown = a bug: log it, but don't leak details
}

// Express recognises error middleware by its 4 parameters. Keep all four, even if `next` is rarely used.
function errorHandler(err, req, res, next) {
  // Part of a response was already sent: we can't change the status. Let Express close the connection.
  if (res.headersSent) return next(err);

  // The browser went away while the request was queued: nothing to tell anyone.
  if (err && err.code === "CLIENT_ABORTED") return res.status(499).end();

  const publicCode = classify(err);
  const { status, error, retry } = RESPONSES[publicCode];

  if (publicCode === "USER_RATE_LIMIT" && err.retryAfterSeconds) {
    res.set("Retry-After", String(err.retryAfterSeconds)); // exact wait until the next token
  } else if (publicCode === "SERVER_BUSY") {
    res.set("Retry-After", String(err.retryAfterSeconds || 5));
  }

  // Logging: bugs get a full stack trace (server log only); expected conditions get one short line.
  if (publicCode === "INTERNAL_ERROR") {
    const tag = isSqliteError(err) ? "[error][database]" : "[error]";
    console.error(`${tag} ${req.method} ${req.originalUrl} ->`, (err && err.stack) || err);
  } else {
    const detail = err && err.failures ? ` [${err.failures.join(", ")}]` : "";
    console.warn(`[error] ${status} ${publicCode} (${(err && err.code) || (err && err.type)})${detail}`);
  }

  const body = { error, code: publicCode };
  if (retry) body.retry = true;
  // Local debugging only: the message and stack of a 500. Never sent in production.
  if (publicCode === "INTERNAL_ERROR" && isDev() && err) {
    body.detail = err.message;
    body.stack = err.stack;
  }
  res.status(status).json(body);
}

module.exports = { errorHandler, classify, isSqliteError, RESPONSES };
