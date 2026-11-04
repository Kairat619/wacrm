-- ============================================================
-- 062_media_jobs
--
-- One durable job per inbound attachment, copying it from Meta into private
-- Cloudflare R2 storage. Survives restarts, retries with backoff, and records
-- its outcome instead of failing silently.
--
--   pending -> downloading -> stored
--                 |  ^
--                 v  |
--              retrying -> failed      (attempts used up, or too large)
--                 |
--                 v
--            unavailable               (Meta no longer has it; never retried)
--
-- `downloading` covers the upload step too, and also marks a claimed job.
-- Additive and idempotent. The code only touches this table when
-- MEDIA_JOBS_ENABLED=true.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.media_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  message_row_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  mime_type TEXT,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'downloading', 'stored', 'retrying', 'unavailable', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  storage_key TEXT,
  content_type TEXT,
  byte_size BIGINT,
  sha256 TEXT,
  last_error TEXT,
  last_http_status INTEGER,
  last_error_code INTEGER,
  rate_limit_hits INTEGER NOT NULL DEFAULT 0,
  download_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  -- This is what makes duplicate processing impossible: one media id, one job.
  CONSTRAINT media_jobs_account_media_key UNIQUE (account_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_media_jobs_claimable
  ON public.media_jobs (next_attempt_at)
  WHERE status IN ('pending', 'retrying', 'downloading');

CREATE INDEX IF NOT EXISTS idx_media_jobs_finished
  ON public.media_jobs (status, finished_at);

ALTER TABLE public.media_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_jobs FROM anon, authenticated;

-- A `downloading` row whose lease has expired belonged to a worker that died,
-- which is how unfinished jobs recover after a restart.
CREATE OR REPLACE FUNCTION public.claim_media_jobs(
  p_worker TEXT,
  p_limit INTEGER,
  p_lease_seconds INTEGER
)
RETURNS SETOF public.media_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE media_jobs
  SET status = 'failed',
      locked_by = NULL,
      locked_until = NULL,
      last_error = COALESCE(last_error, 'lease expired on the final attempt'),
      finished_at = NOW(),
      updated_at = NOW()
  WHERE status = 'downloading'
    AND locked_until < NOW()
    AND attempts >= max_attempts;

  RETURN QUERY
  UPDATE media_jobs j
  SET status = 'downloading',
      attempts = j.attempts + 1,
      locked_by = p_worker,
      locked_until = NOW() + make_interval(secs => p_lease_seconds),
      updated_at = NOW()
  FROM (
    SELECT id
    FROM media_jobs
    WHERE (status IN ('pending', 'retrying') AND next_attempt_at <= NOW())
       OR (status = 'downloading' AND locked_until < NOW())
    ORDER BY next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) due
  WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_media_jobs(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_media_jobs(TEXT, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_media_jobs(TEXT, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_media_jobs(TEXT, INTEGER, INTEGER) TO service_role;
