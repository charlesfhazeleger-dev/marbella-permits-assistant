# Marbella Permits — AI assistant backend

A tiny Node web service that powers the "Ask about your permit" chat. It holds your
Anthropic API key (which must never live in the website), grounds every answer in the
permit guide + the customer's case, refuses off-topic questions, blocks any invented
bank account number, and limits usage to 10 questions per IP per day (plus a global
daily ceiling). Zero npm dependencies — just Node 18+.

## What you need first
1. An **Anthropic API key**. Create an account at https://console.anthropic.com, add a
   little credit, and generate an API key (starts with `sk-ant-`). You create this
   yourself — it is your billing account.
2. A **GitHub repo** for these backend files (separate from your website repo is fine, or
   a subfolder). Render deploys from GitHub.

## Deploy on Render (free tier)
1. Put the three files in this folder — `server.js`, `package.json`, `.env.example` — into
   a GitHub repository (e.g. `marbella-permits-assistant`). The same drag-and-drop upload
   you used for the site works here too.
2. Go to https://render.com, sign up (free), and click **New + → Web Service**.
3. Connect your GitHub and pick that repository.
4. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Open the **Environment** section and add these variables (see `.env.example`):
   - `ANTHROPIC_API_KEY` = your `sk-ant-...` key  ← keep this secret
   - `ALLOWED_ORIGIN` = `https://charlesfhazeleger-dev.github.io`  (your site's origin)
   - `MODEL` = `claude-haiku-4-5-20251001`  (optional)
   - `PER_IP_LIMIT` = `10`  (optional)
   - `MAX_DAILY_TOTAL` = `500`  (optional global safety cap)
6. Click **Create Web Service**. After ~1–2 minutes Render gives you a URL like
   `https://marbella-permits-assistant.onrender.com`.
7. Test it: open `https://YOUR-SERVICE.onrender.com/health` — you should see
   `{"ok":true,...,"configured":true}`. If `configured` is `false`, the API key isn't set.

## Connect the website
Open `app/assistant.js` in your website and set the one line near the top:
```js
const MP_ASSISTANT_URL = "https://YOUR-SERVICE.onrender.com";
```
Re-upload `app/assistant.js`. Until that URL is set, the chat button stays hidden — so the
site is safe to publish before the backend exists.

## Important notes (read these)
- **Free tier sleeps.** Render's free service spins down after ~15 minutes idle; the first
  question after a quiet period takes ~30–50 seconds to wake. For production, the cheapest
  paid instance stays always-on. The chat shows a "thinking…" state meanwhile.
- **Cost.** You pay Anthropic per question (cents with the Haiku model). The 10-per-IP cap
  and the `MAX_DAILY_TOTAL` ceiling bound your worst case. Watch usage in the Anthropic
  console and set a spend limit there.
- **The IP cap is in-memory.** It resets if the service restarts, and is per-instance. Good
  enough for an MVP. For a hardened cap that survives restarts, add a small store
  (e.g. Upstash Redis) — out of scope here.
- **Lock the origin.** Set `ALLOWED_ORIGIN` to your real site origin (not `*`) so other
  sites can't call your endpoint and spend your credit.
- **It is not a lawyer.** The assistant is instructed to give guidance from your guide only,
  to never invent bank/amount facts, and to defer to your phone/email when unsure.
