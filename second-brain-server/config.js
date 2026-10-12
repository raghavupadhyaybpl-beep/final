// config.js - turns environment variables into the settings server.js needs.
// Kept separate (and free of side effects) so the parsing rules are easy to read and test.

/**
 * ALLOWED_ORIGIN -> the `origin` option of the cors package.
 *   "*" (or unset)                     any website may call the API from a browser
 *   "https://a.com,https://b.com"      only these exact origins (scheme + host [+ port], no path)
 * A trailing slash is removed, because browsers send origins without one and "https://a.com/"
 * would never match. CORS only controls which web pages a BROWSER lets read the responses.
 * It is not a login: curl, scripts and other servers ignore it.
 */
function parseAllowedOrigins(value) {
  const list = String(value || "*")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.includes("*") ? "*" : list; // an empty list means "no cross-origin site is allowed"
}

/**
 * TRUST_PROXY -> Express's "trust proxy" setting, which decides what req.ip is.
 *   unset in production  1      trust exactly one proxy hop (a PaaS like Render sits in front of the app)
 *   unset elsewhere      false  no proxy: req.ip is the socket address
 *   "1", "2", ...        that many hops
 *   "true"               trust everything. Don't: the client can forge X-Forwarded-For and so
 *                        pick its own IP, which defeats the rate limiter and thread ownership.
 * req.ip identifies callers (rate limiting, thread ownership), so this matters for security.
 */
function parseTrustProxy(value, nodeEnv) {
  if (value === undefined || value === "") return nodeEnv === "production" ? 1 : false;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback" or a subnet, passed to Express as is
}

module.exports = { parseAllowedOrigins, parseTrustProxy };
