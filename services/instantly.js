/**
 * Instantly.ai Email Campaign Service
 *
 * Handles:
 * - Creating campaigns
 * - Adding leads to campaigns
 * - 4-touch sequence over 10 days
 * - Webhook processing for opens/replies
 */

const INSTANTLY_BASE = "https://api.instantly.ai/api/v1";

// Default campaign template — override per run
const CAMPAIGN_CONFIG = {
  name: "HireRadar Outbound — {{date}}",
  daily_limit: 35,          // 30-40 per inbox per day
  stop_on_reply: true,
  track_opens: true,
  track_clicks: false,      // less spammy
  email_gap_minutes: 20,    // space out sends
};

// 4-touch sequence timing
const SEQUENCE_STEPS = [
  { day: 0,  step: 1, label: "Initial Outreach" },
  { day: 2,  step: 2, label: "Value Follow-up" },
  { day: 5,  step: 3, label: "Social Proof" },
  { day: 9,  step: 4, label: "Final Nudge" },
];

export const instantlyService = {
  get headers() {
    if (!process.env.INSTANTLY_API_KEY) throw new Error("INSTANTLY_API_KEY not set");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
    };
  },

  /**
   * Add a single lead to the active campaign.
   * Creates the campaign if it doesn't exist yet today.
   */
  async addLeadToCampaign(lead) {
    const campaignId = await this.getOrCreateCampaign();

    const res = await fetch(`${INSTANTLY_BASE}/lead/add`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        campaign_id: campaignId,
        skip_if_in_workspace: true,   // dedup
        leads: [{
          email:      lead.email,
          first_name: lead.first_name,
          last_name:  lead.last_name,
          company_name: lead.company_name,
          custom_variables: {
            job_title:  lead.job_title   || "",
            industry:   lead.industry    || "",
            score:      String(lead.score || 0),
          },
        }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Instantly addLead failed: ${res.status} ${JSON.stringify(err)}`);
    }

    return { campaign_id: campaignId, status: "added" };
  },

  /**
   * Get today's campaign or create a new one.
   */
  async getOrCreateCampaign() {
    // Check env for a pinned campaign ID
    if (process.env.INSTANTLY_CAMPAIGN_ID) return process.env.INSTANTLY_CAMPAIGN_ID;

    const today = new Date().toISOString().split("T")[0];
    const name  = CAMPAIGN_CONFIG.name.replace("{{date}}", today);

    // Search existing campaigns
    const listRes = await fetch(`${INSTANTLY_BASE}/campaign/list?limit=20`, {
      headers: this.headers,
    });
    if (listRes.ok) {
      const { campaigns } = await listRes.json();
      const existing = campaigns?.find((c) => c.name === name);
      if (existing) return existing.id;
    }

    // Create new campaign
    return await this.createCampaign(name);
  },

  /**
   * Create a new Instantly campaign with 4-step sequence.
   */
  async createCampaign(name) {
    const res = await fetch(`${INSTANTLY_BASE}/campaign/create`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name,
        ...CAMPAIGN_CONFIG,
        sequences: SEQUENCE_STEPS.map((s) => ({
          step:        s.step,
          type:        "email",
          delay:       s.day,                  // days after previous step
          subject:     this.defaultSubject(s.step),
          body:        this.defaultBody(s.step),
        })),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Instantly createCampaign failed: ${res.status} ${JSON.stringify(err)}`);
    }

    const data = await res.json();
    return data.id || data.campaign_id;
  },

  /**
   * Get campaign analytics
   */
  async getCampaignStats(campaignId) {
    const res = await fetch(`${INSTANTLY_BASE}/analytics/campaign/summary?campaign_id=${campaignId}`, {
      headers: this.headers,
    });
    if (!res.ok) return null;
    return res.json();
  },

  /**
   * Process Instantly webhook (opens, replies)
   * Called by POST /api/webhooks/instantly
   */
  processWebhook(payload) {
    const { event_type, lead_email, campaign_id, timestamp } = payload;
    return { event_type, lead_email, campaign_id, timestamp: timestamp || new Date().toISOString() };
  },

  // ── Default email templates (Claude will personalise these) ──
  defaultSubject(step) {
    const subjects = {
      1: "Quick question about your {{job_title}} hire",
      2: "Re: your {{job_title}} search",
      3: "How [Client] scaled their eng team in 3 weeks",
      4: "Last note — {{first_name}}",
    };
    return subjects[step] || "Following up";
  },

  defaultBody(step) {
    const bodies = {
      1: `Hi {{first_name}},

Saw you're hiring a {{job_title}} at {{company_name}} — congrats on the growth!

We help early-stage US startups hire pre-vetted offshore developers at 60% of local cost, typically within 2 weeks.

Worth a 15-min call to see if it's a fit?

Best,
{{sender_name}}`,

      2: `Hi {{first_name}},

Just following up on my last note.

Most founders we work with were spending 3-4 months on engineering hires. We cut that to under 2 weeks with zero recruiter fees.

Happy to share some examples — open to a quick chat?

{{sender_name}}`,

      3: `Hi {{first_name}},

A founder at a {{industry}} startup similar to yours just told us:

"We hired two senior devs in 10 days and saved $80k in the first year."

I think we could do the same for {{company_name}}. Want me to send over the details?

{{sender_name}}`,

      4: `Hi {{first_name}},

Last note from me — I don't want to keep pinging if the timing's off.

If you're still looking for a {{job_title}}, I'd love to help. If not, no worries at all.

Either way, good luck with the search!

{{sender_name}}`,
    };
    return bodies[step] || "";
  },
};
