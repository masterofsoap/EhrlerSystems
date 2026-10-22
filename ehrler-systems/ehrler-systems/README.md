# Ehrler Systems

Your own AI chat platform on Cloudflare: **Pages** (site + API), **D1** (database) and **Workers AI** (free open models). Email-and-password accounts only, a Chat mode and a Code mode, a live **Workbench** that runs HTML/CSS/JS from replies, and **"Sign in with Ehrler Systems"** so people can sign up for GoVariety with their Ehrler Systems account.

```
ehrler-systems/
├─ public/                    The website (static)
│  ├─ index.html              Landing page + sign in / create account
│  ├─ app.html                The chat app
│  ├─ authorize.html          "Continue to GoVariety" consent screen
│  └─ assets/                 CSS, JS, logo.png (your logo, byte-for-byte unchanged)
├─ functions/api/             The backend (Pages Functions)
│  ├─ auth/                   signup, login, logout, me, account
│  ├─ chat.js                 Streams AI replies and saves them
│  ├─ conversations/          List, search, open, rename, delete
│  ├─ apps/                   Connected apps (disconnect)
│  └─ oauth/                  client, authorize, token, userinfo, revoke
├─ lib/                       Shared server code (auth, OAuth, prompts…)
├─ migrations/0001_init.sql   Database tables
├─ scripts/register-client.mjs  Registers GoVariety (or any app) for SSO
├─ govariety-integration/     Drop-in files for the GoVariety site
└─ wrangler.toml
```

No front-end libraries or build step. Markdown rendering and syntax highlighting are built in (`public/assets/markdown.js`).

---

## 1. Deploy Ehrler Systems

You need Node.js 18+ and a free Cloudflare account.

```bash
cd ehrler-systems
npm install                     # installs wrangler
npx wrangler login

# Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create ehrler-systems

# Create the tables
npx wrangler d1 migrations apply ehrler-systems --remote

# Deploy (first run creates the Pages project)
npx wrangler pages deploy
```

Your site is live at `https://ehrler-systems.pages.dev` (or whatever name Cloudflare gives it). Add a custom domain in the Cloudflare dashboard under **Workers & Pages → ehrler-systems → Custom domains**.

The AI and D1 bindings come from `wrangler.toml`, so there's nothing to click in the dashboard.

### Settings (`wrangler.toml` → `[vars]`)

