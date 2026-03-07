-- ============================================================
-- HireRadar PostgreSQL Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Companies ────────────────────────────────────────────────
CREATE TABLE companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  domain        TEXT,
  linkedin_url  TEXT,
  employee_count INTEGER,
  industry      TEXT,
  is_excluded   BOOLEAN DEFAULT FALSE,  -- staffing/agency flag
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Jobs ─────────────────────────────────────────────────────
CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  job_title     TEXT NOT NULL,
  job_url       TEXT,
  posted_at     TIMESTAMPTZ,
  scraped_at    TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT DEFAULT 'linkedin',
  raw_data      JSONB
);

-- ── Contacts ─────────────────────────────────────────────────
CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  first_name    TEXT,
  last_name     TEXT,
  title         TEXT,
  email         TEXT,
  linkedin_url  TEXT,
  apollo_id     TEXT UNIQUE,
  email_verified BOOLEAN DEFAULT FALSE,
  enriched_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Leads ────────────────────────────────────────────────────
CREATE TABLE leads (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID REFERENCES jobs(id) ON DELETE CASCADE,
  company_id    UUID REFERENCES companies(id),
  contact_id    UUID REFERENCES contacts(id),
  score         INTEGER DEFAULT 0,
  score_breakdown JSONB,   -- {recency:2, ai_saas:1, has_contact:2}
  status        TEXT DEFAULT 'pending',
  -- pending | queued | in_campaign | replied | meeting | disqualified
  campaign_id   TEXT,      -- Instantly campaign ID
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Email Sequences ──────────────────────────────────────────
CREATE TABLE email_sequences (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id       UUID REFERENCES leads(id) ON DELETE CASCADE,
  step          INTEGER NOT NULL,  -- 1-4
  send_day      INTEGER NOT NULL,  -- 1,3,6,10
  subject       TEXT,
  body          TEXT,
  status        TEXT DEFAULT 'draft',  -- draft | scheduled | sent | opened | replied
  sent_at       TIMESTAMPTZ,
  opened_at     TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  instantly_email_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Scrape Runs ──────────────────────────────────────────────
CREATE TABLE scrape_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT DEFAULT 'running',  -- running | complete | failed
  jobs_found    INTEGER DEFAULT 0,
  leads_qualified INTEGER DEFAULT 0,
  contacts_enriched INTEGER DEFAULT 0,
  apify_run_id  TEXT,
  error_msg     TEXT
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX idx_jobs_company ON jobs(company_id);
CREATE INDEX idx_jobs_posted ON jobs(posted_at DESC);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_score ON leads(score DESC);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_email_seq_lead ON email_sequences(lead_id);

-- ── Updated-at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_leads_updated     BEFORE UPDATE ON leads     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
