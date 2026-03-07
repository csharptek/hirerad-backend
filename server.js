import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

// ── DB Pool ──────────────────────────────────────────────────
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Auto-migrate ─────────────────────────────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      employee_count INT,
      linkedin_url TEXT,
      apollo_id TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID REFERENCES companies(id),
      job_title TEXT,
      job_url TEXT,
      location TEXT,
      posted_at TIMESTAMPTZ,
      raw_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID REFERENCES companies(id),
      first_name TEXT,
      last_name TEXT,
      title TEXT,
      email TEXT,
      linkedin_url TEXT,
      apollo_id TEXT UNIQUE,
      email_verified BOOLEAN DEFAULT false,
      enriched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID REFERENCES companies(id),
      job_id UUID REFERENCES jobs(id),
      contact_id UUID REFERENCES contacts(id),
      score INT DEFAULT 0,
      status TEXT DEFAULT 'pending',
      campaign_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT DEFAULT 'running',
      jobs_found INT DEFAULT 0,
      leads_qualified INT DEFAULT 0,
      error_msg TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS email_sequences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id),
      step INT DEFAULT 1,
      status TEXT DEFAULT 'draft',
      subject TEXT,
      body TEXT,
      sent_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database tables ready");
}

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── Health ───────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const dbOk = await pool.query("SELECT 1").then(() => true).catch(() => false);
  res.json({ status: "ok", db: dbOk, timestamp: new Date().toISOString() });
});

// ── Dashboard ────────────────────────────────────────────────
app.get("/api/dashboard", async (_req, res) => {
  try {
    const [leads, emails, replies] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score>=2) AS qualified FROM leads"),
      pool.query("SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE status='opened') AS opened FROM email_sequences WHERE status != 'draft'"),
      pool.query("SELECT COUNT(*) AS replied FROM email_sequences WHERE replied_at IS NOT NULL"),
    ]);
    res.json({
      leads_total:     +leads.rows[0].total,
      leads_qualified: +leads.rows[0].qualified,
      emails_sent:     +emails.rows[0].sent,
      open_rate:       emails.rows[0].sent > 0 ? +(emails.rows[0].opened / emails.rows[0].sent * 100).toFixed(1) : 0,
      replies:         +replies.rows[0].replied,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leads ────────────────────────────────────────────────────
app.get("/api/leads", async (req, res) => {
  const { status, min_score = 0, limit = 50, offset = 0 } = req.query;
  try {
    let q = `
      SELECT l.*, j.job_title, j.job_url, j.posted_at,
             c.name AS company_name, c.domain, c.industry, c.employee_count,
             ct.first_name, ct.last_name, ct.title AS contact_title,
             ct.email AS contact_email, ct.linkedin_url, ct.email_verified
      FROM leads l
      JOIN jobs j ON l.job_id = j.id
      JOIN companies c ON l.company_id = c.id
      LEFT JOIN contacts ct ON l.contact_id = ct.id
      WHERE l.score >= $1
    `;
    const params = [+min_score];
    if (status) { params.push(status); q += ` AND l.status = $${params.length}`; }
    q += ` ORDER BY l.score DESC, l.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(+limit, +offset);
    const { rows } = await pool.query(q, params);
    res.json({ leads: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Enrich lead ───────────────────────────────────────────────
app.post("/api/leads/:id/enrich", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT l.*, c.domain, c.name AS company_name FROM leads l JOIN companies c ON l.company_id = c.id WHERE l.id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Lead not found" });
    res.json({ success: true, message: "Enrichment triggered" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scrape ────────────────────────────────────────────────────
app.post("/api/scrape/run", async (req, res) => {
  try {
    const { rows } = await pool.query(`INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id`);
    res.json({ run_id: rows[0].id, status: "running" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scrape/status/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM scrape_runs WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Run not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign ──────────────────────────────────────────────────
app.post("/api/campaign/launch", async (req, res) => {
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || !lead_ids.length)
    return res.status(400).json({ error: "lead_ids array required" });
  const results = lead_ids.map(id => ({ leadId: id, status: "launched" }));
  res.json({ results });
});

// ── Start ─────────────────────────────────────────────────────
migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ HireRadar API running on :${PORT}`));
  })
  .catch(err => {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  });
