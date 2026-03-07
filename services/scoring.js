/**
 * Lead Scoring Engine
 *
 * Rules:
 *   +2  posted within 7 days
 *   +1  posted within 14 days
 *   +1  AI / SaaS company
 *   +2  verified decision-maker contact found
 *
 * Min score to dispatch: 2
 */

const AI_SAAS_KEYWORDS = ["ai", "saas", "ml", "machine learning", "artificial intelligence", "data", "cloud", "api", "platform"];

export const scoringService = {
  /**
   * Score a lead object directly (no DB needed)
   */
  scoreLeadObject({ postedAt, industry = "", hasVerifiedContact = false }) {
    let score = 0;
    const breakdown = {};

    // Recency
    const daysAgo = postedAt
      ? Math.floor((Date.now() - new Date(postedAt).getTime()) / 86400000)
      : 30;

    if (daysAgo <= 7)       { score += 2; breakdown.recency = 2; }
    else if (daysAgo <= 14) { score += 1; breakdown.recency = 1; }
    else                    { breakdown.recency = 0; }

    // AI / SaaS
    const industryLower = industry.toLowerCase();
    if (AI_SAAS_KEYWORDS.some((kw) => industryLower.includes(kw))) {
      score += 1;
      breakdown.ai_saas = 1;
    } else {
      breakdown.ai_saas = 0;
    }

    // Verified contact
    if (hasVerifiedContact) {
      score += 2;
      breakdown.has_contact = 2;
    } else {
      breakdown.has_contact = 0;
    }

    return { score, breakdown, qualifies: score >= 2 };
  },

  /**
   * Score a lead by ID, reading from DB
   */
  async scoreLeadById(leadId, pool) {
    const { rows } = await pool.query(
      `SELECT j.posted_at, c.industry, ct.email_verified
       FROM leads l
       JOIN jobs j ON l.job_id = j.id
       JOIN companies c ON l.company_id = c.id
       LEFT JOIN contacts ct ON l.contact_id = ct.id
       WHERE l.id = $1`,
      [leadId]
    );
    if (!rows.length) return 0;
    const row = rows[0];
    const { score, breakdown } = this.scoreLeadObject({
      postedAt:           row.posted_at,
      industry:           row.industry || "",
      hasVerifiedContact: !!row.email_verified,
    });
    // Persist breakdown
    await pool.query(
      `UPDATE leads SET score=$1, score_breakdown=$2 WHERE id=$3`,
      [score, JSON.stringify(breakdown), leadId]
    );
    return score;
  },

  /**
   * Batch score all un-scored leads in DB
   */
  async batchScore(pool) {
    const { rows } = await pool.query(
      `SELECT l.id FROM leads l WHERE l.score = 0 OR l.score_breakdown IS NULL LIMIT 200`
    );
    let updated = 0;
    for (const { id } of rows) {
      await this.scoreLeadById(id, pool);
      updated++;
    }
    return updated;
  },
};
