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
        status TEXT DEFAULT 'running',
        jobs_found INT DEFAULT 0,
        leads_qualified INT DEFAULT 0,
        apify_run_id TEXT,
        error_msg TEXT,
        params JSONB,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
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

// ── Apollo Proxy: Person ──────────────────────────────────────
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

// ── Apollo Proxy: Company ─────────────────────────────────────
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
        person_titles: ["founder","co-founder","ceo","cto","chief executive","chief technology","head of engineering","vp engineering","vp of engineering","president"],
        page: 1, per_page: 5,
      }),
    });
    const peopleData = await peopleRes.json();
    const people = peopleData.people || [];
    if (!people.length) return res.status(404).json({ error: `No decision makers found at "${req.body.company_name}". Try searching by person name instead.` });

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
    const leads  = await pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score>=2) AS qualified FROM leads");
    const emails = await pool.query("SELECT COUNT(*) AS sent FROM email_sequences WHERE status != 'draft'");
    const replies= await pool.query("SELECT COUNT(*) AS replied FROM email_sequences WHERE replied_at IS NOT NULL");
    res.json({
      leads_total:     +leads.rows[0].total,
      leads_qualified: +leads.rows[0].qualified,
      emails_sent:     +emails.rows[0].sent,
      open_rate: 0,
      replies:         +replies.rows[0].replied,
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

// ── Clear database ────────────────────────────────────────────
app.delete("/api/leads/clear", async (_req, res) => {
  try {
    await pool.query("DELETE FROM email_sequences");
    await pool.query("DELETE FROM leads");
    await pool.query("DELETE FROM contacts");
    await pool.query("DELETE FROM jobs");
    await pool.query("DELETE FROM companies");
    await pool.query("DELETE FROM scrape_runs");
    res.json({ success: true });
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

// ── Scrape: trigger Apify actor ───────────────────────────────
app.post("/api/scrape/run", async (req, res) => {
  const { country, companySize, postedWithin, roles, apifyKey } = req.body;
  const key = apifyKey || process.env.APIFY_API_TOKEN;

  if (!key) {
    // No Apify key — create a dummy run so frontend can still poll
    const { rows } = await pool.query(
      "INSERT INTO scrape_runs (status, error_msg) VALUES ('failed', 'No Apify API token provided') RETURNING id"
    );
    return res.json({ run_id: rows[0].id, status: "failed", error: "No Apify API token. Add it in Settings." });
  }

  try {
    // Map posted within days to LinkedIn filter
    const dateMap = { 1:"r86400", 3:"r259200", 7:"r604800", 14:"r1209600", 30:"r2592000" };
    const f_TPR = dateMap[postedWithin] || "r2592000";

    // Build search keywords from roles
    const keywords = (roles || ["Software Engineer"]).join(" OR ");

    // Build LinkedIn search URLs from parameters
    const linkedinUrls = (roles || ["Software Engineer"]).map(role => {
      const params = new URLSearchParams({
        keywords: role,
        location: country || "United States",
        f_TPR,
        f_TP: "1",       // Full-time
        position: "1",
        pageNum: "0",
      });
      return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
    });

    console.log("LinkedIn URLs:", linkedinUrls);

    // Call Apify LinkedIn Jobs Scraper
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs?token=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: linkedinUrls,
          count: 50,
          scrapeCompany: true,
          proxy: { useApifyProxy: true },
        }),
      }
    );

    const apifyData = await apifyRes.json();
    console.log("Apify response:", JSON.stringify(apifyData).slice(0, 500));

    if (!apifyRes.ok || apifyData.error) {
      throw new Error(apifyData.error?.message || apifyData.message || `Apify error: ${JSON.stringify(apifyData).slice(0,200)}`);
    }

    const apifyRunId = apifyData.data?.id || apifyData.id;

    // Save run to DB
    const { rows } = await pool.query(
      "INSERT INTO scrape_runs (status, apify_run_id, params) VALUES ('running', $1, $2) RETURNING id",
      [apifyRunId, JSON.stringify({ country, companySize, postedWithin, roles })]
    );
    const runId = rows[0].id;

    // Process results in background
    processApifyRun(runId, apifyRunId, key, companySize, "curious_coder~linkedin-jobs-scraper").catch(console.error);

    res.json({ run_id: runId, apify_run_id: apifyRunId, status: "running" });

  } catch (err) {
    console.error("Scrape error:", err.message);
    const { rows } = await pool.query(
      "INSERT INTO scrape_runs (status, error_msg) VALUES ('failed', $1) RETURNING id",
      [err.message]
    );
    res.status(500).json({ run_id: rows[0].id, error: err.message });
  }
});

// ── Background: poll Apify and save results ───────────────────
async function processApifyRun(runId, apifyRunId, apifyKey, companySize, actor="curious_coder~linkedin-jobs-scraper") {
  try {
    // Poll until Apify run completes
    let apifyStatus = "RUNNING";
    let attempts = 0;
    while (apifyStatus === "RUNNING" && attempts < 40) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${apifyKey}`
      );
      const statusData = await statusRes.json();
      apifyStatus = statusData.data?.status || "FAILED";
      console.log(`Apify run ${apifyRunId} status: ${apifyStatus}`);
    }

    if (apifyStatus !== "SUCCEEDED") {
      await pool.query(
        "UPDATE scrape_runs SET status='failed', error_msg=$1, completed_at=NOW() WHERE id=$2",
        [`Apify run ended with status: ${apifyStatus}`, runId]
      );
      return;
    }

    // Fetch results from Apify dataset
    const dataRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${apifyRunId}/dataset/items?token=${apifyKey}&limit=200`
    );
    const jobs = await dataRes.json();
    console.log(`Got ${jobs.length} jobs from Apify`);

    // Parse company size filter
    let maxEmployees = 9;
    if (companySize?.includes("50")) maxEmployees = 50;
    if (companySize?.includes("200")) maxEmployees = 200;
    if (companySize?.includes("Any")) maxEmployees = 99999;

    let jobsFound = 0;
    let leadsQualified = 0;

    for (const job of jobs) {
      try {
        // curious_coder actor field names
        const companyName = job.companyName || job.company || job.hiringOrganization?.name || "Unknown";
        const jobTitle    = job.title || job.jobTitle || job.position || "Unknown";
        const jobUrl      = job.jobUrl || job.url || job.applyUrl || null;
        const postedAt    = job.postedAt || job.datePosted || job.publishedAt || null;
        const industry    = job.companyIndustry || job.industry || "Unknown";
        const rawSize     = job.companySize || job.employeeCount || "";
        const empCount    = parseInt(String(rawSize).replace(/[^0-9]/g, "")) || null;
        const domain      = job.companyUrl
          ? job.companyUrl.replace(/https?:\/\/(www\.)?/, "").split("/")[0]
          : job.companyWebsite?.replace(/https?:\/\/(www\.)?/, "").split("/")[0] || null;

        // Filter by company size
        if (empCount && empCount > maxEmployees) continue;

        // Upsert company
        const { rows: compRows } = await pool.query(
          `INSERT INTO companies (name, domain, industry, employee_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [companyName, domain, industry, empCount]
        );

        let companyId = compRows[0]?.id;
        if (!companyId) {
          const existing = await pool.query("SELECT id FROM companies WHERE name=$1", [companyName]);
          companyId = existing.rows[0]?.id;
        }
        if (!companyId) continue;

        // Insert job
        const { rows: jobRows } = await pool.query(
          `INSERT INTO jobs (company_id, job_title, job_url, posted_at)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [companyId, jobTitle, jobUrl, postedAt ? new Date(postedAt) : null]
        );
        const jobId = jobRows[0]?.id;
        if (!jobId) continue;

        jobsFound++;

        // Score the lead
        let score = 0;
        const daysAgo = postedAt ? (Date.now() - new Date(postedAt)) / 864e5 : 30;
        if (daysAgo <= 7)  score += 2;
        else if (daysAgo <= 14) score += 1;
        const ind = industry.toLowerCase();
        if (ind.includes("software") || ind.includes("saas") || ind.includes("ai") || ind.includes("tech")) score += 1;
        if (empCount && empCount <= 9) score += 1;

        // Insert lead
        await pool.query(
          `INSERT INTO leads (company_id, job_id, score, status) VALUES ($1,$2,$3,$4)`,
          [companyId, jobId, score, score >= 2 ? "queued" : "low-score"]
        );

        if (score >= 2) leadsQualified++;

      } catch (itemErr) {
        console.error("Error processing job:", itemErr.message);
      }
    }

    await pool.query(
      "UPDATE scrape_runs SET status='complete', jobs_found=$1, leads_qualified=$2, completed_at=NOW() WHERE id=$3",
      [jobsFound, leadsQualified, runId]
    );
    console.log(`✅ Run ${runId} complete: ${jobsFound} jobs, ${leadsQualified} leads`);

  } catch (err) {
    console.error("processApifyRun error:", err.message);
    await pool.query(
      "UPDATE scrape_runs SET status='failed', error_msg=$1, completed_at=NOW() WHERE id=$2",
      [err.message, runId]
    );
  }
}

// ── Scrape status ─────────────────────────────────────────────
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
