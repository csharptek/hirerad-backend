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
    // Add columns if they don't exist (safe migration)
    await client.query(`ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS apify_run_id TEXT`);
    await client.query(`ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS params JSONB`);
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
  const apolloKey = req.headers["x-apollo-key"] || req.body?.apolloKey;

  // If contact already found by frontend, just save it
  if (req.body?.contact) {
    try {
      const { rows } = await pool.query(`
        SELECT l.*, c.name AS company_name, c.domain, l.company_id
        FROM leads l JOIN companies c ON l.company_id = c.id
        WHERE l.id = $1
      `, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "Lead not found" });
      const lead = rows[0];
      const p = req.body.contact;
      const mapped = {
        id: p.apollo_id || `fe_${Date.now()}`,
        first_name: p.name?.split(" ")[0] || p.first_name || "Unknown",
        last_name: p.name?.split(" ").slice(1).join(" ") || p.last_name || "",
        title: p.title,
        email: p.email,
        linkedin_url: p.linkedin || p.linkedin_url,
      };
      const enriched = await saveContactAndUpdateLead(lead, mapped, req.params.id);
      return res.json({ success: true, contact: enriched });
    } catch(err) {
      console.error("Save contact error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  try {
    // Get lead + company info
    const { rows } = await pool.query(`
      SELECT l.*, c.name AS company_name, c.domain
      FROM leads l JOIN companies c ON l.company_id = c.id
      WHERE l.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Lead not found" });
    const lead = rows[0];

    if (!apolloKey) {
      return res.status(400).json({ error: "Apollo API key required. Add it in Settings." });
    }

    console.log("Enriching:", lead.company_name);

    // Step 1: Find company by name to get org ID (same as working apollo/company proxy)
    const orgRes = await fetch("https://api.apollo.io/v1/mixed_companies/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
      body: JSON.stringify({ q_organization_name: lead.company_name, page: 1, per_page: 1 }),
    });
    const orgData = await orgRes.json();
    const org = orgData.organizations?.[0];
    console.log("Org lookup for:", lead.company_name, "→", org ? `found: ${org.name} (${org.id})` : `NOT FOUND. Total orgs: ${orgData.organizations?.length || 0}`);
    
    // If org not found by name, try fuzzy search with shorter name
    let finalOrg = org;
    if (!org) {
      const shortName = lead.company_name.split(" ").slice(0,2).join(" ");
      const retryRes = await fetch("https://api.apollo.io/v1/mixed_companies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
        body: JSON.stringify({ q_organization_name: shortName, page: 1, per_page: 1 }),
      });
      const retryData = await retryRes.json();
      finalOrg = retryData.organizations?.[0];
      console.log("Retry with short name:", shortName, "→", finalOrg ? `found: ${finalOrg.name}` : "still not found");
    }

    // Step 2: Search people by org ID with title filter
    let person = null;
    if (finalOrg?.id) {
      const peopleRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
        body: JSON.stringify({
          organization_ids: [finalOrg.id],
          person_titles: ["founder","co-founder","ceo","cto","chief executive","chief technology","head of engineering","vp engineering","vp of engineering","president","owner"],
          page: 1, per_page: 1,
        }),
      });
      const peopleData = await peopleRes.json();
      person = peopleData.people?.[0];
      console.log("With title filter:", peopleData.people?.length || 0, "people");
      if (peopleData.people?.[0]) console.log("RAW person:", JSON.stringify(peopleData.people[0]).slice(0, 600));

      // No results with title filter — try without filter (any person at company)
      if (!person) {
        const anyRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
          body: JSON.stringify({ organization_ids: [finalOrg.id], page: 1, per_page: 1 }),
        });
        const anyData = await anyRes.json();
        person = anyData.people?.[0];
        console.log("Without title filter:", anyData.people?.length || 0, "people | person:", person?.first_name, person?.title, person?.email);
      }
    }

    // Step 3: Fallback — search by company name without org ID
    if (!person) {
      const fallbackRes = await fetch("https://api.apollo.io/v1/mixed_people/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": apolloKey },
        body: JSON.stringify({ q_organization_name: lead.company_name, page: 1, per_page: 1 }),
      });
      const fallbackData = await fallbackRes.json();
      person = fallbackData.people?.[0];
      console.log("Name-only fallback:", fallbackData.people?.length || 0, "| person:", person?.first_name, person?.email);
    }

    if (!person) {
      return res.status(404).json({ error: `No decision maker found for "${lead.company_name}" on Apollo` });
    }

    const enriched = await saveContactAndUpdateLead(lead, person, req.params.id);
    res.json({ success: true, contact: { ...person, ...enriched } });

  } catch (err) {
    console.error("Enrich error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

async function saveContactAndUpdateLead(lead, person, leadId) {
  const apolloId = person.id || `manual_${Date.now()}_${leadId}`;
  
  // Extract name - Apollo sometimes puts full name in different fields
  const firstName = person.first_name || person.name?.split(" ")[0] || "Unknown";
  const lastName  = person.last_name  || person.name?.split(" ").slice(1).join(" ") || "";
  const email     = person.email || person.personal_email || person.work_email || null;
  const title     = person.title || person.headline || "Decision Maker";
  const linkedin  = person.linkedin_url || person.linkedin || null;

  let contactId;
  try {
    const { rows: ctRows } = await pool.query(`
      INSERT INTO contacts (company_id, first_name, last_name, title, email, linkedin_url, apollo_id, email_verified, enriched_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (apollo_id) DO UPDATE SET
        first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
        title=EXCLUDED.title, email=EXCLUDED.email, enriched_at=NOW()
      RETURNING id
    `, [lead.company_id, firstName, lastName, title, email, linkedin, apolloId, !!email]);
    contactId = ctRows[0].id;
  } catch(e) {
    const { rows } = await pool.query("SELECT id FROM contacts WHERE apollo_id=$1", [apolloId]);
    if (rows.length) { contactId = rows[0].id; } else { throw e; }
  }

  const score = email ? Math.max(lead.score || 0, 4) : (lead.score || 2);
  await pool.query(
    "UPDATE leads SET contact_id=$1, score=$2, status='queued', updated_at=NOW() WHERE id=$3",
    [contactId, score, leadId]
  );
  
  // Return enriched person data
  return { first_name: firstName, last_name: lastName, title, email, linkedin_url: linkedin };
}

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

    // Build one LinkedIn search URL per role and combine into startUrls
    const linkedinUrls = (roles || ["Software Engineer"]).map(role => {
      const encoded = encodeURIComponent(role);
      const loc = encodeURIComponent(country || "United States");
      return `https://www.linkedin.com/jobs/search/?keywords=${encoded}&location=${loc}&f_TPR=${f_TPR}&position=1&pageNum=0`;
    });

    console.log("LinkedIn URLs:", linkedinUrls);

    // Call Apify — send as plain string array (actor expects this format)
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs?token=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: linkedinUrls,
          count: 100,
          scrapeCompany: true,
          splitByLocation: false,
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
    let lastStatusData = null;
    while (apifyStatus === "RUNNING" && attempts < 40) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${apifyKey}`
      );
      lastStatusData = await statusRes.json();
      apifyStatus = lastStatusData.data?.status || "FAILED";
      const stats = lastStatusData.data?.stats || {};
      const itemsScraped = stats.itemCount || 0;
      console.log(`Apify run status: ${apifyStatus} · items: ${itemsScraped} (attempt ${attempts})`);
      // Update DB with live count so frontend can show progress
      await pool.query(
        "UPDATE scrape_runs SET jobs_found=$1 WHERE id=$2",
        [itemsScraped, runId]
      );
    }

    if (apifyStatus !== "SUCCEEDED") {
      // Fetch run log for debugging
      try {
        const logRes = await fetch(`https://api.apify.com/v2/actor-runs/${apifyRunId}/log?token=${apifyKey}`);
        const logText = await logRes.text();
        console.error("Apify run log:", logText.slice(0, 2000));
      } catch(e) {}
      const errMsg = `Apify run failed (status: ${apifyStatus}). Check Apify console: https://console.apify.com/actors/runs/${apifyRunId}`;
      console.error(errMsg);
      await pool.query(
        "UPDATE scrape_runs SET status='failed', error_msg=$1, completed_at=NOW() WHERE id=$2",
        [errMsg, runId]
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

        // Block well-known large companies that slip through without employee count
        const blockedCompanies = ["uber","google","microsoft","amazon","apple","meta","netflix","tata","cognizant","accenture","deloitte","ibm","oracle","salesforce","booz allen","kforce","randstad","robert half","dice","jobs via dice","talentally","remotehunter","hackajob","jobot","indeed","linkedin","staffing","solutions","recruiting","staffmark","manpower","adecco"];
        const companyLower = companyName.toLowerCase();
        if (blockedCompanies.some(b => companyLower.includes(b))) continue;

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
