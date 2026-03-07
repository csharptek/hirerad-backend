/**
 * HireRadar Backend — Express + PostgreSQL
 * 
 * Endpoints:
 *   POST /api/scrape/run          — trigger Apify scrape
 *   GET  /api/scrape/status/:id   — poll run status
 *   GET  /api/leads               — list leads (filter/sort)
 *   POST /api/leads/:id/enrich    — enrich via Apollo
 *   POST /api/campaign/launch     — send to Instantly
 *   GET  /api/dashboard           — metrics
 *   GET  /api/health              — healthcheck
 */

import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import { apifyService }   from "./services/apify.js";
import { apolloService }  from "./services/apollo.js";
import { instantlyService } from "./services/instantly.js";
import { scoringService } from "./services/scoring.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

// ── DB Pool ──────────────────────────────────────────────────
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", (err) => console.error("PG pool error:", err));

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
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

// ── Dashboard metrics ────────────────────────────────────────
app.get("/api/dashboard", async (_req, res) => {
  try {
    const [leads, emails, replies] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE score>=2) AS qualified FROM leads"),
      pool.query("SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE status='opened') AS opened FROM email_sequences WHERE status != 'draft'"),
      pool.query("SELECT COUNT(*) AS replied FROM email_sequences WHERE replied_at IS NOT NULL"),
    ]);
    res.json({
      leads_total:    +leads.rows[0].total,
      leads_qualified: +leads.rows[0].qualified,
      emails_sent:    +emails.rows[0].sent,
      open_rate:      emails.rows[0].sent > 0 ? +(emails.rows[0].opened / emails.rows[0].sent * 100).toFixed(1) : 0,
      replies:        +replies.rows[0].replied,
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
             ct.email AS contact_email, ct.linkedin_url AS contact_linkedin, ct.email_verified
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

// ── Enrich single lead via Apollo ─────────────────────────────
app.post("/api/leads/:id/enrich", async (req, res) => {
  const { id } = req.params;
  try {
    // Get lead + company info
    const { rows } = await pool.query(
      `SELECT l.*, c.domain, c.name AS company_name FROM leads l JOIN companies c ON l.company_id = c.id WHERE l.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Lead not found" });
    const lead = rows[0];

    // Call Apollo
    const contact = await apolloService.enrichContact({ domain: lead.domain });
    if (!contact) return res.status(404).json({ error: "No contact found on Apollo" });

    // Upsert contact
    const { rows: ctRows } = await pool.query(
      `INSERT INTO contacts (company_id, first_name, last_name, title, email, linkedin_url, apollo_id, email_verified, enriched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (apollo_id) DO UPDATE SET email=EXCLUDED.email, enriched_at=NOW()
       RETURNING id`,
      [lead.company_id, contact.first_name, contact.last_name, contact.title,
       contact.email, contact.linkedin_url, contact.id, !!contact.email]
    );
    const contactId = ctRows[0].id;

    // Update lead
    const score = await scoringService.scoreLeadById(id, pool);
    await pool.query(
      `UPDATE leads SET contact_id=$1, score=$2, status='queued', updated_at=NOW() WHERE id=$3`,
      [contactId, score, id]
    );

    res.json({ success: true, contact, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trigger Apify scrape ──────────────────────────────────────
app.post("/api/scrape/run", async (req, res) => {
  try {
    // Insert run record
    const { rows } = await pool.query(
      `INSERT INTO scrape_runs (status) VALUES ('running') RETURNING id`
    );
    const runId = rows[0].id;

    // Start Apify async (don't await — respond immediately)
    apifyService.runScrape(runId, pool).catch((err) =>
      pool.query(`UPDATE scrape_runs SET status='failed', error_msg=$1 WHERE id=$2`, [err.message, runId])
    );

    res.json({ run_id: runId, status: "running" });
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

// ── Launch campaign for a lead ────────────────────────────────
app.post("/api/campaign/launch", async (req, res) => {
  const { lead_ids } = req.body; // array of lead UUIDs
  if (!Array.isArray(lead_ids) || !lead_ids.length)
    return res.status(400).json({ error: "lead_ids array required" });

  const results = [];
  for (const leadId of lead_ids) {
    try {
      const { rows } = await pool.query(
        `SELECT l.*, ct.email, ct.first_name, ct.last_name, c.name AS company_name
         FROM leads l JOIN contacts ct ON l.contact_id=ct.id JOIN companies c ON l.company_id=c.id
         WHERE l.id=$1 AND l.score >= 2`,
        [leadId]
      );
      if (!rows.length) { results.push({ leadId, status: "skipped", reason: "not found or low score" }); continue; }
      const lead = rows[0];

      const campaignResult = await instantlyService.addLeadToCampaign(lead);
      await pool.query(
        `UPDATE leads SET status='in_campaign', campaign_id=$1 WHERE id=$2`,
        [campaignResult.campaign_id, leadId]
      );
      results.push({ leadId, status: "launched", campaign_id: campaignResult.campaign_id });
    } catch (err) {
      results.push({ leadId, status: "error", reason: err.message });
    }
  }
  res.json({ results });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`HireRadar API running on :${PORT}`));
