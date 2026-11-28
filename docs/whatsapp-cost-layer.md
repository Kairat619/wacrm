# WhatsApp cost layer

Since 2026-10-01 Meta bills every outbound **service reply** past the first
1,000 per phone number per month. In Kazakhstan that is $0.018 per message
(marketing templates cost $0.0604). This layer shows where that money goes and
helps reps send fewer, more complete messages. Nothing in it blocks a send.

## Baseline (from Meta pricing analytics, read 2026-11-28)

| Month | Billed volume | Cost | Notes |
| --- | --- | --- | --- |
| Sep 2026 | 3,915 | $0.79 | Service replies still free |
| Oct 2026 | 10,351 | $166.53 | First month of paid service replies |
| Nov 1–28 | 19,751 | $361.57 | ≈ $385 for the full month; service replies are 92% |

From WaCRM's own messages for November:

- 20,051 outbound, all sent by human agents (no bot or AI sends).
- 36% (7,211) went out within 60 s of the previous outbound message with no
  customer message in between.
- 441 repeated a text already sent in the same chat within 24 h.
- 1,377 were voice notes.

Merging half of those back-to-back messages saves about $65/month at the
current rate.

## What ships

| Piece | Where |
| --- | --- |
| Pricing per message, from status webhooks (`billable`, `category`, `type`, `model`) | `src/lib/whatsapp/pricing.ts`, `message-status-sync.ts`, `broadcast-recipient-webhook.ts` |
| `messages.origin`: agent / api / automation / flow / ai | `src/lib/whatsapp/message-origin.ts`, send paths |
| Meta pricing analytics sync into `whatsapp_billing_daily` | `src/lib/billing/sync.ts`, `POST /api/billing/sync` |
| Cost page (admins): Meta cost, projection, per-agent split, invoice check | `/dashboard/costs`, RPC `message_cost_overview` |
| Quick replies with kk/ru language, `/shortcut`, `{{name}}` / `{{agent}}`, starter set | Settings → Quick replies, inbox composer |
| Duplicate and back-to-back nudges (beta per user) | `src/lib/inbox/send-nudges.ts`, composer |
| Product lookup from the SharapatSKLAD storefront (draft only) | composer `+` menu → Find product, `GET /api/products/search` |

## Rollout

1. In the Supabase SQL editor, apply in order:
   `064_message_billing.sql`, `065_message_cost_overview.sql`,
   `066_quick_reply_language.sql`. All three are additive and safe to re-run.
   **Apply them before deploying the code.** The status webhook writes the
   new columns, and the early-status replay reads `pending_message_statuses.pricing`.
2. Merge and deploy.
3. As an admin, open Dashboard → Costs. The first visit pulls Meta's numbers
   for this month and last. Enter the month's invoice to see the gap.
4. Settings → Quick replies → **Add starter replies**, then fill in the `___`
   placeholders and edit the texts to match how the team writes.
5. Turn on nudges for one rep first:

   ```sql
   update profiles
   set beta_features = array_append(beta_features, 'cost-nudges')
   where email = '<rep email>' and not ('cost-nudges' = any(beta_features));
   ```

   After two weeks, compare that rep's "per chat" and "back-to-back" columns
   on the cost page with the others, then enable it for everyone.

## Settings

- `SHARAPAT_CATALOG_URL`: storefront API base. It defaults to
  `https://sharapatsklad-bff.up.railway.app/api`; set it to `off` to hide
  results.
- The product lookup reads public storefront data only: name, SKU, price and
  storefront stock. Storefront stock can lag the warehouse, so the inserted
  line leaves stock out.

## Not done yet

- Screenshot → SKU (vision). The AI layer is text-only today (`ChatMessage.content`
  is a string). Adding it means image blocks in `src/lib/ai/types.ts` and the
  providers, plus reading the image bytes through `mediaStorageFromEnv()` or
  Meta's `downloadMedia`.
- Order-status links for customers. These need a public order page in
  SharapatSKLAD.
