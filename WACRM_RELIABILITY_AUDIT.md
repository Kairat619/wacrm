# waCRM Reliability Audit

Audit date: 2026-11-04. Branch: `sync-upstream-b1` at `58dda9d`. No application
code was changed to produce this document.

## How to read this

Each finding is tagged by how it was established:

- **[Code]**: read directly in this repo or its installed dependencies. The
  defect exists. How often it fires is not known.
- **[Hypothesis]**: a plausible cause that the code allows but does not prove.
  It needs production logs to confirm.
- **[External]**: depends on Meta, Railway or Supabase behaviour that was not
  checked against their current documentation. Confirm before relying on it.

### What this audit could not measure

**No production data was examined.** A read-only, count-only query was blocked
by the session's permission controls, and `railway logs` reports `Unauthorized`.
So this audit can say what can go wrong, but not how often each failure happens
or which one causes the most customer-visible errors. The priorities below come
from severity and blast radius, not observed frequency.

Two things would close the gap:

1. `railway login`, then pull Deploy Logs for `[mirror-media]`, `Failed to
   verify media`, `Error inserting message`, `refresh_token_not_found`.
2. Run the count-only script at the path given in the handover message. It
   prints failure counts by Meta error code and how inbound media is stored.
   It reads no message text, phone numbers or names.

## Where the brief and the repository differ

The brief assumes infrastructure that does not exist here.

| Brief assumes                     | What the repo has                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare R2 integration         | None. No S3 or R2 client, no env vars. Media goes to the Supabase Storage `chat-media` bucket.                                                    |
| Redis and an existing queue       | None. No queue dependency. The only mention of Redis is a comment in `src/lib/rate-limit.ts:12`. Background work runs in `after()` in the web process. |
| A worker to deploy and restart    | None. One Railway service, one replica (`railway.json`). The closest pattern is the two cron-pinged routes.                                       |
| Metrics to extend                 | None. Free-form `console.*` only; no logger or metrics dependency.                                                                                |
| A staging environment             | None visible in the repo. Merging to `main` deploys production directly.                                                                          |

Delivering Phases 2 and 3 therefore means **adding** a job system and possibly a
storage provider. That is the major architectural change the brief asks to have
reported first.

## What already works and must be kept

- **Signature verification** runs over the raw bytes before parsing, and a bad
  signature returns 401 (`webhook/route.ts:233-246`). Body size is capped.
- **Inbound idempotency**: unique index on `(conversation_id, message_id)`
  (migration 037), and the upsert result gates all downstream effects
  (`route.ts:703-745`).
- **Status reconciliation**: a monotonic ladder (`message-status.ts`), guarded
  updates, and parking of statuses that arrive before the row exists
  (`message-status-sync.ts`, migration 054).
- **No automatic resend exists on any send path.** Today's outbound failures
  cannot cause duplicates through retry logic. Phone-variant retry fires only
  on an explicit Meta rejection. New retry logic must not lose this property.
- **Broadcast batch retry** replays only on the local 429, which is known to
  precede any send (`broadcast-retry.ts`).
- **`MetaApiError`** already captures code, subcode, fbtrace ID, HTTP status and
  details (`meta-api.ts:60-98`). The data is there; callers discard it.
- **Browser auth client** is a singleton, and auth-js 2.118 single-flights
  refreshes within a tab and adds a failure cooldown (`GoTrueClient.js:4197-4216`).
- **`onAuthStateChange`** does not await Supabase calls inside its callback, so
  the known lock deadlock does not apply (`use-auth.tsx:357-374`).
- **Service role key**: no `"use client"` file imports an admin client or reads
  the key.

## Root causes

The reported symptoms do not share one cause. There are five separate problems.

### A. Webhook: an acknowledged event is not a durable event

| ID  | Sev  | Finding                                                                                                                                                                                                                                                                       | Evidence                         |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| W1  | High | **[Code]** Nothing is persisted before the 200. The payload exists only in memory during `after()`. A crash, OOM or kill loses it, and Meta will not redeliver because it got a 200.                                                                                         | `route.ts:269-277`               |
| W2  | High | **[Code]** Any transient failure after the ack permanently drops the message: config lookup, contact, conversation or message insert errors log and `return`.                                                                                                                 | `route.ts:359-365, 615, 624, 730-733` |
| W3  | High | **[Code]** No drain period is configured. Next's self-hosting guide says the server finishes `after()` work on SIGTERM and recommends a 10-30s platform drain. `railway.json` sets none, and every merge to `main` restarts the only replica. **[External]** Railway's default drain is unverified. | `railway.json`, Next docs `self-hosting.md:299` |
| W4  | Med  | **[Code]** One throw abandons the rest of the delivery. `decrypt()` and the per-message loop have no per-item isolation, so later messages and entries in that payload are lost.                                                                                              | `route.ts:386-408, 272`          |
| W5  | Med  | **[Code]** Effects after the insert cannot be recovered. A crash after the insert but before flows, automations or AI reply leaves them never run, and a later replay is treated as a duplicate.                                                                              | `route.ts:739-745, 802-932`      |