| Variable | Default | What it does |
|---|---|---|
| `CHAT_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Model for Chat mode |
| `CODE_MODEL` | `@cf/qwen/qwen2.5-coder-32b-instruct` | Model for Code mode |
| `DAILY_MESSAGE_LIMIT` | `75` | Messages per user per day (resets 00:00 UTC) |
| `SIGNUPS_OPEN` | `true` | Set `false` to stop new sign-ups |

Cloudflare retires models over time. Check current names with `npx wrangler ai models list` and update the two model variables if one disappears (the app shows a clear error if a model is gone).

**Free tier math:** Workers AI gives 10,000 free Neurons a day, shared by all users. The 70B chat model is the expensive one; if you hit the cap, switch `CHAT_MODEL` to a smaller model such as `@cf/meta/llama-3.1-8b-instruct-fast`, or lower `DAILY_MESSAGE_LIMIT`.

### Run it locally

```bash
npx wrangler d1 migrations apply ehrler-systems --local
npx wrangler pages dev
```

Workers AI calls go to Cloudflare even in local dev (you must be logged in). If the AI binding is missing, the chat endpoint replies with a canned "Dev mode" message instead, so the UI still works.

---

## 2. Let people sign up for GoVariety with Ehrler Systems

This is standard OAuth 2.0 (authorization code + PKCE). Ehrler Systems is the identity provider; GoVariety is the app.

### a) Register GoVariety (in this project)

Use GoVariety's real address in the callback URL:

```bash
node scripts/register-client.mjs govariety "GoVariety" https://govariety.pages.dev/auth/ehrler/callback
npx wrangler d1 execute ehrler-systems --remote --file=register-govariety.sql
```

It prints a **client secret once**. Copy it for the next step. You can list several callback URLs (for example a custom domain and the `.pages.dev` one). Re-running the script for the same app replaces its secret.

### b) Add the kit to GoVariety (in the GoVariety project)

Copy from `govariety-integration/` into the GoVariety site:

| Copy | To |
|---|---|
| `functions/auth/ehrler/start.js`, `callback.js` | `functions/auth/ehrler/` |
| `lib/ehrler.js`, `lib/govariety-accounts.js` | `lib/` (project root, beside `functions/`) |
| `migrations/0100_ehrler_link.sql` | GoVariety's migrations folder (renumber to come last) |
| `public/assets/ehrler-logo.png` | GoVariety's `public/assets/` |
| The button in `public/ehrler-button.html` | GoVariety's sign-up and sign-in screens |

Then in the GoVariety project:

```toml
# GoVariety wrangler.toml
[vars]
EHRLER_URL = "https://ehrler-systems.pages.dev"   # your Ehrler Systems address, no trailing slash
EHRLER_CLIENT_ID = "govariety"
```

```bash
npx wrangler pages secret put EHRLER_CLIENT_SECRET        # paste the secret from step (a)
npx wrangler d1 migrations apply <govariety-db> --remote
npx wrangler pages deploy
```

**Check `lib/govariety-accounts.js` first.** It's the only file that touches GoVariety's own tables, and it assumes `users(id, email, name, password_hash, created_at)`, `sessions(token_hash, user_id, created_at, expires_at)` and a `gv_session` cookie. If GoVariety's tables or cookie are named differently, change them there.

### What users see

1. On GoVariety they tap **Continue with Ehrler Systems**.
2. Ehrler Systems asks them to sign in (or create an account), then shows "GoVariety wants to use your Ehrler Systems account" with exactly what's shared: name, account ID and email.
3. They tap **Allow** and land back on GoVariety, signed in. A GoVariety account is created automatically the first time.
4. Next time it's one tap; consent is remembered. They can disconnect GoVariety any time in **Account → Connected apps**, which revokes its tokens immediately.

**Safety rule built in:** if someone already has a GoVariety password account with the same email, the kit does **not** merge them automatically (Ehrler Systems doesn't verify email ownership yet, so auto-merging would let anyone take over an account). They're sent to `/login?ehrler=email_exists`. After signing in with their password they can connect Ehrler from settings with a link to `/auth/ehrler/start?link=1&next=/settings`.

---

## API reference (for GoVariety or any future app)

| Endpoint | Purpose |
|---|---|
| `GET /authorize` | Consent screen. Params: `response_type=code`, `client_id`, `redirect_uri` (exact match), `scope` (`profile email`), `state`, `code_challenge`, `code_challenge_method=S256` |
| `POST /api/oauth/token` | Form or JSON. `grant_type=authorization_code` (+ `code`, `redirect_uri`, `code_verifier`) or `grant_type=refresh_token` (+ `refresh_token`). Client auth via `client_secret` or HTTP Basic |
| `GET /api/oauth/userinfo` | `Authorization: Bearer <access_token>` → `{ sub, name, email, email_verified, created_at }` |
| `POST /api/oauth/revoke` | `token`, `client_id`, `client_secret` |

Access tokens last 1 hour; refresh tokens 60 days and rotate on every use. Codes last 5 minutes and work once (a replayed code also revokes the tokens it issued). Apps without a server can be registered with `--public`; they must use PKCE and can call the token/userinfo endpoints from the browser (CORS is allowed only for their registered origins).

---

## Security notes

- Passwords: PBKDF2-SHA256, 100,000 iterations, per-user salt. Only hashes are stored.
- Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 is stored. 30-day expiry. Changing your password signs out other devices.
- CSRF: state-changing requests must be JSON from the same origin.
- Brute force: 8 failed logins per email or 30 per IP in 15 minutes triggers a cool-down.
- The Workbench runs code in a sandboxed iframe with no access to the site, your cookies or the API.
- Markdown is escaped before formatting, and links are limited to `http(s)` and `mailto`.
- Not included yet: email verification and password-reset emails (both need an email-sending service such as Resend or Postmark). Until then, a forgotten password has to be reset by you in D1.
