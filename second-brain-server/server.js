// server.js - Express server boilerplate for the Second Brain AI proxy.

require("dotenv").config(); // load variables from .env into process.env
const path = require("path");
const express = require("express");
const cors = require("cors");
const database = require("./db"); // importing this opens chats.db and creates the tables
const { keyManager } = require("./keyManager"); // round-robin Gemini key pool
const { rateLimiter } = require("./rateLimiter"); // token bucket: 15 requests/minute per client
const { enqueueTask, getQueueStats } = require("./concurrencyQueue"); // max 5 Gemini calls at once
const { sendGeminiMessage } = require("./geminiService"); // Gemini call + session continuation
const { createChatHandler } = require("./chatRoute"); // POST /api/chat pipeline
const { createThreadsHandlers } = require("./threadsRoute"); // GET /api/threads, GET /api/threads/:id
const { createGenerateHandlers } = require("./generateRoute"); // POST /api/mindmap, POST /api/slides
const { callGeminiWithRetry, safeJSONParse } = require("./geminiHelpers"); // one-shot Gemini call + tolerant JSON parsing
const { errorHandler } = require("./errorHandler"); // maps every error to a JSON response (mounted last)
const { parseAllowedOrigins, parseTrustProxy } = require("./config"); // env -> CORS / proxy settings

const app = express();
// Hosts like Render set PORT themselves; locally it comes from .env, else 5000.
const PORT = process.env.PORT || 5000;

// Behind a proxy (Render, Nginx...) req.ip would be the proxy's address unless Express is told how many
// proxy hops to trust. See config.js: default is 1 hop in production. It must NOT be plain `true`.
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV));

// CORS: which websites may call this API from a browser. ALLOWED_ORIGIN=* allows any; in production
// set it to your frontend's origin(s). A frontend served by this same server (./public) needs no CORS.
const allowedOrigin = parseAllowedOrigins(process.env.ALLOWED_ORIGIN);
app.use(cors({
  origin: allowedOrigin,
  // Browsers hide most response headers from other origins unless they're listed here;
  // the frontend reads Retry-After to show "try again in 4s".
  exposedHeaders: ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
}));
app.use(express.json({ limit: "1mb" })); // parse JSON request bodies

// Serves the frontend from ./public (second-brain_3.html is saved there as index.html), so the page
// and "/api/chat" share one origin: nothing extra to host and no CORS needed.
app.use(express.static(path.join(__dirname, "public")));

/**
 * Identifies the caller. For now this is just the IP address.
 * Replace later with a real user ID (login, signed cookie, etc.).
 */
function getUserId(req) {
  return req.ip || "unknown";
}

// Health check: used by you, hosting platforms and uptime monitors.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// TEMPORARY test route for the key pool. Remove once /api/chat is built.
//   GET /api/test-key               -> next key in rotation: {"status":"ok","keyIndex":N} (0-based)
//   GET /api/test-key?simulate429=1 -> also puts that key on a 60s cooldown, to watch rotation skip it
app.get("/api/test-key", (req, res, next) => {
  try {
    const key = keyManager.getKey();
    const keyIndex = keyManager.getKeyIndex(key);
    if (req.query.simulate429) keyManager.markKeyAsRateLimited(key); // default 60s
    console.log(
      `[test-key] using key #${keyIndex} (${keyManager.getActiveKeyCount()}/${keyManager.getKeyCount()} active)`
    );
    res.json({ status: "ok", keyIndex });
  } catch (err) {
    next(err); // e.g. every key cooling down -> errorHandler answers 429 API_QUOTA_EXHAUSTED
  }
});

// Rate limit /api/chat. Mounted BEFORE the route itself, so a blocked request is rejected
// with 429 before any database work or Gemini call happens. (Don't also add rateLimiter to
// the route below, or each request would spend two tokens.)
app.use("/api/chat", rateLimiter);

// TEMPORARY test route for the rate limiter. Remove once /api/chat is built.
// It spends a token from the SAME bucket as /api/chat. Reload it quickly in the browser or
// Postman: "remaining" counts down from 14, request 16 returns 429 with a Retry-After
// header, and one token comes back every 4 seconds.
app.get("/api/test-limit", rateLimiter, (req, res) => {
  const { remaining, limit } = res.locals.rateLimit;
  // ip = the address the server thinks you have. After deploying, open this from two different networks
  // (Wi-Fi and mobile data): the IPs must differ. If they match, req.ip is the host's proxy, so raise
  // TRUST_PROXY by one. If they look wrong in other ways, see config.js.
  res.json({ status: "ok", remaining, limit, ip: req.ip });
});

