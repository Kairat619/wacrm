# waCRM Reliability Verification Report

Date: 2026-11-04. Branch: `sync-upstream-b1`, on top of `58dda9d`.

**State of this work: implemented and tested locally. Not committed, not deployed,
and no migration has been applied anywhere. Nothing has run against real Meta, R2 or
Supabase, so no production problem can be called fixed yet.**

Finding IDs (W1, M1, O1...) refer to `WACRM_RELIABILITY_AUDIT.md`.

## What was run

| Check                | Result                                                     |
| -------------------- | ---------------------------------------------------------- |
| Test suite           | 1775 of 1775 passed, 3 runs in a row (baseline was 1544)   |
| Typecheck            | Clean                                                      |
| Lint                 | 0 errors. 39 warnings, against 40 before                   |
| `next build`         | Exit 0                                                     |
| `build:worker`       | Bundled. It started and logged `worker.started` with no flags on |
| Migration SQL        | 061-063 run on real Postgres through PGlite, on a stub schema |

## What has not been verified

Each of these needs doing before the matching flag is turned on in production.

| Not verified                         | Why                                                 | How to close it                                 |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| Real Meta API behaviour              | All Meta calls are mocked                           | Rollout steps in `docs/deployment-railway.md`   |
| **Real R2**                          | No credentials. Signing and URLs are only unit tested | Rollout step 3: upload, read, confirm private |
| Migrations on the full real schema   | PGlite uses a stub schema                           | The Migrations CI job replays all on Supabase, and now asserts 060-063 |
| Two workers competing for one job    | PGlite has one connection, so `SKIP LOCKED` under real contention is untested | Run two workers in staging, or rely on one replica |
| The Docker image                     | The Docker daemon wasn't running                    | Railway's build, or `docker build`              |
| Worker handling a real SIGTERM       | Windows can't deliver one. `stop()` is unit tested  | Redeploy the worker and read `worker.stopped`   |
| The inbox and login UI in a browser  | `.env.local` points at production, so it wasn't run | Rollout step 2, or staging                      |
| **The cause of each reported error** | No production logs or data were reachable           | `railway login` plus the probe in the audit     |

The last row matters most. `refresh_token_not_found` in particular has a fix built on
an unconfirmed cause: `auth.refresh_failed` will show whether it worked.

## Required tests

All external calls are mocked, except the SQL tests, which run on real Postgres.

| Required test                   | Result | Where                                                     |
| ------------------------------- | ------ | --------------------------------------------------------- |
| Media download 429              | Pass   | `media-jobs/process.test.ts`, `download-to-file.test.ts`  |
| Retry-After handling            | Pass   | `process.test.ts`, `meta-api.errors.test.ts`, `backoff.test.ts` |
| Expired media ID                | Pass   | `process.test.ts`, `meta-api.errors.test.ts`              |
| Temporary media URL expiration  | Pass   | `process.test.ts`                                         |
| R2 upload failure               | Pass   | `process.test.ts`, `r2-storage.test.ts`                   |
| Duplicate media processing      | Pass   | `job-sql.test.ts` (real unique constraint), `process.test.ts` |
| Worker restart recovery         | Pass   | `job-sql.test.ts` (real lease expiry), `worker/run.test.ts` |
| Duplicate webhook events        | Pass   | `webhook/route.durable.test.ts`, `job-sql.test.ts`, `route.test.ts` |
| Outbound 131049                 | Pass   | `outbound.test.ts`, `send-message.persist-first.test.ts`, retry route test |
| Outbound 131000                 | Pass   | `outbound.test.ts`, `send-message.persist-first.test.ts`  |
| Authentication refresh failure  | Pass   | `middleware.test.ts`                                      |
| Concurrent session refresh      | Pass   | `session-single-flight.test.ts`, `middleware.test.ts`     |
| Duplicate outbound prevention   | Pass   | `send-message.persist-first.test.ts`, `job-sql.test.ts`   |

**Test gap:** `use-auth.tsx`, the shell redirect, the login notice and the bubble's
retry button have no rendering tests, because the project has no DOM test setup. Their
logic was moved into tested helpers where practical.

**Flaky test:** one test failed in 1 of the first 18 full runs and hasn't recurred in
any run since. It is still unidentified, because that run's output was truncated. It
predates this work.

## Findings: status

