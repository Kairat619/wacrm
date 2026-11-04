-- ============================================================
-- 063_outbound_state_machine
--
-- Saves an outbound message BEFORE calling Meta, so a send can't reach a
-- customer without leaving a record, and a failure survives a page reload.
--
--   queued -> sending -> sent -> delivered -> read
--                |
--                +-> failed
--
-- retry_class says what may happen after a failure:
--   auto              the worker retries, at most twice
--   manual            an agent may retry
--   no_retry          retrying can't help (e.g. 131049)
--   delivery_unknown  Meta may have delivered it; never retried automatically,
--                     and an agent has to choose to risk a duplicate
--
-- Additive. The code only uses this when OUTBOUND_PERSIST_FIRST=true. The status
-- constraint is swapped using NOT VALID then VALIDATE, which avoids holding a
-- write-blocking lock while existing rows are checked.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_request_id TEXT,
  ADD COLUMN IF NOT EXISTS send_params JSONB,
  ADD COLUMN IF NOT EXISTS send_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sending_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_class TEXT,
  ADD COLUMN IF NOT EXISTS error_http_status INTEGER,
  ADD COLUMN IF NOT EXISTS error_subcode INTEGER,
  ADD COLUMN IF NOT EXISTS error_fbtrace_id TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_retry_class_check;
ALTER TABLE messages ADD CONSTRAINT messages_retry_class_check
  CHECK (retry_class IN ('auto', 'manual', 'no_retry', 'delivery_unknown')) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_retry_class_check;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_allowed;
ALTER TABLE messages ADD CONSTRAINT messages_status_allowed
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_status_allowed;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;

-- Duplicate-send protection. A plain unique index so PostgREST's ON CONFLICT
-- can use it; NULLs stay distinct, so rows with no request id never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_request
  ON messages (conversation_id, client_request_id);

CREATE INDEX IF NOT EXISTS idx_messages_due_retry
  ON messages (next_retry_at)
  WHERE status = 'queued' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_stuck_sending
  ON messages (sending_since)
  WHERE status = 'sending' AND sending_since IS NOT NULL;

-- Moves due retries to `sending` and returns what's needed to send them.
CREATE OR REPLACE FUNCTION public.claim_outbound_retries(p_limit INTEGER)
RETURNS TABLE (
  id UUID,
  account_id UUID,
  send_params JSONB,
  send_attempts INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH due AS (
    SELECT m.id
    FROM messages m
    WHERE m.status = 'queued'
      AND m.next_retry_at IS NOT NULL
      AND m.next_retry_at <= NOW()
    ORDER BY m.next_retry_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE messages m
    SET status = 'sending',
        sending_since = NOW(),
        next_retry_at = NULL,
        send_attempts = m.send_attempts + 1
    FROM due
    WHERE m.id = due.id
    RETURNING m.id, m.conversation_id, m.send_params, m.send_attempts
  )
  SELECT c.id, conv.account_id, c.send_params, c.send_attempts
  FROM claimed c
  JOIN conversations conv ON conv.id = c.conversation_id;
$$;

-- A row still `sending` after this long had a process die mid-send, so Meta may
-- or may not have accepted it. It is flagged for a person, never resent.
CREATE OR REPLACE FUNCTION public.flag_stuck_outbound(p_older_than_seconds INTEGER)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH flagged AS (
    UPDATE messages
    SET status = 'failed',
        retry_class = 'delivery_unknown',
        error_title = 'Delivery unknown',
        sending_since = NULL
    WHERE status = 'sending'
      AND sending_since < NOW() - make_interval(secs => p_older_than_seconds)
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM flagged;
$$;

REVOKE ALL ON FUNCTION public.claim_outbound_retries(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_outbound_retries(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_outbound_retries(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outbound_retries(INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.flag_stuck_outbound(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.flag_stuck_outbound(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.flag_stuck_outbound(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.flag_stuck_outbound(INTEGER) TO service_role;
