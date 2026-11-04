# waCRM Reliability Implementation Plan

Companion to `WACRM_RELIABILITY_AUDIT.md`; finding IDs (W1, M1, O1...) refer to
it. **Status: approved 2026-11-04. Implemented locally and not yet deployed; see
`WACRM_RELIABILITY_VERIFICATION.md` for what was and wasn't proven.**

## Where the build differs from this plan

- **Media URLs stay the same.** Messages keep `/api/whatsapp/media/<id>`, and that route
  serves the R2 copy once stored. So there's no separate "processing" bubble state: the
  attachment works throughout, from Meta at first and from R2 after.
- **No Supabase storage implementation.** Turning the media flag off returns to the
  existing inline mirror, so a second implementation would never have run.
- **Added a refresh single-flight without logs confirming the cause.** The plan said to
  confirm first, but logs weren't reachable. It's safe either way, and
  `auth.refresh_failed` will show whether it helped.
- **W5 is not recovered.** Re-running flows and automations after a crash could message a
  customer twice, so they stay at-most-once.
- **Bot and broadcast sends are not converted**, which the plan had as a later rollout
  stage. Not done.
- **Also skipped:** the existing-media sweep, which needs separate approval; the
  dashboard card, replaced by a JSON endpoint; `server-only` guards.

## Decisions

Made 2026-11-04: **D1 Postgres job tables. D2 Cloudflare R2. D3 the recommended
retry policy, including at most 2 automatic retries for a 131000 returned directly
by Meta. D4 staging only if needed: instructions are written, and no outside
infrastructure is created as part of this work.**

The reasoning behind each decision is kept below.

### D1. Job system: Postgres or Redis?

**Recommendation: Postgres job tables, no Redis.**

Durability is the point of this work, and Postgres is already the system of
record. A job can be created in the same transaction as the message it belongs
to, which Redis cannot offer. Workers claim with `FOR UPDATE SKIP LOCKED`, and a
lease expiry handles restart recovery. There is one replica and modest volume,
so Redis throughput is not needed, and adding it means another service to run
and another way to lose jobs.

Redis stays useful later for one narrow job: sharing rate-limit state if the app
ever runs more than one replica.

### D2. Media storage: R2 or Supabase Storage?

**Recommendation: R2 as the brief specifies, for new inbound media, behind a
small storage interface. Existing objects stay where they are.**

R2 solves M4 (no 16 MB bucket ceiling or MIME allow-list) and M11 (a private
bucket, with access through an authenticated route). It requires you to create a
bucket and supply credentials.

The alternative is to stay on Supabase Storage and raise the limits. That is
less work, but the public-bucket exposure (M11) would need separate handling.

### D3. Which 131000 failures may be retried automatically?

The brief asks both to retry 131000 and to never resend when a duplicate is
possible. **[External]** To our knowledge Meta's send endpoint has no idempotency
key, so this has to be a policy choice:

| Case                                                      | Duplicate risk | Recommendation                         |
| --------------------------------------------------------- | -------------- | -------------------------------------- |
| Status webhook says `failed` with 131000 for a wamid      | Low            | Auto-retry, at most 2 times            |
| Connection error, timeout, or 5xx with no Meta error body | **Real**       | Never auto-retry; flag for an agent    |
| HTTP response with a Meta 131000 body and no wamid        | Low, not zero  | **Your call.** Recommended: auto-retry, at most 2 times. Strict alternative: flag for an agent |
| 429 or rate-limit codes (130429, 131056 etc.)             | Very low       | Auto-retry with backoff                |
| 131049, and other permanent codes                         | n/a            | Never retry; explain to the agent      |

### D4. Staging

There is no staging environment in the repo, and the brief asks for staging
instructions. **Recommendation:** a second Railway environment on a separate
Supabase project. It needs its own Meta test number to exercise webhooks.

## Delivery order

Each increment is its own PR into `main` through the usual CI gate, and is
deployable and revertible alone. Migrations are additive only and start at `060`.
They are applied by hand before the matching merge, per the existing process.

### Increment 0: stop the bleeding (no new infrastructure)

Small fixes that hold under any answer to D1-D4:

- M1: store the media ID on `messages` so a failed resolve stays recoverable
  (migration 060, additive).
- W4: isolate failures per message and per entry.
- M2: add timeouts to Graph and CDN fetches. Send POSTs need a separately chosen
  timeout, because a timeout there creates an ambiguous send.
- M8: narrow `isMissingObject`.
- M5: make `downloadMedia` throw a `MetaApiError` carrying status and
  `Retry-After`; return 429 rather than 500 from the proxy.
- O4: keep the structured Meta error on `SendMessageError`.
- A2 and A3: treat a retryable `getUser` failure as unknown rather than logged
  out, and stop the timer redirecting on an unresolved session.
- W3: set a drain period in `railway.json`, once the setting is confirmed.
- E2: remove the phone number from the log line.
- Identify the flaky test.

### Increment 1: durable webhook intake (W1, W2, W5)

- New `webhook_events` table holding the raw verified payload, deduplicated on a
  payload hash, with status and attempt count.
- **Insert before the 200.** If the insert fails, return 5xx so Meta redelivers.
  This is a deliberate behaviour change.
- Move each stage's completion onto the event, so a crash after the message
  insert can resume flows and automations without re-running what finished.
- The existing unique index and upsert stay exactly as they are.
- Payloads contain customer data, so they get a retention prune (proposed 7 days
  after processing).

