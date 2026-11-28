-- 064: WhatsApp billing visibility.
--
-- Since 2026-10-01 Meta bills outbound service replies (after 1,000 free
-- per phone number per month), so every agent message has a cost. This
-- migration records what Meta tells us about each message and keeps a
-- daily snapshot of Meta's own cost figures for reconciliation.
--
--   1. messages.origin            — who/what produced an outbound row.
--   2. messages.pricing_*         — the `pricing` block from Meta's status
--                                   webhook (billable, category, type, model).
--   3. broadcast_recipients.pricing_* — same, for broadcast sends.
--   4. pending_message_statuses.pricing — early statuses keep their pricing.
--   5. whatsapp_billing_daily     — WABA pricing_analytics snapshots.
--   6. whatsapp_invoices          — manually entered monthly invoices.
--
-- Additive only; safe to apply before the code that uses it ships.

-- 1. Origin ------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS origin TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_origin_check'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_origin_check
      CHECK (origin IS NULL OR origin IN ('agent', 'api', 'automation', 'flow', 'ai'));
  END IF;
END $$;

-- Backfill what can be inferred. Automation vs flow bot rows are
-- indistinguishable historically, so they stay NULL.
UPDATE messages SET origin = 'ai'
  WHERE origin IS NULL AND sender_type = 'bot' AND ai_generated = true;
UPDATE messages SET origin = 'agent'
  WHERE origin IS NULL AND sender_type = 'agent' AND sender_id IS NOT NULL;
UPDATE messages SET origin = 'api'
  WHERE origin IS NULL AND sender_type = 'agent' AND sender_id IS NULL;

-- 2. Per-message pricing ------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_billable BOOLEAN,
  ADD COLUMN IF NOT EXISTS pricing_category TEXT,
  ADD COLUMN IF NOT EXISTS pricing_type TEXT,
  ADD COLUMN IF NOT EXISTS pricing_model TEXT,
  ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_outbound_created
  ON messages(created_at)
  WHERE sender_type <> 'customer';

-- 3. Broadcast recipients ------------------------------------------------
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS pricing_billable BOOLEAN,
  ADD COLUMN IF NOT EXISTS pricing_category TEXT,
  ADD COLUMN IF NOT EXISTS pricing_type TEXT,
  ADD COLUMN IF NOT EXISTS pricing_model TEXT,
  ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ;

-- 4. Early statuses -------------------------------------------------------
ALTER TABLE pending_message_statuses
  ADD COLUMN IF NOT EXISTS pricing JSONB;

-- 5. Meta pricing_analytics snapshots ------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_billing_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  waba_id TEXT NOT NULL,
  -- UTC day the data point starts on.
  day DATE NOT NULL,
  pricing_category TEXT NOT NULL,
  pricing_type TEXT NOT NULL,
  country TEXT NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  -- Meta reports cost in the WABA's billing currency.
  cost NUMERIC(12, 4) NOT NULL DEFAULT 0,
  currency TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_billing_daily_dims_key
    UNIQUE (account_id, waba_id, day, pricing_category, pricing_type, country)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_billing_daily_account_day
  ON whatsapp_billing_daily(account_id, day);

ALTER TABLE whatsapp_billing_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_billing_daily_select ON whatsapp_billing_daily;
CREATE POLICY whatsapp_billing_daily_select ON whatsapp_billing_daily FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- Writes come only from the service role (sync job).

-- 6. Invoices -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- First day of the invoiced month.
  month DATE NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_invoices_month_key UNIQUE (account_id, month),
  CONSTRAINT whatsapp_invoices_month_first_day CHECK (EXTRACT(DAY FROM month) = 1)
);

ALTER TABLE whatsapp_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_invoices_select ON whatsapp_invoices;
DROP POLICY IF EXISTS whatsapp_invoices_insert ON whatsapp_invoices;
DROP POLICY IF EXISTS whatsapp_invoices_update ON whatsapp_invoices;
DROP POLICY IF EXISTS whatsapp_invoices_delete ON whatsapp_invoices;
CREATE POLICY whatsapp_invoices_select ON whatsapp_invoices FOR SELECT
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_invoices_insert ON whatsapp_invoices FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_invoices_update ON whatsapp_invoices FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_invoices_delete ON whatsapp_invoices FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_invoices;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
