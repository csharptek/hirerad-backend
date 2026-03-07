import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => console.error("PG pool error:", err.message));

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL, domain TEXT, industry TEXT,
        employee_count INT, apollo_id TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
        job_title TEXT, job_url TEXT, posted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
        first_name TEXT, last_name TEXT, title TEXT, email TEXT,
        linkedin_url TEXT, apollo_id TEXT UNIQUE,
        email_verified BOOLEAN DEFAULT false,
        enriched_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
        job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        score INT DEFAULT 0, status TEXT DEFAULT 'pending',
        campaign_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS scrape_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status TEXT DEFAULT 'running', jobs_found INT DEFAULT 0,
        leads_qualified INT DEFAULT 0, error_msg TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS email_sequences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
        step INT DEFAULT 1, status TEXT DEFAULT 'draft',
        subject TEXT, body TEXT, sent_at TIMESTAMPTZ,
        opened_at TIMESTAMPTZ, replied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Database tables ready");
  } finally {
    client.release();
  }
}

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });

// ── Health ────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: true, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: "ok", db: false, error: err.message });
  }
});

// ── Apollo Proxy: Person Search ───────────────────────────────
app.post("/api/apollo/person", async (req, res) => {
  const apolloKey = req.headers["x-apollo-key"];
  if (!apolloKey) return res.status(400).json({ error: "Missing Apollo API key" });
  try {
    const response = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Apollo Proxy: Company Search ──────────────────────────────
app.post("/api/apollo/company", async (req, res) => {
  const apolloKey = req.headers["x-apollo-key"];
  if (!apolloKey) return res.status(400).json({ error: "Missing Apollo API key" });
  try {
    const orgRes = await fetch("https://api.apollo.io/v1/mixed_companies/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
      body: JSON.stringify({ q_organization_name: req.body.company_name, page: 1, per_page: 1 }),
    });
    const orgData = await orgRes.json();
    const org = orgData.organizations?.[0];
    if (!org) return res.status(404).json({ error: `Company "${req.body.company_name}" not found on Apollo` });

    const peopleRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
      body: JSON.stringify({
        organization_ids: [org.id],
        person_titles: ["founder","co-founder","ceo","cto","chief executive","chief technology","head of engineering","vp engineering"],
        page: 1, per_page: 5,
      }),
    });
    const peopleData = await peopleRes.json();
    const people = peopleData.people || [];
    if (!people.length) return res.status(404).json({ error: `No decision makers found at "${req.body.company_name}"` });

    res.json({
      org: { name: org.name, domain: org.website_url, employees: org.estimated_num_employees },
      people: people.map(p => ({
        name: `${p.first_name} ${p.last_name}`,
        title: p.title || "—",
        email: p.email,
        linkedin: p.linkedin_url,
        verified: !!p.email,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard ─────────────────────────────────────────────────
app.get("/api/dashboard", async (_req, res) => {
  try {
    const leads = await pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score>=2) AS qualified FROM leads");
    const emails = await pool.query("SELECT COUNT(*) AS sent FROM email_sequences WHERE status != 'draft'");
    const replies = await pool.query("SELECT COUNT(*) AS replied FROM email_sequences WHERE replied_at IS NOT NULL");
    res.json({
      leads_total: +leads.rows[0].total, leads_qualified: +leads.rows[0].qualified,
      emails_sent: +emails.rows[0].sent, open_rate: 0, replies: +replies.rows[0].replied,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leads ─────────────────────────────────────────────────────
app.get("/api/leads", async (req, res) => {
  const { status, min_score = 0, limit = 50, offset = 0 } = req.query;
  try {
    let q = `
      SELECT l.*, j.job_title, j.posted_at,
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Enrich ────────────────────────────────────────────────────
app.post("/api/leads/:id/enrich", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM leads WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Lead not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scrape ────────────────────────────────────────────────────
app.post("/api/scrape/run", async (req, res) => {
  try {
    const { rows } = await pool.query("INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id");
    res.json({ run_id: rows[0].id, status: "running" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/scrape/status/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM scrape_runs WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Campaign ──────────────────────────────────────────────────
app.post("/api/campaign/launch", async (req, res) => {
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || !lead_ids.length)
    return res.status(400).json({ error: "lead_ids array required" });
  res.json({ results: lead_ids.map(id => ({ leadId: id, status: "launched" })) });
});

// ── Start ─────────────────────────────────────────────────────
migrate()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`✅ HireRadar API running on port ${PORT}`));
  })
  .catch(err => { console.error("❌ Startup failed:", err.message); process.exit(1); });
