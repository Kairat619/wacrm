-- ============================================================
-- 061_webhook_events
--
-- Saves each verified WhatsApp webhook payload BEFORE Meta gets its 200.
-- Until now the payload lived only in memory during `after()`, so a crash or
-- deploy lost events Meta would never send again.
--
-- Additive and idempotent. The code only touches this table when
-- WEBHOOK_DURABLE_INTAKE=true, so apply this first, then set the flag.
--
-- Payloads contain customer messages and phone numbers: no role except the
-- service role can read this table, and the worker prunes old rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_hash TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_claimable
  ON public.webhook_events (next_attempt_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_webhook_events_prune
  ON public.webhook_events (status, created_at);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_events FROM anon, authenticated;

-- Claims due events, or one specific event when p_id is given. A `processing`
-- row whose lease has expired belonged to a process that died, so it is due.
-- SKIP LOCKED lets the route and the worker run this at once without either
-- blocking or claiming the same row.
CREATE OR REPLACE FUNCTION public.claim_webhook_events(
  p_limit INTEGER,
  p_lease_seconds INTEGER,
  p_max_attempts INTEGER,
  p_id UUID DEFAULT NULL
)
RETURNS SETOF public.webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A crash-looping payload must not be retried forever.
  UPDATE webhook_events
  SET status = 'failed',
      locked_until = NULL,
      last_error = COALESCE(last_error, 'lease expired on the final attempt')
  WHERE status = 'processing'
    AND locked_until < NOW()
    AND attempts >= p_max_attempts;

  RETURN QUERY
  UPDATE webhook_events e
  SET status = 'processing',
      attempts = e.attempts + 1,
      locked_until = NOW() + make_interval(secs => p_lease_seconds)
  FROM (
    SELECT id
    FROM webhook_events
    WHERE (p_id IS NULL OR id = p_id)
      AND (
        (status = 'pending' AND next_attempt_at <= NOW())
        OR (status = 'processing' AND locked_until < NOW())
      )
    ORDER BY next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) due
  WHERE e.id = due.id
  RETURNING e.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_events(INTEGER, INTEGER, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_webhook_events(INTEGER, INTEGER, INTEGER, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_webhook_events(INTEGER, INTEGER, INTEGER, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_events(INTEGER, INTEGER, INTEGER, UUID) TO service_role;
