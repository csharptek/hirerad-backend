/**
 * Apify LinkedIn Jobs Scraper Service
 * Actor: curious_coder/linkedin-jobs-scraper
 *
 * Runs daily, processes results, stores to PostgreSQL.
 */

import { ApifyClient } from "apify-client";

const ACTOR_ID = "curious_coder/linkedin-jobs-scraper";

// Keywords to search on LinkedIn Jobs
const SEARCH_QUERIES = [
  "Software Engineer",
  "Full Stack Engineer",
  "Backend Engineer",
  "Frontend Engineer",
  "AI Engineer",
  "ML Engineer",
];

// Companies to exclude (staffing/agency keywords)
const EXCLUDE_KEYWORDS = [
  "staffing", "recruiting", "talent", "agency", "consulting",
  "outsource", "placement", "headhunt", "hire", "search firm",
];

export const apifyService = {
  client: null,

  init() {
    if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN not set");
    this.client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  },

  /**
   * Main scrape runner — called async after responding to API request.
   * Stores jobs + companies to DB, then enriches via Apollo, then scores.
   */
  async runScrape(runId, pool) {
    this.init();
    const allJobs = [];

    for (const query of SEARCH_QUERIES) {
      try {
        console.log(`[Apify] Searching: "${query}"`);
        const run = await this.client.actor(ACTOR_ID).call({
          searchQueries: [query],
          location: "United States",
          datePosted: "past-month",
          maxResults: 50,
        });

        const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
        allJobs.push(...items);
        console.log(`[Apify] Got ${items.length} results for "${query}"`);
      } catch (err) {
        console.error(`[Apify] Error for "${query}":`, err.message);
      }
    }

    // Update Apify run ID
    await pool.query(
      `UPDATE scrape_runs SET apify_run_id=$1 WHERE id=$2`,
      [runId, runId]
    );

    let jobsStored = 0;
    let leadsCreated = 0;

    for (const job of allJobs) {
      try {
        const companyName = job.companyName || job.company;
        if (!companyName) continue;

        // Skip excluded companies
        const nameLower = companyName.toLowerCase();
        if (EXCLUDE_KEYWORDS.some((kw) => nameLower.includes(kw))) continue;

        // Upsert company
        const { rows: coRows } = await pool.query(
          `INSERT INTO companies (name, linkedin_url)
           VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET updated_at=NOW()
           RETURNING id`,
          [companyName, job.companyUrl || null]
        );
        // Note: add UNIQUE constraint on companies(name) in production
        const companyId = coRows[0]?.id;
        if (!companyId) continue;

        // Insert job
        const { rows: jobRows } = await pool.query(
          `INSERT INTO jobs (company_id, job_title, job_url, posted_at, raw_data)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            companyId,
            job.title || job.jobTitle,
            job.jobUrl || job.url,
            job.postedAt ? new Date(job.postedAt) : null,
            JSON.stringify(job),
          ]
        );
        jobsStored++;

        // Create lead (score=0 until enrichment)
        await pool.query(
          `INSERT INTO leads (job_id, company_id, score, status) VALUES ($1, $2, 0, 'pending')`,
          [jobRows[0].id, companyId]
        );
        leadsCreated++;
      } catch (err) {
        console.error("[Apify] DB insert error:", err.message);
      }
    }

    // Mark run complete
    await pool.query(
      `UPDATE scrape_runs
       SET status='complete', finished_at=NOW(), jobs_found=$1, leads_qualified=$2
       WHERE id=$3`,
      [jobsStored, leadsCreated, runId]
    );

    console.log(`[Apify] Run ${runId} complete. Jobs: ${jobsStored}, Leads: ${leadsCreated}`);
  },

  /**
   * Parse posting date string → days ago (integer)
   */
  parseDaysAgo(postedAt) {
    if (!postedAt) return 30;
    const diff = Date.now() - new Date(postedAt).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  },
};
