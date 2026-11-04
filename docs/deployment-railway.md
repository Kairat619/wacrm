# Deploying to Railway

This guide deploys the full app to [Railway](https://railway.com). The app
is a full-stack **Next.js 16** server (32 API routes, a WhatsApp webhook,
SSR auth) — it must run as a long-lived Node process, **not** a static
site. Your database/auth/storage stays on **Supabase** (managed); Railway
only runs the Next.js app.

A `railway.json` at the repo root pins the build/start commands, so a
freshly connected service is reproducible.

---

## Prerequisites

- A GitHub account with this repo (a fork is fine).
- A [Railway](https://railway.com) account.
- Your existing **Supabase** project (URL + anon key + service-role key).
- A **Meta for Developers** app with WhatsApp configured (App Secret, and
  App ID if you submit image-header templates).
- Node ≥ 20 locally if you want to generate secrets.

> **FFmpeg**: inbox voice notes transcode browser recordings to Ogg/Opus
> server-side (`/api/media/voice-note`). The service builds with the repo's
> **Dockerfile** (`railway.json` → `builder: DOCKERFILE`), which installs
> FFmpeg in its runtime stage — nothing to configure. Don't switch back to
> the Nixpacks builder: its generated plan ignored `nixpacks.toml` and
> shipped images without FFmpeg, while baking runtime secrets into
> build-arg layers.

---

## 0. Pre-flight: rotate secrets (recommended)

`.env.local` is gitignored and was never committed, so nothing leaked to
GitHub. Still, treat any secret that has been shared (chat, screen-share,
old laptops) as compromised and rotate before going live:

- **Supabase keys** — Supabase Dashboard → Project Settings → API →
  regenerate the `anon` and `service_role` keys.
- **`ENCRYPTION_KEY`** — generate a fresh 32-byte hex value:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  > ⚠️ Rotating `ENCRYPTION_KEY` orphans every WhatsApp token already
  > encrypted under the old key — affected users must re-save their
  > WhatsApp settings to reconnect. On a brand-new deploy with no live
  > tokens this is harmless. If you already have connected numbers, keep
  > the current key instead.

- **`AUTOMATION_CRON_SECRET`** — generate a long random string:

  ```bash
  openssl rand -hex 32
  ```

Never paste any of these into the repo. They go in the Railway dashboard
(next section).

---

## 1. Create the Railway service

1. Railway → **New Project** → **Deploy from GitHub repo**.
2. Select this repository.
3. If the Next.js app lives in a subdirectory of the repo (e.g. `wacrm/`),
   open the service → **Settings** → set **Root Directory** to that
   subdirectory so `railway.json` and `package.json` are found.
4. Railway reads `railway.json`, which builds with the repo's `Dockerfile`.
   Don't override the build or start commands.

Railway injects a `PORT` env var at runtime, and the standalone server binds to
it automatically — no extra configuration needed.

---

## 2. Environment variables

Add these under the service → **Variables**. Mark nothing as "public" by
hand — the `NEXT_PUBLIC_*` prefix already controls client exposure.

### Required (app won't start without these)

| Variable                        | Where to get it                                                            |
| ------------------------------- | -------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase → Project Settings → API → Project URL                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` key                             |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase → Project Settings → API → `service_role` key (**server secret**) |
| `ENCRYPTION_KEY`                | 64 hex chars (see step 0) — encrypts WhatsApp tokens                       |
| `META_APP_SECRET`               | Meta for Developers → App Settings → Basic → App Secret                    |

### Recommended

| Variable                 | Value                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SITE_URL`   | Your canonical public URL, e.g. `https://crm.example.com` (no trailing slash). Used for sitemap/OG and for links built without an incoming request (cron). Set after you know your domain (step 4), then redeploy. |
| `AUTOMATION_CRON_SECRET` | Long random string (see step 0). Protects the two cron endpoints. Required if you use automation **Wait** steps or want the flow stale-run sweep.                                                                  |

### Optional (only if you use the feature)

| Variable               | Purpose                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_ID`          | Needed only to submit message templates with an **image** header.                                                                                  |
| `ALLOWED_INVITE_HOSTS` | Comma-separated hostname allow-list for invite URLs (defense-in-depth on multi-host setups). Usually unnecessary if `NEXT_PUBLIC_SITE_URL` is set. |

---

## 3. First deploy

Trigger the deploy (Railway does this automatically on connect, and on
every push to the connected branch). Watch the build logs:

1. `npm ci` installs dependencies inside the Docker build.
2. `npm run build` runs the Next.js production build (includes typecheck), and
   `npm run build:worker` bundles the background worker.
3. `node server.js` boots the server.

When it's live, Railway gives you a `*.up.railway.app` URL. Open it and
confirm the login page renders.

---

## 4. Custom domain

1. Service → **Settings** → **Networking** → **Custom Domain**, add your
   domain and create the CNAME record Railway shows at your DNS provider.
2. Once it resolves (TLS is automatic), set `NEXT_PUBLIC_SITE_URL` to the
   `https://` form of that domain and **redeploy** so the value bakes into
   the client build.

---

## 5. Schedule the two cron endpoints

The app exposes two scheduled endpoints that need an external pinger:

- `GET /api/automations/cron` — drains automation **Wait** steps.
- `GET /api/flows/cron` — sweeps stale flow runs.

Both require the header `x-cron-secret: <AUTOMATION_CRON_SECRET>`.

### Option A — Railway Cron service (keeps everything on Railway)

1. In the same project → **New** → **Empty Service** (or a small Docker /
   shell service).
2. Give it the **same** `AUTOMATION_CRON_SECRET` variable, plus your app's
   public URL as e.g. `APP_URL`.
3. Set a **Cron Schedule** (service → Settings → Cron Schedule), e.g.
   `*/5 * * * *` (every 5 minutes), and a start command that curls both
   endpoints:

   ```bash
   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" "$APP_URL/api/automations/cron"; \
   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" "$APP_URL/api/flows/cron"
   ```

   A Railway cron service runs the command on the schedule, then exits.

### Option B — External scheduler

Use a free service like [cron-job.org](https://cron-job.org) or a GitHub
Actions scheduled workflow to issue the same two authenticated `GET`s on
your interval. Every 1–5 minutes is typical.

> If you don't use Wait steps and don't care about the stale-run sweep,
> you can skip cron entirely — the rest of the app works without it.

---

## 6. Wire up the Meta WhatsApp webhook

1. In your Meta app → WhatsApp → Configuration, set the **Callback URL** to:

   ```
   https://<your-domain>/api/whatsapp/webhook
   ```

2. Set the **Verify Token** to whatever your WhatsApp settings expect (set
   during in-app onboarding), and subscribe to the message-related fields.
3. Confirm `META_APP_SECRET` in Railway matches the app — the webhook
   rejects any POST whose HMAC-SHA256 signature doesn't verify.

---

## 7. End-to-end verification

- [ ] App loads at your domain; login/signup page renders.
- [ ] You can sign up / sign in (Supabase auth round-trips).
- [ ] Settings → connect a WhatsApp number succeeds.
- [ ] Sending a test message works; an inbound reply appears in the Inbox
      (confirms the webhook reaches `/api/whatsapp/webhook`).
- [ ] A manual `curl` to `/api/automations/cron` with the secret header
      returns `200` (cron path healthy).

---

## 8. Reliability rollout: worker, migrations and flags

Durable webhooks, media jobs and persist-first sending are each behind a flag that
is off by default. Merging the code changes no behaviour except the small fixes
listed in `WACRM_RELIABILITY_VERIFICATION.md`. Turn the features on one at a time.

> **Migration 060 is the exception: apply it before merging.** The webhook writes
> `messages.media_id` on every inbound message regardless of flags. Without the
> column, inbound messages fail to save.

**No Redis is needed.** Jobs live in Postgres, so Railway needs no new database.

### Required environment variables

| Variable                   | Services    | Purpose                                                |
| -------------------------- | ----------- | ------------------------------------------------------ |
| `WEBHOOK_DURABLE_INTAKE`   | web, worker | `true` saves webhook payloads before acknowledging     |
| `OUTBOUND_PERSIST_FIRST`   | web, worker | `true` saves outbound messages before calling Meta     |
| `MEDIA_JOBS_ENABLED`       | web, worker | `true` stores inbound media in R2 through jobs         |
| `R2_ACCOUNT_ID`            | web, worker | Cloudflare account ID                                  |
| `R2_ACCESS_KEY_ID`         | web, worker | R2 API token access key (server secret)                |
| `R2_SECRET_ACCESS_KEY`     | web, worker | R2 API token secret (server secret)                    |
| `R2_BUCKET`                | web, worker | Bucket name. Keep it private, with no public access    |
| `MEDIA_WORKER_CONCURRENCY` | worker      | Downloads in progress at once. Defaults to 3           |

The worker also needs what the app already uses: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, plus any AI or automation settings,
because recovering a webhook runs the same flows and automations as the web service.

### Create the worker service

1. In the same project: **New** → **GitHub Repo** → this repository.
2. Service → **Settings** → **Config-as-code**: set the path to
   `/railway.worker.json`. It uses the same image and runs `node worker.cjs`.
3. Copy the variables above. Build arguments need the same `NEXT_PUBLIC_*` values
   as the web service.
4. Deploy, then check its **Deploy Logs** for a `worker.started` line listing the
   tasks it's running. It doesn't serve HTTP, so it needs no domain.

### Staging (only if you want one)

A second Railway environment on a **separate Supabase project and R2 bucket**, with
its own Meta test number pointed at the staging webhook URL. Never share production's
Supabase project: the worker would claim production jobs.

### Production rollout, one step at a time

Do each step, watch the report for a day, then move on. For the report:

```bash
curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" "$APP_URL/api/internal/reliability?hours=24"
```

- [ ] **Step 0: ship the code, all flags off.** Apply migration 060 in the Supabase
      SQL editor, then merge. Send and receive a message and a photo.
- [ ] **Step 1: durable webhooks.** Apply 061. Create the worker. Set
      `WEBHOOK_DURABLE_INTAKE=true` on both services. Check rows reach `done`, and
      `webhook.failed` stays at 0.
- [ ] **Step 2: outbound.** Apply 063. Set `OUTBOUND_PERSIST_FIRST=true` on both.
      Send one of each type from the inbox. Check bubbles reach sent and delivered,
      and force a failure by messaging an invalid number.
- [ ] **Step 3: media.** Can go before steps 1 and 2, as long as the worker exists.
      Create a private R2 bucket and API token. Apply 062. Set the `R2_*` variables and
      `MEDIA_JOBS_ENABLED=true` on the worker, and confirm its logs show
      `media.storage_check_passed`. Only then set the same variables on the web service.
      Send a photo, a large PDF and a video. Check `media_jobs.status` reaches `stored`,
      and that the video plays and seeks. Without step 1, a crash at the wrong moment
      can still lose a message or its job; the file is then fetched from Meta until it
      expires.

### Rollback

- **A feature misbehaves:** set its flag to anything but `true` on both services and
  restart. The previous code path takes over.
- **A bad deploy:** redeploy the previous build in Railway. All these migrations only
  add things, so the old code still runs against the new schema.
- **Don't drop the new tables or columns during an incident.** `media_jobs` is the
  only record of where R2 copies are.
- **After turning media jobs off:** messages stored in R2 fall back to fetching from
  Meta, and stop working once Meta's retention ends. Turn it back on to recover them,
  because the objects stay in R2.
- **The worker can be stopped at any time.** Work stays queued and resumes on restart.
  With `OUTBOUND_PERSIST_FIRST` on, stopped means no automatic retries and no flagging
  of stuck sends, so don't leave it stopped for long.

### What to watch

Searching Deploy Logs by event name:

| Event                        | Meaning                                                |
| ---------------------------- | ------------------------------------------------------ |
| `webhook.persist_failed`     | Meta got a 503 and will redeliver. Look at the database |
| `webhook.event_failed`       | A delivery used up its retries. Read `last_error`      |
| `outbound.engagement_limit`  | A 131049                                               |
| `outbound.generic_failure`   | A 131000                                               |
| `outbound.retries_exhausted` | A 131000 outlasted its retries, and an agent must act  |
| `outbound.delivery_unknown`  | Sends flagged for a person after a process died        |
| `media.retry`                | With `failure: rate_limited`, a 429 from Meta          |
| `media.failed`               | A file used up its retries, or is too large            |
| `media.storage_check_failed` | R2 settings are wrong. Jobs wait, and nothing is lost  |
| `auth.refresh_failed`        | A session could not be renewed                         |

---

## Notes & gotchas

- **Not static.** Static hosts (GitHub Pages, S3, Netlify static) cannot
  run this app — the API routes and webhook need a Node server.
- **Supabase is separate.** Railway runs only the app; do not provision a
  Postgres add-on. All data/auth/storage stays in your Supabase project,
  which enforces Row-Level Security.
- **Secrets live in Railway**, never in the repo. `.env.local` is for local
  development only and is gitignored.
- **Redeploys on push.** Every push to the connected branch rebuilds.
  Server secrets persist across deploys; `NEXT_PUBLIC_*` values are baked
  into the client bundle at build time, so changing them requires a
  redeploy.
