import type { CampaignPlan, CampaignSearch } from "@/lib/types";
import { generateOpenAIText, openAIConfigured } from "@/lib/openai";

const MAX_TARGETS = 50;
const MAX_SEARCHES = 30;

const CAMPAIGN_PROMPT = `You are the campaign director for Amal AI Studio, a premium web design studio.

Create a focused local lead-search plan for the requested number of qualified clients.

Studio V1 can deliver only visually distinctive, motion-led marketing landing pages or small portfolio websites with one simple contact form. It cannot replace patient/client portals, online booking systems, ecommerce, SaaS products, or large content-heavy websites.

Rules:
- Search broadly among real, operational independent local service businesses with a public website or contact path.
- Prefer businesses whose website need is compatible with a focused brochure, portfolio, landing, or small-company site with a simple enquiry path.
- Visual quality, modernity, style, and PageSpeed are never eligibility criteria. They may only become later personalization metadata.
- Useful categories include interior and landscape designers, photographers, wedding or event planners without booking portals, boutique builders or remodelers, home staging studios, artisans, and local professional services with a simple enquiry path.
- Avoid medical practices that depend on patient login or scheduling, ecommerce, franchises, large institutions, and businesses whose core website needs complex functionality.
- Avoid direct competitors such as web design, branding, advertising, and marketing agencies because they sell overlapping services, not because of how their websites look.
- Use real city/state market names.
- Expect deterministic scope/contactability checks to reject some results.
- Create enough distinct searches to reach the requested qualified target, assuming up to 20 results per page. The system can paginate and continue into later markets when needed.
- Maximum 50 qualified targets and 30 searches.
- targetCount must exactly match the requested qualified target. Never change it.
- prepareDrafts must be false. This workflow finds and qualifies opportunities before outreach is prepared.
- Return JSON only with this exact shape:
{"title":"...","summary":"...","targetCount":50,"prepareDrafts":false,"searches":[{"query":"interior designers","location":"Bellevue, WA","reason":"..."}]}

Do not include sending. The system always requires owner approval before any email is sent.`;

export async function createCampaignPlan(targetCount: number): Promise<{
  plan: CampaignPlan;
  provider: "openai" | "fallback";
}> {
  const normalizedTarget = clampCount(targetCount, 10);
  const fallback = fallbackCampaignPlan(normalizedTarget);
  if (!openAIConfigured()) return { plan: fallback, provider: "fallback" };

  try {
    const text = await generateOpenAIText({
      feature: "campaign_plan",
      instructions: CAMPAIGN_PROMPT,
      maxOutputTokens: 1400,
      timeoutMs: 40_000,
      prompt: `Find ${normalizedTarget} qualified clients. Return exactly ${fallback.searches.length} distinct market searches so the system has enough candidates to reject poor fits and still reach the qualified target. Keep each reason short.`,
    });
    const parsed = JSON.parse(stripFence(text)) as Partial<CampaignPlan>;
    return { plan: normalizeCampaignPlan(parsed, fallback), provider: "openai" };
  } catch {
    return { plan: fallback, provider: "fallback" };
  }
}

function fallbackCampaignPlan(targetCount: number): CampaignPlan {
  const defaultQueries = [
    "interior designers",
    "landscape designers",
    "fine art photographers",
    "wedding planners without booking portals",
    "boutique home builders",
    "home staging studios",
    "artisan furniture makers",
    "luxury event designers",
    "architectural finish studios",
    "custom tile and stone studios",
  ];
  const defaultLocations = [
    "Issaquah, WA",
    "Bellevue, WA",
    "Seattle, WA",
    "Portland, OR",
    "Austin, TX",
    "Scottsdale, AZ",
    "Denver, CO",
    "Nashville, TN",
    "Charleston, SC",
    "Los Angeles, CA",
  ];
  const searchCount = requiredSearchCount(targetCount);
  const searches: CampaignSearch[] = [];

  for (let index = 0; index < searchCount; index += 1) {
    const query = defaultQueries[index % defaultQueries.length];
    const marketRound = Math.floor(index / defaultQueries.length);
    const location = defaultLocations[(index + marketRound * 3) % defaultLocations.length];
    searches.push({
      query,
      location,
      reason: "An operational service business whose public contact path may fit Studio V1's focused marketing-site scope.",
    });
  }

  return {
    title: `Client campaign · ${targetCount} targets`,
    summary: "Search operational independent service businesses, reject incompatible functionality, and keep every message in owner review.",
    targetCount,
    prepareDrafts: false,
    searches,
  };
}

function normalizeCampaignPlan(value: Partial<CampaignPlan>, fallback: CampaignPlan): CampaignPlan {
  const rawSearches = Array.isArray(value.searches) ? value.searches : [];
  const searches = rawSearches
    .map((item) => normalizeSearch(item))
    .filter((item): item is CampaignSearch => Boolean(item))
    .slice(0, MAX_SEARCHES);
  const seen = new Set(searches.map(searchKey));

  for (const fallbackSearch of fallback.searches) {
    if (searches.length >= fallback.searches.length) break;
    const key = searchKey(fallbackSearch);
    if (seen.has(key)) continue;
    seen.add(key);
    searches.push(fallbackSearch);
  }

  return {
    title: clean(value.title, fallback.title, 100),
    summary: clean(value.summary, fallback.summary, 360),
    // User intent and safety policy are authoritative. Model output is allowed
    // to improve the markets, but never to shrink the target or enable drafts.
    targetCount: fallback.targetCount,
    prepareDrafts: false,
    searches: searches.length ? searches : fallback.searches,
  };
}

function requiredSearchCount(targetCount: number): number {
  return Math.min(MAX_SEARCHES, Math.max(6, Math.ceil(targetCount / 2)));
}

function searchKey(search: CampaignSearch): string {
  return `${search.query.trim().toLowerCase()}|${search.location.trim().toLowerCase()}`;
}

function normalizeSearch(value: unknown): CampaignSearch | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<CampaignSearch>;
  const query = clean(item.query, "", 100);
  const location = clean(item.location, "", 100);
  if (!query || !location) return null;
  return {
    query,
    location,
    reason: clean(item.reason, "Matches Studio V1's focused marketing-site offer.", 220),
  };
}

function clampCount(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(1, Math.min(MAX_TARGETS, number));
}

function clean(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