// TEMPORARY test route for the concurrency queue. Remove once /api/chat is built.
// Each request pretends to be a 3-second Gemini call. Fire many at once (browser tabs, or e.g.
// `npx autocannon -c 30 -a 30 http://localhost:3000/api/test-queue`):
//   requests 1-5   start now        (~3s)
//   requests 6-25  wait in the queue (~6s, 9s, 12s, 15s: five finish every 3s, oldest first)
//   requests 26+   get 503 SERVER_BUSY instantly
// Add ?delay=20000 (ms, max 60000) to make tasks slow enough that queued ones hit the 30s
// queue timeout and return 504. This route is not rate limited, so a stress test can reach it.
app.get("/api/test-queue", async (req, res, next) => {
  const arrived = Date.now();
  const delay = Math.min(Number(req.query.delay) || 3000, 60000);

  // If the browser tab closes while this request is still waiting, drop it from the queue.
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  try {
    const startedAt = await enqueueTask(async () => {
      const started = Date.now(); // the moment this task got a slot
      await new Promise((resolve) => setTimeout(resolve, delay)); // mock Gemini call
      return started;
    }, { signal: abort.signal });

    res.json({
      status: "ok",
      waitedMs: startedAt - arrived,       // time spent in the queue
      totalMs: Date.now() - arrived,
      queue: getQueueStats(),              // snapshot right now
    });
  } catch (err) {
    next(err); // queue full -> 503 SERVER_BUSY, waited too long -> 504 (see errorHandler.js)
  }
});

// The chat endpoint. Pipeline (see chatRoute.js): rate limit (above) -> validate -> thread lookup
// -> concurrency queue -> key pool + Gemini (previous_interaction_id) -> save to SQLite.
//   POST /api/chat  { "thread_id"?: "...", "topic"?: "...", "message": "..." }
//   -> { "thread_id", "topic", "reply", "previous_interaction_id", "continued" }
const chatHandler = createChatHandler({ database, enqueueTask, sendGeminiMessage, getUserId });
app.post("/api/chat", chatHandler);

// Thread list + history for the UI's thread picker (see threadsRoute.js). By default each caller
// only sees their own threads, matching the ownership check in POST /api/chat. Set
// ALLOW_ALL_THREADS=true in .env ONLY for local single-user use, to list every stored thread.
const threads = createThreadsHandlers({
  database,
  getUserId,
  allowAll: process.env.ALLOW_ALL_THREADS === "true",
});
app.get("/api/threads", threads.listThreads);      // -> { status, threads: [...] }, newest activity first
app.get("/api/threads/:id", threads.getThread);    // -> { status, thread, messages: [...] } or 404

// What the frontend's "New chat" button and chat form call (see second-brain_3.html):
app.post("/api/threads", rateLimiter, threads.createThread); // { title? } -> 201 { status, thread }
// Same pipeline as POST /api/chat, with the thread ID taken from the URL instead of the body.
app.post("/api/threads/:id/chat", rateLimiter, (req, res, next) => {
  req.body = { ...(req.body || {}), thread_id: req.params.id };
  chatHandler(req, res, next);
});

// Structured-output endpoints: Gemini must return JSON, which is parsed and checked (422 if unusable).
// They share the rate-limit bucket and the concurrency queue with /api/chat.
const generate = createGenerateHandlers({ enqueueTask, callGeminiWithRetry, safeJSONParse, keyPool: keyManager });
app.post("/api/mindmap", rateLimiter, generate.mindMap); // { topic?, notes? }          -> { status, mindmap }
app.post("/api/slides", rateLimiter, generate.slides);   // { topic?, notes?, slides? } -> { status, deck }

// Fallback for unknown API routes: JSON instead of an HTML error page.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler. MUST stay the last app.use(): Express only sends errors to handlers
// registered after the route that failed. Every next(err) in the app ends up here and becomes
// a JSON response: 429 USER_RATE_LIMIT / API_QUOTA_EXHAUSTED, 503 SERVER_BUSY,
// 504 GATEWAY_TIMEOUT, 500 INTERNAL_ERROR (see the table in errorHandler.js).
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || "not set"})`);
  console.log(`CORS: ${allowedOrigin === "*" ? "any origin (*)" : allowedOrigin.join(", ") || "no cross-origin sites"}`);
  const total = keyManager.getKeyCount();
  if (total === 0) console.warn("WARNING: no Gemini API keys found. Set GEMINI_API_KEYS in .env.");
  else console.log(`Loaded ${total} Gemini API key${total === 1 ? "" : "s"}.`);
});

// Last line of defence so a stray bug can't take the whole server down.
// A promise that nobody caught would kill the process on modern Node. Log it and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
// Same for an exception thrown outside any request (e.g. in a timer). Node recommends restarting
// after one, because state may be half-updated. Run the server under pm2/systemd/Docker
// restart policies as well, so a truly broken process is replaced.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Close the HTTP server and the database cleanly on Ctrl+C or a platform stop signal.
function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { app, getUserId };