### B. Inbound media: failures are invisible and can be unrecoverable

| ID  | Sev  | Finding                                                                                                                                                                                                                                  | Evidence                                      |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| M1  | High | **[Code]** A transient failure resolving media at receipt destroys the only reference to it. `media_url` becomes NULL, the media ID is stored nowhere else, and the attachment is unrecoverable even though Meta still holds the bytes.   | `route.ts:994-1000`                           |
| M2  | High | **[Code]** The download happens before the message insert and no Graph fetch has a timeout. A slow or hung CDN delays the message itself and everything after it in the batch, and widens the W1 loss window.                             | `route.ts:647-652` before `:703`; `meta-api.ts:1230, 1261` |
| M3  | High | **[Code]** Fallback to the proxy URL is silent and never retried. Any mirror failure leaves a pointer that dies at Meta's retention limit. Nothing records it or tries again.                                                             | `mirror-inbound-media.ts:178-239`             |
| M4  | High | **[Code]** Files over 16 MB, or with a MIME type outside the allow-list, are never mirrored, so they always expire. Documents can be any type, and the code comments put Meta's document limit at 100 MB.                                 | `upload-media.ts:21`, migration 039           |
| M5  | Med  | **[Code]** No 429 handling. `downloadMedia` throws a plain `Error`, so status and `Retry-After` are lost, and the proxy turns everything into a 500. There is no retry, backoff or concurrency bound anywhere in the media path.            | `meta-api.ts:1264-1266`, `media/[mediaId]/route.ts:109-113` |
| M6  | Med  | **[Code]** Each view of unmirrored media costs two Meta calls, limited only by 240/min per user. The per-tab blob cache helps, but a media-heavy thread multiplies calls. **[Hypothesis]** This is the likely main 429 source.              | `media/[mediaId]/route.ts:76-82`, `rate-limit.ts:209` |
| M7  | Med  | **[Code]** A replayed delivery downloads and uploads the media again, because that work runs before the idempotency check.                                                                                                                | `route.ts:647` before `:703`                  |
| M8  | Med  | **[Code]** `isMissingObject` treats every code 100 as gone. Code 100 is a generic invalid-parameter error, so a real bug would be shown as "attachment expired" and would look permanent.                                                  | `meta-api.ts:95-97`                           |
| M9  | Med  | **[Code]** Whole files are buffered in memory, and the size check runs after the download when Meta omits or understates `file_size`. With one replica, an OOM takes all in-flight webhook work with it (W1).                              | `meta-api.ts:1269`, `mirror-inbound-media.ts:171, 184` |
| M10 | Low  | **[Code]** No checksum verification. **[External]** Meta's media metadata is understood to include `sha256`, which `getMediaUrl` ignores.                                                                                                  | `meta-api.ts:1236-1245`                       |
| M11 | High | **[Code]** Not in the brief, but relevant to the storage choice: mirrored customer media sits in a **public** bucket. Anyone with the URL can fetch a customer's document with no login and no expiry.                                    | migration 039 (`public = TRUE`)               |

Expired CDN URLs are **not** a current failure cause: the URL is used immediately
after being fetched. They become one as soon as downloads are queued, so the job
design must re-resolve the URL on each attempt.

### C. Outbound: no record exists until Meta has already accepted

| ID  | Sev  | Finding                                                                                                                                                                                                                                                                                                     | Evidence                                                  |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| O1  | High | **[Code]** The Meta call comes before any database row. A crash in between means the customer got a message the CRM has no record of. An insert failure returns 500, the UI shows failed, and an agent resending causes a real **duplicate**.                                                                | `send-message.ts:415-447` before `:480`, `:502-508`       |
| O2  | High | **[Code]** No idempotency key exists. A client-side network error is shown as failed even if Meta sent it, and the only recovery is sending again.                                                                                                                                                          | `send/route.ts`, `message-thread.tsx:638-643`             |
| O3  | High | **[Code]** Synchronous failures are never persisted. The failed state lives in React state on a temporary ID and disappears on reload, leaving no audit trail and nothing to retry.                                                                                                                         | `message-thread.tsx:625-631`                              |
| O4  | High | **[Code]** Structured errors are thrown away. `MetaApiError` is flattened to a string. Broadcast stores only `error_message`. Webhook failures store code, title and details but not `message`.                                                                                                             | `send-message.ts:442-446`, `broadcast-core.ts:285, 307`   |
| O5  | High | **[Code]** No classification, and no manual retry endpoint. 131049 and 131000 have no outbound handling; they appear only in a comment and in the connect-flow explainer. The bubble shows Meta's raw title, so an agent has no idea a 131049 should not be resent.                                          | `message-bubble.tsx:135-138`, `meta-error-explain.ts:84`  |
| O6  | Med  | **[Code]** The send-then-insert pattern is repeated across separate paths: `send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts` (three variants), `broadcast/route.ts`, `broadcast-core.ts`. A fix in one does not reach the others.                                                          | see grep of `sendTextMessage` etc.                        |
| O7  | Med  | **[Code]** The `messages.status` CHECK has no `queued` value, and send POSTs have no timeout.                                                                                                                                                                                                                | migration `001:173`, `meta-api.ts:417`                    |
| O8  | Med  | **[Hypothesis]** A crash between Meta accepting a broadcast message and the recipient row update leaves it `pending`, so a later resume could send it twice. `broadcast-resume.ts` needs review on this exact point.                                                                                         | `broadcast-core.ts:272-301`                               |

