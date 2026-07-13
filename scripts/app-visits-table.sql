-- ============================================================
-- Track who opens the app (no-login mode shares one Supabase
-- account, so this is the only backend trail of who's using it)
-- Run once in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS app_visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE app_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can log a visit"
  ON app_visits FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_app_visits_display_name ON app_visits(display_name);
CREATE INDEX IF NOT EXISTS idx_app_visits_created_at ON app_visits(created_at);
