// threadsRoute.js - read-only endpoints that power the thread picker in the UI.
//
// HOW CHAT PERSISTENCE POWERS MULTI-THREAD SELECTION
//  * POST /api/chat saves every turn in SQLite: the thread row (title, last_interaction_id,
//    updated_at) and its messages. Nothing about a conversation lives only in the browser.
//  * GET /api/threads  -> the thread picker: one row per topic ("Chocolate Factory",
//    "Water Bottle Factory"), the most recently used first.
//  * GET /api/threads/:id -> opening a thread: its whole history, so the UI can redraw the
//    conversation. It works on a new phone or after clearing the browser, because the server
//    holds the history. Sending a message afterwards continues the same Gemini session via
//    the saved last_interaction_id.

const crypto = require("crypto");

const THREAD_ID_RE = /^[\w.-]{1,64}$/; // same rule POST /api/chat uses for thread_id

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * @param {object}   deps
 * @param {object}   deps.database   db.js
 * @param {Function} deps.getUserId  req -> id of the caller (the same function POST /api/chat uses)
 * @param {boolean}  deps.allowAll   true = skip the per-user scoping (local, single-user use only)
 */
function createThreadsHandlers({ database, getUserId, allowAll = false }) {
  /** GET /api/threads  (optional ?limit=N, default 200, max 500) */
  function listThreads(req, res, next) {
    try {
      const n = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIMIT) : DEFAULT_LIMIT;

      // Default: only the caller's own threads. A ?user_id= sent by the client is ignored, because
      // otherwise anyone could list another user's chats by typing their ID. Only in allowAll
      // mode is ?user_id=xyz honoured as a filter, and without it every thread is returned.
      const options = allowAll
        ? (typeof req.query.user_id === "string" && req.query.user_id ? { userId: req.query.user_id, limit } : { limit })
        : { userId: getUserId(req), limit };

      const threads = database.getAllThreads(options);
      console.log(`[threads] list -> ${threads.length} thread(s)`);
      res.set("Cache-Control", "no-store"); // private data: don't let browsers/proxies cache it
      res.json({ status: "success", threads });
    } catch (err) {
      console.error("[threads] list failed:", err);
      next(err); // -> the JSON 500 handler in server.js
    }
  }

  /**
   * POST /api/threads  { title? }  ->  201 { status, thread }
   * Creates an empty thread owned by the caller and returns its server-made ID. The UI's "New chat"
   * button calls this, then sends messages to POST /api/threads/:id/chat.
   */
  function createThread(req, res, next) {
    try {
      const raw = req.body && req.body.title;
      if (raw !== undefined && typeof raw !== "string") {
        return res.status(400).json({ error: "'title' must be text.", code: "BAD_REQUEST" });
      }
      const title = (typeof raw === "string" ? raw.replace(/[\r\n]+/g, " ").trim().slice(0, 80) : "") || "New chat";
      const id = crypto.randomUUID();
      const userId = getUserId(req);
      database.getOrCreateThread(id, userId, title);
      const data = database.getThreadWithMessages(id, { userId });
      console.log(`[threads] created ${id}`);
      res.set("Cache-Control", "no-store");
      res.status(201).json({ status: "success", thread: data.thread });
    } catch (err) {
      console.error("[threads] create failed:", err);
      next(err);
    }
  }

  /** GET /api/threads/:id */
  function getThread(req, res, next) {
    try {
      const id = req.params.id;
      // Someone else's thread, a missing thread and a malformed ID all answer the same 404,
      // so the response never reveals whether a thread ID exists.
      const data = THREAD_ID_RE.test(id)
        ? database.getThreadWithMessages(id, allowAll ? {} : { userId: getUserId(req) })
        : null;
      if (!data) {
        console.log(`[threads] ${id.slice(0, 64)} -> not found`);
        return res.status(404).json({ error: "Thread not found", code: "NOT_FOUND" });
      }
      console.log(`[threads] ${id} -> ${data.messages.length} message(s)`);
      res.set("Cache-Control", "no-store");
      res.json({ status: "success", thread: data.thread, messages: data.messages });
    } catch (err) {
      console.error("[threads] detail failed:", err);
      next(err);
    }
  }

  return { listThreads, getThread, createThread };
}

module.exports = { createThreadsHandlers };
