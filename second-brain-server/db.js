// db.js - SQLite setup and helper functions (better-sqlite3).
// better-sqlite3 is synchronous, which is fine for SQLite and keeps the code simple.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// WHERE THE DATABASE LIVES
//   Local development: leave DB_PATH unset and it is ./chats.db next to this file.
//   Production: set DB_PATH to a file on a PERSISTENT DISK, e.g. DB_PATH=/var/data/chats.db on Render.
//   Everything outside a persistent disk is erased on redeploy/restart on most hosts, chats.db included.
// An absolute DB_PATH is used as is; a relative one is resolved from this file's folder.
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || "./chats.db");
const isProduction = process.env.NODE_ENV === "production";
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  // In production a missing folder usually means the disk isn't mounted. Creating it would silently
  // put the database on the temporary filesystem and lose the chats later, so stop with a clear error.
  if (isProduction) {
    throw new Error(`Database folder "${dbDir}" does not exist. Is the persistent disk mounted there? (DB_PATH=${DB_PATH})`);
  }
  fs.mkdirSync(dbDir, { recursive: true });
}
try {
  fs.accessSync(dbDir, fs.constants.W_OK);
} catch (e) {
  throw new Error(`Database folder "${dbDir}" is not writable. Check DB_PATH and the disk mount.`);
}
if (isProduction && !process.env.DB_PATH) {
  console.warn("[db] DB_PATH is not set: chats.db will be erased whenever the host restarts or redeploys. Use a persistent disk for real data.");
}

const db = new Database(DB_PATH);
console.log(`[db] using ${DB_PATH}`);

