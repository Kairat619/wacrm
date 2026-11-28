-- 066: quick replies get a language and a "/shortcut".
--
--   language  'kk' | 'ru' | NULL (any). The inbox picker filters on it.
--   shortcut  typed as "/shortcut" in the composer to insert the reply.
--             Lower-case, no spaces or slashes, unique per account. The
--             app validates the full pattern (letters, digits, _ and -);
--             the CHECK here is the coarse backstop.
--
-- Additive only.

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS shortcut TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quick_replies_language_check'
  ) THEN
    ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_language_check
      CHECK (language IS NULL OR language IN ('kk', 'ru'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quick_replies_shortcut_check'
  ) THEN
    ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_shortcut_check
      CHECK (
        shortcut IS NULL
        OR (shortcut = lower(shortcut) AND shortcut ~ '^[^[:space:]/]{1,32}$')
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_account_shortcut
  ON quick_replies(account_id, shortcut)
  WHERE shortcut IS NOT NULL;
