// concurrencyQueue.js - limits how many Gemini calls run at once, queueing the rest (FIFO).
//
// THE LIFE OF A TASK
//  1. A route calls enqueueTask(fn), where fn is an async function that talks to Gemini.
//  2. If fewer than MAX_CONCURRENT tasks are running, fn starts immediately.
//  3. Otherwise, if fewer than MAX_QUEUE_SIZE tasks are waiting, it joins the back of the
//     queue and a timer starts. Waiting tasks start in arrival order (first in, first out).
//  4. If the queue is also full, the task is rejected right away: 503 SERVER_BUSY.
//  5. If a task waits longer than QUEUE_TIMEOUT_MS, it is removed from the queue and
//     rejected: 504 QUEUE_TIMEOUT. (The timer only covers WAITING. Once fn has started it
//     is never cancelled; give the Gemini fetch its own timeout.)
//  6. When a running task finishes, success or error, its slot is freed and the next
//     waiting task starts.
// Everything runs on Node's single thread, so the counters need no locking.

// Defaults match the spec; override with MAX_CONCURRENT / MAX_QUEUE_SIZE / QUEUE_TIMEOUT_MS in .env.
const numFromEnv = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_CONCURRENT = numFromEnv("MAX_CONCURRENT", 5);
const MAX_QUEUE_SIZE = numFromEnv("MAX_QUEUE_SIZE", 20);
const QUEUE_TIMEOUT_MS = numFromEnv("QUEUE_TIMEOUT_MS", 30000);

/** Rejection reason for tasks that never ran. Carries the HTTP status to send. */
class QueueError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "QueueError";
    this.code = code;     // "SERVER_BUSY" | "QUEUE_TIMEOUT" | "CLIENT_ABORTED"
    this.status = status; // 503 | 504 | 499
  }
}

class ConcurrencyQueue {
  constructor({
    maxConcurrent = MAX_CONCURRENT,
    maxQueueSize = MAX_QUEUE_SIZE,
    queueTimeoutMs = QUEUE_TIMEOUT_MS,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
    this.queueTimeoutMs = queueTimeoutMs;
    this.activeConnections = 0; // tasks running right now
    this.queue = [];            // waiting tasks, oldest first
  }

  /**
   * Runs `asyncTask` when a slot is free. Returns a promise for its result.
   * Rejects with a QueueError if the task is turned away or times out while waiting.
   * Optional `signal` (AbortSignal): if it fires while the task is still queued, the
   * task is dropped, which is how a closed browser tab stops costing a Gemini call.
   */
  enqueueTask(asyncTask, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { task: asyncTask, resolve, reject, timer: null, signal, onAbort: null };

      // Case 1: free slot -> run immediately.
      if (this.activeConnections < this.maxConcurrent) {
        this._run(entry);
        return;
      }

      // Case 2: queue full -> reject immediately (503).
      if (this.queue.length >= this.maxQueueSize) {
        reject(new QueueError(
          "Server busy, too many queued requests. Please try again in a moment.",
          "SERVER_BUSY",
          503
        ));
        return;
      }

      // Case 3: wait in line. A timer removes the task if it waits too long (504).
      entry.timer = setTimeout(() => {
        this._leaveQueue(entry);
        reject(new QueueError(
          "Your request waited too long in the queue. Please try again.",
          "QUEUE_TIMEOUT",
          504
        ));
      }, this.queueTimeoutMs);

      // If the caller gives up while waiting (browser tab closed), drop the task.
      if (signal) {
        entry.onAbort = () => {
          this._leaveQueue(entry);
          reject(new QueueError("Client closed the request.", "CLIENT_ABORTED", 499));
        };
        if (signal.aborted) return entry.onAbort();
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  /** Starts a task and frees its slot when it settles (success OR error). */
  _run(entry) {
    this.activeConnections++;
    let promise;
    try {
      promise = Promise.resolve(entry.task()); // also handles a task that throws synchronously
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise
      .then(entry.resolve, entry.reject) // pass the task's own result or error to the caller
      .finally(() => {
        this.activeConnections--;
        this._startNext(); // a slot just opened: pull from the queue
      });
  }

  /** Starts waiting tasks, oldest first, while there is room. */
  _startNext() {
    while (this.activeConnections < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift(); // FIFO: take from the front
      this._stopWaiting(next);
      this._run(next);
    }
  }

  /** Removes a waiting task from the queue (timeout or abort) and clears its timer/listener. */
  _leaveQueue(entry) {
    const i = this.queue.indexOf(entry);
    if (i !== -1) this.queue.splice(i, 1);
    this._stopWaiting(entry);
  }

  _stopWaiting(entry) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }

  getStats() {
    return {
      active: this.activeConnections,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
    };
  }
}

/**
 * Sends the JSON error for a QueueError. Returns true if it handled the error,
 * false if `err` is something else (so the caller can pass it on with next(err)).
 */
function sendQueueError(res, err) {
  if (!(err instanceof QueueError)) return false;
  if (res.headersSent || res.writableEnded) return true; // client already gone
  if (err.status === 503) res.set("Retry-After", "5"); // a hint the frontend can show
  res.status(err.status).json({ error: err.message, code: err.code });
  return true;
}

// Shared queue for the whole server.
const queue = new ConcurrencyQueue();
const enqueueTask = (asyncTask, options) => queue.enqueueTask(asyncTask, options);
const getQueueStats = () => queue.getStats();

module.exports = { enqueueTask, getQueueStats, sendQueueError, ConcurrencyQueue, QueueError, queue };
