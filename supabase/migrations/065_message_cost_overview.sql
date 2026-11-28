-- 065: message_cost_overview(p_month, p_tz) — data for the WhatsApp cost page.
--
-- Returns one JSON object for a calendar month (in p_tz):
--   meta      Meta's own volume/cost from whatsapp_billing_daily (064),
--             by category/type/country, plus currency and last sync time.
--   invoice   The manually entered invoice for the month, if any.
--   origins   Outbound message counts by messages.origin.
--   agents    Per sender: outbound, conversations, "burst" messages (sent
--             < 60 s after the previous outbound with no customer message
--             between), repeated texts within 24 h, voice notes, media,
--             billable count from Meta's per-message pricing, deals won.
--   daily     Per local day: outbound, bursts, Meta volume and cost.
--
-- Admin-only, account-scoped by the caller's profile. Read-only.

CREATE OR REPLACE FUNCTION public.message_cost_overview(
  p_month DATE,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_tz TEXT := 'UTC';
  v_month DATE;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_result JSONB;
BEGIN
  SELECT p.account_id INTO v_account
  FROM profiles p
  WHERE p.user_id = auth.uid();

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'caller is not a member of an account' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  IF p_tz IS NOT NULL THEN
    BEGIN
      PERFORM now() AT TIME ZONE p_tz;
      v_tz := p_tz;
    EXCEPTION WHEN invalid_parameter_value THEN
      v_tz := 'UTC';
    END;
  END IF;

  v_month := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE v_tz)::date))::date;
  v_start := v_month::timestamp AT TIME ZONE v_tz;
  v_end := (v_month + interval '1 month')::timestamp AT TIME ZONE v_tz;

  WITH msgs AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.origin,
      m.content_type,
      m.status,
      m.pricing_billable,
      m.created_at,
      lower(regexp_replace(btrim(COALESCE(m.content_text, '')), '\s+', ' ', 'g')) AS norm_text
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account
      AND m.created_at >= v_start
      AND m.created_at < v_end
  ),
  ordered AS (
    SELECT
      msgs.*,
      lag(sender_type) OVER w AS prev_sender_type,
      lag(created_at) OVER w AS prev_created_at
    FROM msgs
    WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
  ),
  outbound_base AS (
    SELECT
      o.*,
      (o.prev_sender_type IS NOT NULL
        AND o.prev_sender_type <> 'customer'
        AND o.created_at - o.prev_created_at < interval '60 seconds') AS is_burst,
      lag(o.created_at) OVER (
        PARTITION BY o.conversation_id, o.norm_text
        ORDER BY o.created_at, o.id
      ) AS prev_same_text_at
    FROM ordered o
    WHERE o.sender_type <> 'customer'
      AND o.status IS DISTINCT FROM 'failed'
  ),
  outbound AS (
    SELECT
      b.*,
      (length(b.norm_text) > 3
        AND b.prev_same_text_at IS NOT NULL
        AND b.created_at - b.prev_same_text_at < interval '24 hours') AS is_repeat
    FROM outbound_base b
  ),
  agent_stats AS (
    SELECT
      sender_id,
      count(*) AS outbound,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE is_burst) AS bursts,
      count(*) FILTER (WHERE is_repeat) AS repeats,
      count(*) FILTER (WHERE content_type = 'audio') AS voice_notes,
      count(*) FILTER (WHERE content_type IN ('image', 'video', 'document')) AS media,
      count(*) FILTER (WHERE content_type = 'template') AS templates,
      count(*) FILTER (WHERE pricing_billable IS TRUE) AS billable,
      count(*) FILTER (WHERE pricing_billable IS NOT NULL) AS priced
    FROM outbound
    WHERE sender_type = 'agent' AND sender_id IS NOT NULL
    GROUP BY sender_id
  ),
  won AS (
    SELECT d.assigned_to AS user_id, count(*) AS deals_won, sum(d.value) AS won_value
    FROM deals d
    WHERE d.account_id = v_account
      AND d.status = 'won'
      AND d.closed_at >= v_start
      AND d.closed_at < v_end
      AND d.assigned_to IS NOT NULL
    GROUP BY d.assigned_to
  ),
  billing AS (
    SELECT *
    FROM whatsapp_billing_daily b
    WHERE b.account_id = v_account
      AND b.day >= v_month
      AND b.day < (v_month + interval '1 month')::date
  ),
  days AS (
    SELECT d::date AS day
    FROM generate_series(v_month, (v_month + interval '1 month' - interval '1 day')::date, interval '1 day') AS d
  )
  SELECT jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM-DD'),
    'timezone', v_tz,
    'meta', jsonb_build_object(
      'volume', COALESCE((SELECT sum(volume) FROM billing), 0),
      'cost', COALESCE((SELECT sum(cost) FROM billing), 0),
      'currency', (SELECT max(currency) FROM billing),
      'fetchedAt', (SELECT max(fetched_at) FROM billing),
      'breakdown', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'category', pricing_category,
          'type', pricing_type,
          'country', country,
          'volume', v,
          'cost', c
        ) ORDER BY c DESC, v DESC)
        FROM (
          SELECT pricing_category, pricing_type, country, sum(volume) AS v, sum(cost) AS c
          FROM billing
          GROUP BY 1, 2, 3
        ) g
      ), '[]'::jsonb)
    ),
    'invoice', (
      SELECT jsonb_build_object('amount', i.amount, 'currency', i.currency, 'note', i.note)
      FROM whatsapp_invoices i
      WHERE i.account_id = v_account AND i.month = v_month
    ),
    'outbound', jsonb_build_object(
      'total', (SELECT count(*) FROM outbound),
      'bursts', (SELECT count(*) FROM outbound WHERE is_burst),
      'repeats', (SELECT count(*) FROM outbound WHERE is_repeat),
      'conversations', (SELECT count(DISTINCT conversation_id) FROM outbound)
    ),
    'origins', COALESCE((
      SELECT jsonb_object_agg(k, n)
      FROM (
        SELECT COALESCE(origin, CASE WHEN sender_type = 'agent' THEN 'agent' ELSE 'unknown' END) AS k,
               count(*) AS n
        FROM outbound
        GROUP BY 1
      ) g
    ), '{}'::jsonb),
    'agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'userId', a.sender_id,
        'name', p.full_name,
        'avatarUrl', p.avatar_url,
        'outbound', a.outbound,
        'conversations', a.conversations,
        'bursts', a.bursts,
        'repeats', a.repeats,
        'voiceNotes', a.voice_notes,
        'media', a.media,
        'templates', a.templates,
        'billable', a.billable,
        'priced', a.priced,
        'dealsWon', COALESCE(w.deals_won, 0),
        'wonValue', COALESCE(w.won_value, 0)
      ) ORDER BY a.outbound DESC)
      FROM agent_stats a
      LEFT JOIN profiles p ON p.user_id = a.sender_id
      LEFT JOIN won w ON w.user_id = a.sender_id
    ), '[]'::jsonb),
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'day', to_char(d.day, 'YYYY-MM-DD'),
        'outbound', COALESCE(o.n, 0),
        'bursts', COALESCE(o.b, 0),
        'metaVolume', COALESCE(bd.v, 0),
        'metaCost', COALESCE(bd.c, 0)
      ) ORDER BY d.day)
      FROM days d
      LEFT JOIN (
        SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS n, count(*) FILTER (WHERE is_burst) AS b
        FROM outbound GROUP BY 1
      ) o ON o.day = d.day
      LEFT JOIN (
        SELECT day, sum(volume) AS v, sum(cost) AS c FROM billing GROUP BY 1
      ) bd ON bd.day = d.day
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.message_cost_overview(DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.message_cost_overview(DATE, TEXT) TO authenticated;