// WAL mode allows reads while a write is happening (better for a web server).
db.pragma("journal_mode = WAL");
// SQLite does NOT enforce foreign keys unless this is turned on for each connection.
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema (safe to run on every start: IF NOT EXISTS)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id                  TEXT PRIMARY KEY,                 -- thread UUID/ID (sent by the frontend)
    user_id             TEXT,                             -- user identifier or IP
    title               TEXT,                             -- topic, e.g. "Chocolate Factory"
    last_interaction_id TEXT,                             -- Gemini interaction ID for server-side continuation
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT NOT NULL,
    sender     TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Deleting a thread also deletes its messages.
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );

  -- Fast lookups: "all messages in a thread" and "all threads for a user".
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_threads_user    ON threads (user_id, updated_at);
`);

// ---------------------------------------------------------------------------
// Helpers (prepared once, reused on every call)
// ---------------------------------------------------------------------------
const stmts = {
  getThread: db.prepare("SELECT * FROM threads WHERE id = ?"),
  insertThread: db.prepare(
    "INSERT INTO threads (id, user_id, title) VALUES (?, ?, ?)"
  ),
  updateTitle: db.prepare(
    "UPDATE threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ),
  clearInteraction: db.prepare(
    "UPDATE threads SET last_interaction_id = NULL WHERE id = ?"
  ),
  setInteraction: db.prepare(
    "UPDATE threads SET last_interaction_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ),
  touchThread: db.prepare(
    "UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ),
  listThreads: db.prepare(
    "SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC"
  ),
  deleteThread: db.prepare("DELETE FROM threads WHERE id = ? AND user_id = ?"),
  insertMessage: db.prepare(
    "INSERT INTO messages (thread_id, sender, content) VALUES (?, ?, ?)"
  ),
  // Newest N messages, returned oldest-first below.
  recentMessages: db.prepare(
    "SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
  ),

  // ---- read queries for GET /api/threads and GET /api/threads/:id ----
  // Thread list, newest activity first. `rowid DESC` breaks ties (timestamps only have 1-second
  // resolution). The per-user query is served by idx_threads_user (user_id, updated_at).
  allThreads: db.prepare(
    "SELECT id, title, last_interaction_id, created_at, updated_at FROM threads ORDER BY updated_at DESC, rowid DESC LIMIT ?"
  ),
  threadsByUser: db.prepare(
    "SELECT id, title, last_interaction_id, created_at, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?"
  ),
  // user_id is selected only so the owner can be checked. It is never sent to the client.
  threadMeta: db.prepare(
    "SELECT id, user_id, title, last_interaction_id, created_at, updated_at FROM threads WHERE id = ?"
  ),
  // Oldest first. Ordering by id is chronological (ids only grow) and, unlike created_at,
  // never ties: a user message and its reply are saved in the same second.
  // idx_messages_thread (thread_id, id) returns these already in order, with no sorting.
  threadMessages: db.prepare(
    "SELECT id, sender, content, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC"
  ),
};

// SQLite stores CURRENT_TIMESTAMP as UTC text like "2026-10-04 12:30:00". Return it as ISO 8601
// ("2026-10-04T12:30:00Z") so the frontend can do new Date(value) without guessing the timezone.
const toIso = (ts) =>
  typeof ts === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ts) ? ts.replace(" ", "T") + "Z" : ts;
const publicThread = (r) => ({
  id: r.id,
  title: r.title,
  last_interaction_id: r.last_interaction_id,
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
});

/**
 * Returns the thread row, creating it first if it doesn't exist (userId/title are only
 * used when creating). No ownership check here; routes should use getOrCreateThread.
 */
function getThread(id, { userId = null, title = null } = {}) {
  const existing = stmts.getThread.get(id);
  if (existing) return existing;
  stmts.insertThread.run(id, userId, title);
  return stmts.getThread.get(id);
}

/**
 * Finds a thread by ID or creates it. If it exists but belongs to a different
 * user, returns null so one user can't read another user's thread.
 */
function getOrCreateThread(id, userId, title) {
  const existing = stmts.getThread.get(id);
  if (existing) {
    if (existing.user_id !== userId) return null;
    // Keep the title in sync if the user renamed the thread on the frontend.
    if (title && title !== existing.title) {
      stmts.updateTitle.run(title, id);
      existing.title = title;
    }
    return existing;
  }
  stmts.insertThread.run(id, userId, title || null);
  return stmts.getThread.get(id);
}

/**
 * Stores Gemini's interaction ID in threads.last_interaction_id (and bumps updated_at).
 * Next turn we send only the new message plus this ID, and Gemini continues the chat
 * from its own saved copy, so we never re-send the history. Each reply returns a new ID
 * that replaces the old one.
 */
function updateThreadInteractionId(threadId, interactionId) {
  stmts.setInteraction.run(interactionId, threadId);
}

/**
 * Forgets the thread's Gemini session (sets last_interaction_id to NULL). Used when Gemini says
 * the saved session expired, so the next message starts a fresh one. It does NOT bump updated_at:
 * cleaning up a dead ID isn't user activity, and the thread shouldn't jump to the top of the list.
 */
function clearThreadInteractionId(threadId) {
  stmts.clearInteraction.run(threadId);
}

/** Inserts one message ('user' or 'assistant') and bumps the thread's updated_at. */
const saveMessage = db.transaction((threadId, sender, content) => {
  const info = stmts.insertMessage.run(threadId, sender, content);
  stmts.touchThread.run(threadId);
  return info.lastInsertRowid;
});

/**
 * Saves a finished turn in ONE transaction: the user's message, the assistant's reply and
 * the new interaction ID. All three are stored, or none, so the saved chat and the ID that
 * points to Gemini's copy can never disagree.
 */
const saveExchange = db.transaction((threadId, userText, assistantText, interactionId) => {
  saveMessage(threadId, "user", userText);
  saveMessage(threadId, "assistant", assistantText);
  if (interactionId) updateThreadInteractionId(threadId, interactionId);
});

/** Returns the last `limit` messages of a thread, oldest first. */
function getMessages(threadId, limit = 100) {
  return stmts.recentMessages.all(threadId, limit);
}

/**
 * Thread list for the UI's thread picker, most recently active first.
 * Every message saved through saveExchange bumps threads.updated_at, so the chat you
 * talked to last floats to the top. Pass { userId } to get one user's threads; leave it out
 * to get every thread. { limit } caps the rows (default 200).
 */
function getAllThreads({ userId, limit = 200 } = {}) {
  const rows = userId === undefined
    ? stmts.allThreads.all(limit)
    : stmts.threadsByUser.all(userId, limit);
  return rows.map(publicThread);
}

/**
 * One thread plus its full message history, oldest first. This is what the UI loads when
 * the user taps a thread: it redraws the whole conversation from SQLite. Each thread has its
 * own rows (messages.thread_id), so topics never mix.
 * Returns null if the thread doesn't exist, or, when { userId } is given, belongs to
 * someone else (callers treat both as "not found" so thread IDs can't be probed).
 */
function getThreadWithMessages(threadId, { userId } = {}) {
  const meta = stmts.threadMeta.get(threadId);
  if (!meta) return null;
  if (userId !== undefined && meta.user_id !== userId) return null;
  const messages = stmts.threadMessages.all(threadId).map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    created_at: toIso(m.created_at),
  }));
  return { thread: publicThread(meta), messages };
}

/** Lists a user's threads, most recently active first. */
function listThreads(userId) {
  return stmts.listThreads.all(userId);
}

/** Deletes a thread (and its messages) if it belongs to the user. Returns true if deleted. */
function deleteThread(id, userId) {
  return stmts.deleteThread.run(id, userId).changes > 0;
}

/** Closes the database cleanly (used on shutdown). */
function close() {
  db.close();
}

module.exports = {
  db,
  getThread,
  getOrCreateThread,
  updateThreadInteractionId,
  clearThreadInteractionId,
  setLastInteractionId: updateThreadInteractionId, // old name, kept so existing code keeps working
  saveMessage,
  addMessage: saveMessage,                         // old name, kept so existing code keeps working
  saveExchange,
  getMessages,
  getAllThreads,
  getThreadWithMessages,
  listThreads,
  deleteThread,
  close,
};