Notes on the two named codes:

- **131049**: **[External]** this is understood to arrive through the status
  webhook, after Meta returned a wamid, not as a synchronous error. So
  "no immediate resend" already holds automatically. What is missing is the
  explanation to the agent, a block on manual retry, and a metric.
- **131000** can arrive both ways, and the two cases carry different duplicate
  risk. See decision D3 in the implementation plan.

### D. Auth: fragile handling of refresh and of transient errors

| ID  | Sev  | Finding                                                                                                                                                                                                                                                                                                                      | Evidence                                |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| A1  | High | **[Hypothesis]** Likely source of `refresh_token_not_found`: single-flight protects one browser tab, but the middleware builds a new client per request and its matcher covers all of `/api`. Parallel requests carrying an expired cookie can each try to rotate the same refresh token. **[External]** Whether this fails depends on the project's reuse-interval setting. Other causes are a global sign-out elsewhere and revoked sessions. | `middleware.ts:12-35, 180-183`          |
| A2  | High | **[Code]** The middleware ignores the `getUser()` error, so a Supabase network blip is treated as logged out: redirect to `/login`, or 401 on the API.                                                                                                                                                                       | `middleware.ts:33-35, 98-116`           |
| A3  | Med  | **[Code]** The 3-second safety timer sets `loading=false` while `user` is still null, and the shell then pushes to `/login`. A slow refresh bounces a validly signed-in user.                                                                                                                                                | `use-auth.tsx:312-318`, `dashboard-shell.tsx:49-50` |
| A4  | Med  | **[Code]** No re-authentication UX. A `getSession` error is only logged. Real session loss silently redirects with no reason and no return path, and an unsent draft is lost.                                                                                                                                                 | `use-auth.tsx:327`, `dashboard-shell.tsx:49-50` |
| A5  | Low  | **[Code]** The admin clients have no `server-only` guard, so a mistaken client import would fail silently at runtime rather than at build time. `next` keeps the key out of the bundle regardless.                                                                                                                           | `lib/*/admin-client.ts`                 |
| A6  | Low  | **[Code]** `middleware.ts` is a deprecated convention in Next 16, renamed `proxy`. It still works, and migrating it is separate from this work.                                                                                                                                                                               | Next docs `proxy.md:11`                 |

No authentication errors are being suppressed in a way that hides a fixed root
cause, because no fix exists yet.

### E. Observability and operations

| ID  | Sev  | Finding                                                                                                                                                                                                 | Evidence                                |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| E1  | High | **[Code]** None of the metrics in Phase 6 exist. Mirror outcome can only be inferred from the shape of `media_url`. This is also why this audit cannot give frequencies.                                 | no logger or metrics dependency         |
| E2  | Med  | **[Code]** A contact phone number is written to logs on auto-correction. No token logging was seen in the files reviewed; this was not a full-repo log audit.                                            | `send-message.ts:451`                   |
| E3  | Med  | **[Code]** Migrations are manual and nothing ties them to deploys, so code can ship ahead of its schema. New columns must be applied before merging.                                                      | `.github/workflows/migrations.yml`      |
| E4  | Low  | **[Code]** `docs/deployment-railway.md` still describes Nixpacks and `npm run start` in steps 1 and 3, contradicting its own FFmpeg note and `railway.json`. `nixpacks.toml` is unused. No healthcheck path is set. | `docs/deployment-railway.md:71-73, 116-118` |

## Test baseline

| Run                         | Result                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Full suite, 18 runs         | 17 runs: 1544 of 1544 passed. 1 run: 1 failed, 1543 passed.                                               |
| The failure                 | **A flaky test exists and is not identified.** The output of the failing run was truncated before the test name, and 17 reruns did not reproduce it. |
| Lint, typecheck, build      | Not run; no code changed.                                                                                 |

Existing coverage is good for the webhook route (42 tests) and the send core (24).
There are no tests for `use-auth.tsx`, and the middleware has only 5 tests, none
covering refresh races or `getUser` errors.
