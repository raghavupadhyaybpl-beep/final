# Deploying the Second Brain server on Render

## Read this first: the free plan loses your chats
Render's **free** web service cannot attach a persistent disk. Its filesystem, including `chats.db`,
is erased on every redeploy, restart and idle spin-down (free services sleep after 15 minutes
without traffic and take up to a minute to wake). Your chats stay in the browser's own storage, but
the server forgets them: Gemini's saved session IDs are gone too, so each thread starts a fresh
conversation after a restart.

| Plan | Cost | `chats.db` survives restarts? | Sleeps when idle? |
|---|---|---|---|
| Free | $0 | **No** | Yes (15 min) |
| Starter + 1 GB disk | about $7/month + $0.25/GB/month | Yes | No |

Prices come from Render's pricing pages and can change. Check them before you pay.

## 1. Put the project on GitHub
Push the `second-brain-server` folder (not its parent) to a new GitHub repository.
`.gitignore` already keeps `.env`, `node_modules` and `chats.db` out. Never commit real API keys.

The `public/` folder holds the app (`index.html` is `second-brain_3.html`). Because the server
serves it, the page and `/api/chat` share one address and no CORS setup is needed.

## 2. Create the service (Blueprint: easiest)
1. Render dashboard > **New** > **Blueprint** > select your repository. It reads `render.yaml`.
2. When asked for `GEMINI_API_KEYS`, paste your keys separated by commas: `AIza...,AIza...`.
3. Click **Apply**. The first build takes a few minutes.

## 2b. Or create it by hand
**New** > **Web Service** > your repository, then:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Health Check Path | `/health` |
| Instance type | Free (or Starter for a disk) |

Environment variables (**Environment** tab):

| Key | Value |
|---|---|
| `NODE_VERSION` | `20` |
| `NODE_ENV` | `production` |
| `GEMINI_API_KEYS` | `key1,key2,key3` (your real keys) |
| `ALLOWED_ORIGIN` | `*` (or your frontend's address if it is hosted elsewhere) |
| `TRUST_PROXY` | `1` |

Do not set `PORT`: Render provides it and the server reads it.

## 3. Keep the database (paid plan only)
1. Change the instance type to **Starter** or higher.
2. **Disks** > **Add Disk**: Name `chats-data`, Mount Path `/var/data`, Size `1 GB`.
3. Add the environment variable `DB_PATH` = `/var/data/chats.db`, then redeploy.

Only files under the mount path persist. If `DB_PATH` points at a folder that does not exist,
the server stops with a clear error instead of quietly writing to temporary storage.
A service with a disk runs as a single instance and redeploys with a few seconds of downtime.

## 4. Check it
- Open `https://<your-service>.onrender.com/health`: it should show `{"status":"ok"}`.
- Open `/api/test-limit` from your phone on mobile data, then from a laptop on Wi-Fi.
  The `ip` values must differ. If they are the same, `TRUST_PROXY` is one hop too low:
  set it to `2` and check again.
- Open the site root `/` and send a chat message.
- In the logs, look for `[db] using ...` (the right path) and `Loaded N Gemini API keys`.

When it works, delete the temporary test routes in `server.js`
(`/api/test-key`, `/api/test-limit`, `/api/test-queue`).

## 5. If the frontend is hosted somewhere else
1. In `index.html`, change `const CHAT_API="/api/chat"` to the full address:
   `https://<your-service>.onrender.com/api/chat`.
2. Set `ALLOWED_ORIGIN` to that site's exact address, for example `https://my-brain.netlify.app`
   (no trailing slash; separate several with commas). CORS only controls browsers; it is not a login.

## Local development
```
npm install
cp .env.example .env     # then put your keys in .env, and set NODE_ENV=development
npm run dev              # nodemon restarts on file changes, http://localhost:5000
```