### Increment 2: job runner and media jobs

**Job runner.** `claim_jobs` RPC using `SKIP LOCKED` with a lease; expired leases
return to the queue, which is the restart recovery. Exponential backoff with full
jitter, capped attempts, and bounded concurrency.

**Runtime.** A second Railway service from the same image, running a dedicated
entry point. `output: "standalone"` does not include one, so the Dockerfile needs
a compiled worker bundle. A cron-pinged route was considered and rejected: it
cannot hold the concurrency bound or react promptly, and restarts would still
interrupt it.

**Media state machine**, persisted on a `media_jobs` row, one per
`(account_id, media_id)`:

```
pending -> downloading -> stored
              |  ^
              v  |
           retrying -> failed        (attempts exhausted)
              |
              v
          unavailable                (Meta says it is gone; never retried)
```

- 429: honour `Retry-After`, otherwise back off.
- 5xx, timeout, network: `retrying`.
- CDN URL 401, 403 or 404: re-resolve the URL once, then count as an attempt.
- Graph says the object is gone: `unavailable`.
- Token errors (190): pause rather than burn attempts, and alert.
- Verify the checksum when Meta provides one; a mismatch retries.
- After a successful download, keep the bytes in a temporary location so an
  upload retry does not download again.
- The message row is inserted **first** with a pending state, and the UI shows
  "processing" (fixes M2, M7). Bubble states are added for `unavailable` and
  `failed`.
- A one-time, rate-limited sweep enqueues unmirrored media still inside Meta's
  retention window. It needs your go-ahead, since it touches existing rows.

### Increment 3: storage (depends on D2)

`MediaStorage` interface with Supabase and R2 implementations. New objects are
keyed by account and media ID, so uploads stay idempotent. Private objects are
served through an authenticated route with short-lived signed URLs, never logged.
Existing rows keep working unchanged.

### Increment 4: outbound state machine (O1-O8)

```
queued -> sending -> sent -> delivered -> read
             |
             +-> failed
```

- **Persist first.** Insert `queued` with a client-generated idempotency key under
  a unique index, then send, then record the wamid. A repeated request returns the
  existing row rather than sending again.
- **Ambiguous sends.** A row stuck in `sending` is never resent automatically. It
  moves to `failed` with a `delivery_unknown` reason and asks an agent to decide.
- **Possible correlation.** **[External]** Meta's `biz_opaque_callback_data` may
  allow matching these rows from status webhooks. Verify before relying on it.
- **New columns:** HTTP status, Meta code, subcode, fbtrace ID, details, retry
  class, attempts, next retry time.
- **Classifier:** one pure function implementing D3, tested per code.
- **UI:** failures persist across reloads. A retry button appears only when the
  class allows it. 131049 shows a clear explanation and offers no retry.
- **Rollout across paths:** agent and public API sends first, then automations and
  flows, then broadcast including O8. The existing status ladder is extended, not
  replaced. Realtime reconciliation of the temporary bubble needs care, because
  the row now exists before the send.

### Increment 5: auth (A1-A6)

- Confirm the A1 cause from logs **before** changing anything.
- Narrow the middleware's work on `/api` routes so parallel requests do not all
  attempt a refresh, subject to what the logs show.
- Handle `refresh_token_not_found` explicitly: clear the session, show a
  re-authentication prompt with a return path, and preserve the unsent draft.
- Add `server-only` to the admin clients.

### Increment 6: observability

Structured JSON logger with a redaction allow-list that blocks tokens, signed URLs
and phone numbers. All Phase 6 metrics are derived from the new job and message
columns, exposed through a secret-protected internal endpoint and a dashboard card.
No metrics vendor is needed at this volume.

### Increment 7: deployment and documentation

Env var documentation, worker service setup, staging instructions, rollback plan,
production checklist, corrections to `docs/deployment-railway.md` (E4), and the
final verification report.

## Test map

All Meta and R2 calls are mocked. Each test ships with its increment.

| Required test                  | Increment | Location                                  |
| ------------------------------ | --------- | ----------------------------------------- |
| Media download 429             | 0, 2      | `meta-api.media.test.ts`, media job tests |
| Retry-After handling           | 2         | job runner tests                          |
| Expired media ID               | 2         | media job tests                           |
| Temporary URL expiry           | 2         | media job tests                           |
| R2 upload failure, no redownload | 3       | storage and media job tests               |
| Duplicate media processing     | 2         | media job tests                           |
| Worker restart recovery        | 2         | job runner tests                          |
| Duplicate webhook events       | 1         | `webhook/route.test.ts`                   |
| Outbound 131049                | 4         | classifier and status sync tests          |
| Outbound 131000                | 4         | classifier and send tests                 |
| Refresh token failure          | 5         | new `use-auth` tests                      |
| Concurrent session refresh     | 5         | `middleware.test.ts`                      |
| Duplicate outbound prevention  | 4         | `send-message.test.ts`                    |

SQL behaviour that mocks cannot prove (`SKIP LOCKED`, leases, unique indexes) needs
a real Postgres test. The Migrations workflow already runs a throwaway database and
can host it.

## Rollback

- Migrations are additive, so reverting code leaves the schema compatible.
- Each increment ships behind an env flag where behaviour changes
  (`WEBHOOK_DURABLE_INTAKE`, `MEDIA_JOBS_ENABLED`, `OUTBOUND_PERSIST_FIRST`), and
  turning one off restores the previous path.
- Stopping the worker service leaves jobs queued, and they resume on restart.
