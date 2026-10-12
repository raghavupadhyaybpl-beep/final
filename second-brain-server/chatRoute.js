// chatRoute.js - the POST /api/chat handler. It ties together Tasks 1-5.
//
// REQUEST PIPELINE (in order)
//   1. rateLimiter     mounted in server.js with app.use("/api/chat", ...), so it runs first
//                      and rejects with 429 before anything below happens.
//   2. validation      bad input is rejected with 400 before it can take a queue slot.
//   3. thread lookup   SQLite: find or create the thread (403 if it belongs to someone else).
//   4. thread guard    one message at a time per thread (409), so two requests can't fork
//                      the Gemini conversation.
//   5. concurrencyQueue  max 5 Gemini calls at once, the rest wait (503 if the line is full,
//                      504 if they wait too long).
//   6. geminiService   picks a key from the pool, calls Gemini with ONLY the new message plus
//                      the thread's last_interaction_id, and retries once on a 429.
//   7. SQLite          saves the user message, the reply and the new last_interaction_id.
// Failures at any step are passed to next(err) and answered by errorHandler.js.

const crypto = require("crypto");

const MAX_MESSAGE_CHARS = 4000;
const MAX_TOPIC_CHARS = 80;
const THREAD_ID_RE = /^[\w.-]{1,64}$/; // the frontend's ids ("t...") and UUIDs both fit

const badRequest = (res, error) => res.status(400).json({ error, code: "BAD_REQUEST" });

/** Builds the handler. Dependencies are passed in so it can be tested without a database or network. */
function createChatHandler({ database, enqueueTask, sendGeminiMessage, getUserId }) {
  const inFlight = new Set(); // thread IDs with a request currently being processed

  return async function chatHandler(req, res, next) {
    let lockedThread = null;
    try {
      // ---- 2. validate the body: { thread_id?, topic?, message } ----
      const body = req.body || {};

      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return badRequest(res, "Please send a 'message'.");
      if (message.length > MAX_MESSAGE_CHARS) {
        return badRequest(res, `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`);
      }

      let threadId;
      if (body.thread_id === undefined || body.thread_id === null || body.thread_id === "") {
        threadId = crypto.randomUUID(); // omitted -> start a new thread
      } else if (typeof body.thread_id === "string" && THREAD_ID_RE.test(body.thread_id)) {
        threadId = body.thread_id;
      } else {
        return badRequest(res, "Invalid 'thread_id'.");
      }

      // A topic is optional. Only an explicit one may rename an existing thread.
      const topic = typeof body.topic === "string"
        ? body.topic.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TOPIC_CHARS) || null
        : null;
      // NOTE: a "previous_interaction_id" sent by the client is ignored on purpose. The saved
      // threads.last_interaction_id is the source of truth, so a client can't point us at
      // someone else's Gemini conversation.

      // ---- 3. find or create the thread (null = owned by another user) ----
      const userId = getUserId(req);
      let thread = database.getOrCreateThread(threadId, userId, topic);
      if (!thread) return res.status(403).json({ error: "This thread belongs to someone else.", code: "FORBIDDEN" });
      if (!thread.title) thread = database.getOrCreateThread(threadId, userId, "General"); // default topic

      // ---- 4. one message at a time per thread ----
      // Two parallel requests would both read the same last_interaction_id and split the
      // conversation into two chains. The check and the add below have no await between them.
      if (inFlight.has(threadId)) {
        return res.status(409).json({
          error: "Still answering your previous message in this thread. Please wait a moment.",
          code: "THREAD_BUSY",
        });
      }
      inFlight.add(threadId);
      lockedThread = threadId;

      // If the browser tab closes while we're still waiting in the queue, drop the request.
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });

      // ---- 5 + 6. wait for a free slot, then call Gemini ----
      const result = await enqueueTask(
        () => sendGeminiMessage({
          threadId,
          topic: thread.title,
          message,
          previousInteractionId: thread.last_interaction_id, // null on a new thread
        }),
        { signal: abort.signal }
      );

      // ---- 7. save the turn and the new interaction ID together ----
      try {
        database.saveExchange(threadId, message, result.reply, result.interactionId);
      } catch (dbErr) {
        // The user already has their answer, so still return it. Only the saved copy is missing.
        console.error("[chat] could not save exchange for thread " + threadId, dbErr);
      }

      res.json({
        thread_id: threadId,
        topic: thread.title,
        reply: result.reply,
        previous_interaction_id: result.interactionId, // the frontend stores this on the thread
        continued: result.continued,                   // true = Gemini continued its own saved session
      });
    } catch (err) {
      // Queue overload, exhausted keys, Gemini timeouts, bugs... all go to errorHandler.js, which
      // picks the status code and message. Nothing is saved for a failed turn, so a retry is clean.
      next(err);
    } finally {
      if (lockedThread) inFlight.delete(lockedThread); // always release, success or failure
    }
  };
}

module.exports = { createChatHandler };
