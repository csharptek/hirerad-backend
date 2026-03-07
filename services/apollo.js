/**
 * Apollo.io Enrichment Service
 *
 * Uses People Match + Organization endpoints.
 * Targets: Founder, CEO, CTO, Co-Founder, Head of Engineering
 */

const APOLLO_BASE = "https://api.apollo.io/v1";

const TARGET_TITLES = [
  "founder", "co-founder", "ceo", "cto",
  "chief executive", "chief technology",
  "head of engineering", "vp engineering", "engineering lead",
];

export const apolloService = {
  get headers() {
    if (!process.env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY not set");
    return {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": process.env.APOLLO_API_KEY,
    };
  },

  /**
   * Enrich a contact by company domain.
   * Searches for decision makers and returns the best match.
   */
  async enrichContact({ domain, companyName }) {
    // Try organization search first to get employee list
    const orgResult = await this.searchOrganization(domain || companyName);
    if (!orgResult) return null;

    // Search for people at this org with target titles
    const people = await this.searchPeople({
      organization_ids: [orgResult.id],
      titles: TARGET_TITLES,
    });

    if (!people?.length) return null;

    // Prefer verified emails, then highest-ranking title
    const ranked = people.sort((a, b) => {
      const aScore = this.titleScore(a.title) + (a.email ? 10 : 0);
      const bScore = this.titleScore(b.title) + (b.email ? 10 : 0);
      return bScore - aScore;
    });

    return ranked[0];
  },

  /**
   * Direct people match by name + domain (used from UI search)
   */
  async matchPerson({ firstName, lastName, domain }) {
    try {
      const res = await fetch(`${APOLLO_BASE}/people/match`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ first_name: firstName, last_name: lastName, domain }),
      });
      if (!res.ok) throw new Error(`Apollo match failed: ${res.status}`);
      const data = await res.json();
      return data.person || null;
    } catch (err) {
      console.error("[Apollo] matchPerson error:", err.message);
      return null;
    }
  },

  /**
   * Search organization by domain
   */
  async searchOrganization(domain) {
    try {
      const res = await fetch(`${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
        method: "GET",
        headers: this.headers,
      });
      if (!res.ok) return null;
      const data = await res.json();

      const org = data.organization;
      if (!org) return null;

      // Validate company size (1-9 employees)
      const size = org.estimated_num_employees || org.num_employees;
      if (size && size > 9) {
        console.log(`[Apollo] ${domain} has ${size} employees — skipping`);
        return null;
      }

      return org;
    } catch (err) {
      console.error("[Apollo] searchOrganization error:", err.message);
      return null;
    }
  },

  /**
   * Search people by org ID + title keywords
   */
  async searchPeople({ organization_ids, titles }) {
    try {
      const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          organization_ids,
          person_titles: titles,
          page: 1,
          per_page: 10,
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.people || [];
    } catch (err) {
      console.error("[Apollo] searchPeople error:", err.message);
      return [];
    }
  },

  /**
   * Bulk enrich up to 10 companies at once
   */
  async bulkEnrichOrganizations(domains) {
    try {
      const res = await fetch(`${APOLLO_BASE}/organizations/bulk_enrich`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ domains }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.organizations || [];
    } catch (err) {
      console.error("[Apollo] bulkEnrich error:", err.message);
      return [];
    }
  },

  /**
   * Score title priority (higher = more decision-making power)
   */
  titleScore(title = "") {
    const t = title.toLowerCase();
    if (t.includes("founder") || t.includes("ceo")) return 5;
    if (t.includes("cto") || t.includes("chief technology")) return 4;
    if (t.includes("co-founder")) return 4;
    if (t.includes("head of engineering")) return 3;
    if (t.includes("vp") && t.includes("eng")) return 2;
    return 1;
  },

  /**
   * Filter out generic/role-based emails
   */
  isGenericEmail(email = "") {
    const generic = ["info@", "hello@", "contact@", "support@", "admin@", "team@", "noreply@"];
    return generic.some((g) => email.toLowerCase().startsWith(g));
  },
};
