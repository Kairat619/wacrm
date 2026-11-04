-- ============================================================
-- 060_message_media_id
--
-- Keeps Meta's media id on inbound messages. Until now it survived only
-- inside a proxy URL, so when the media lookup failed on arrival
-- `media_url` was NULL and the attachment could never be recovered, even
-- though Meta still held the bytes.
--
-- Additive and idempotent. Adding a nullable column with no default does
-- not rewrite the table. Must be applied BEFORE the matching code is
-- deployed, because the webhook writes this column on every insert.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_id TEXT;

COMMENT ON COLUMN messages.media_id IS
  'Meta media id for an inbound attachment. NULL for outbound messages, '
  'non-media messages and every row written before migration 060.';