| ID        | Finding                                  | Status                                                             |
| --------- | ---------------------------------------- | ------------------------------------------------------------------ |
| W1        | Nothing saved before the 200             | Built, behind `WEBHOOK_DURABLE_INTAKE`                             |
| W2        | Transient failure drops a message        | Failures now surface. Retried only with the flag on                |
| W3        | No drain period                          | Done: `drainingSeconds: 30`, a setting confirmed in Railway's schema |
| W4        | One throw abandons a batch               | Done                                                               |
| W5        | Effects after the insert aren't recoverable | **Not fixed, deliberately.** See below                          |
| M1        | Failed lookup loses the media ID         | Done                                                               |
| M2, M7    | Download blocks the message; replay redownloads | Timeouts done. The rest needs `MEDIA_JOBS_ENABLED`          |
| M3, M4, M5 | Silent fallback, size and MIME limits, no 429 handling | Proxy 429 done. The rest needs `MEDIA_JOBS_ENABLED`  |
| M6        | Each view costs Meta calls               | Needs `MEDIA_JOBS_ENABLED`                                         |
| M8        | Code 100 treated as expired              | Done                                                               |
| M9        | Files buffered in memory                 | Jobs stream to disk. The proxy's fallback path still buffers       |
| M10       | No checksum                              | Built, behind `MEDIA_JOBS_ENABLED`                                 |
| M11       | Customer media in a public bucket        | **New files only**, with the flag on. Existing files remain public |
| O1-O5, O7 | Agent and public API sends               | Built, behind `OUTBOUND_PERSIST_FIRST`. Structured logging and timeouts are live regardless |
| O6, O8    | Automations, flows, AI, broadcast        | **Not done.** See below                                            |
| A1        | Refresh token races                      | Built and always on. Cause unconfirmed                             |
| A2, A3, A4 | Blips, timer, re-auth UX                | Done                                                               |
| A5, A6    | `server-only`, `proxy.ts` rename         | **Skipped.** Low value; separate work                              |
| E1        | No metrics                               | Done: `/api/internal/reliability` and log events                   |
| E2        | Phone number in logs                     | Done, for that line. No full log audit was made                    |
| E4        | Stale deployment docs                    | Done                                                               |

## Known limits

- **Bot and broadcast sends aren't converted (O6, O8).** Automations, flows, AI replies
  and broadcasts still send first and insert after, so O1's crash window remains there,
  and they get no retry button. `outbound.engagement_limit` and `generic_failure` are
  still logged when their failures arrive by webhook. These paths need the same change,
  and it should be its own piece of work. O8 (a possible duplicate from resuming a
  broadcast) remains unverified.
- **Flows, automations and AI replies run at most once (W5).** If the process dies
  between saving a message and finishing them, they don't re-run. Re-running could send
  a customer the same bot message twice, and the brief ranks duplicates as the worse
  outcome. The message itself is kept.
- **Existing media isn't moved.** Files already in the public `chat-media` bucket stay
  public, and unmirrored files still expire. A one-time sweep needs your approval, since
  it changes existing rows and calls Meta for each file.
- **R2 objects outlive their rows.** Deleting a message or account removes the job row
  but not the R2 object. A clean-up isn't built.
- **Single-process assumptions.** Session sharing and the rate limiter work per process,
  which fits the current one replica.
- **Metrics are a JSON endpoint,** not the dashboard card the plan mentioned.

## Live on merge, even with every flag off

**Apply migration 060 before merging, or inbound messages will fail to save.**

- The webhook writes `messages.media_id`, keeps going after one bad message, and carries
  on storing text when a token can't be decrypted.
- Webhook code moved to `webhook-processor.ts`, unchanged in behaviour apart from these.
- Timeouts: 15s on media lookup, 60s on media download and on sends. A send that hits
  its limit shows as failed, though Meta may have accepted it.
- The media proxy returns 429 with `Retry-After` when throttled, and reports only real
  absence as expired.
- A Supabase outage no longer signs people out: pages stay put, and the API answers 503.
- Parallel requests in one session share one refresh check.
- A lost session reaches the login page with an explanation and a return path, and
  unsent text is kept per conversation for that tab.
- A slow session read waits 15 seconds rather than 3 before giving up.
- Media isn't deleted from storage after a network error on sending.
- Railway gets a 30-second drain, and every deploy takes up to that much longer.
