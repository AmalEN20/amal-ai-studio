import type {
  DiscoveredLead,
  Lead,
  LeadAudit,
  OutreachDraft,
} from "@/lib/types";
import { senderIdentity, senderName, studioName } from "@/lib/identity";
import { generateOpenAIText, openAIConfigured } from "@/lib/openai";
import { fetchPublicHtml, publicWebsiteUrl } from "@/lib/safe-website-fetch";

const EMPTY_PERFORMANCE: Performance = {
  performance: null,
  accessibility: null,
  seo: null,
};

export type BusinessDiscoveryOptions = {
  pageSize?: number;
  pageToken?: string;
};

export type LeadAnalysisOptions = {
  /** Skip slow secondary enrichment while preserving every deterministic fit check. */
  fast?: boolean;
};

export function isQualifiedOpportunity(audit: LeadAudit | null | undefined): boolean {
  // Eligibility is deliberately objective. The score describes possible
  // positioning/personalization, but never decides whether a business enters
  // the launch list.
  return Boolean(audit && audit.serviceFit === "ideal");
}

export async function discoverBusinesses(
  query: string,
  location: string,
  options: BusinessDiscoveryOptions = {},
): Promise<{
  leads: DiscoveredLead[];
  provider: "google_places" | "demo";
  nextPageToken: string;
}> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    return { leads: demoLeads(query, location), provider: "demo", nextPageToken: "" };
  }

  const pageSize = Math.max(1, Math.min(20, Math.round(options.pageSize ?? 20)));
  const requestBody: Record<string, unknown> = {
    textQuery: `${query} in ${location}`,
    pageSize,
    languageCode: "en",
  };
  const pageToken = options.pageToken?.trim();
  if (pageToken) requestBody.pageToken = pageToken;

  const response = await fetchWithRetry(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.websiteUri",
          "places.nationalPhoneNumber",
          "places.rating",
          "places.userRatingCount",
          "places.primaryTypeDisplayName",
          "places.businessStatus",
          "nextPageToken",
        ].join(","),
      },
      body: JSON.stringify(requestBody),
    },
    { timeoutMs: 15_000, attempts: 3 },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Places returned ${response.status}: ${detail.slice(0, 180)}`);
  }

  const payload = (await response.json()) as PlacesResponse;
  const mapped = (payload.places ?? [])
    .filter((place) => place.businessStatus === "OPERATIONAL")
    .map((place, index) => ({
    sourceKey: `google:${place.id || `${slug(query)}-${slug(location)}-${index}`}`,
    name: clean(place.displayName?.text, `Business ${index + 1}`),
    industry: clean(place.primaryTypeDisplayName?.text, query),
    location: clean(place.formattedAddress, location),
    website: safeWebsite(place.websiteUri),
    email: "",
    phone: clean(place.nationalPhoneNumber, ""),
    rating: numberOrNull(place.rating),
    reviewCount: numberOrNull(place.userRatingCount),
    source: "google_places" as const,
  }));

  return {
    leads: mapped,
    provider: "google_places",
    nextPageToken: clean(payload.nextPageToken, ""),
  };
}

export async function analyzeLead(
  lead: Lead,
  options: LeadAnalysisOptions = {},
): Promise<{
  audit: LeadAudit;
  provider: "openai" | "fallback";
}> {
  // Reject obvious direct competitors from Places metadata alone. There is no
  // reason to fetch a web/marketing/software studio's website just to confirm
  // that the studio should not pitch it.
  const metadataOnly = fallbackAudit(
    lead,
    EMPTY_PERFORMANCE,
    EMPTY_WEBSITE_FACTS,
  );
  if (metadataOnly.serviceFit === "not_fit") {
    return { audit: metadataOnly, provider: "fallback" };
  }

  // Fit checks are cheap, deterministic, and safety-critical. Run them before
  // PageSpeed or AI so portals, booking systems, and large sites are rejected
  // without spending more time or tokens.
  const websiteFacts = await inspectWebsite(lead.website, options.fast);
  const deterministic = fallbackAudit(lead, EMPTY_PERFORMANCE, websiteFacts);
  if (deterministic.serviceFit === "not_fit") {
    return { audit: deterministic, provider: "fallback" };
  }

  // Fast research ends after deterministic scope/contactability checks. AI and
  // PageSpeed are optional enrichment for later review, never qualification
  // gates and never required to assemble the launch list.
  if (options.fast) {
    return { audit: deterministic, provider: "fallback" };
  }

  const performance = await getPageSpeed(lead.website);
  const fallback = fallbackAudit(lead, performance, websiteFacts);
  if (!openAIConfigured()) {
    return { audit: fallback, provider: "fallback" };
  }

  try {
    const text = await generateOpenAIText({
      feature: "lead_audit",
      projectId: lead.id,
      instructions: AUDIT_PROMPT,
      maxOutputTokens: 700,
      timeoutMs: 35_000,
      prompt: JSON.stringify({
        name: lead.name,
        industry: lead.industry,
        location: lead.location,
        website: lead.website,
        rating: lead.rating,
        reviewCount: lead.reviewCount,
        performance,
        websiteFacts,
      }),
    });
    const parsed = JSON.parse(stripFence(text)) as Partial<LeadAudit>;
    return { audit: normalizeAudit(parsed, fallback), provider: "openai" };
  } catch {
    return { audit: fallback, provider: "fallback" };
  }
}

export async function createOutreachDraft(lead: Lead): Promise<{
  draft: OutreachDraft;
  provider: "openai" | "fallback";
}> {
  if (!isQualifiedOpportunity(lead.audit)) {
    throw new Error(
      "This business has not passed Studio V1's objective scope and contactability checks. Outreach was blocked.",
    );
  }
  const fallback = fallbackOutreach(lead);
  if (!openAIConfigured()) return { draft: fallback, provider: "fallback" };

  try {
    const text = await generateOpenAIText({
      feature: "outreach_draft",
      projectId: lead.id,
      instructions: OUTREACH_PROMPT,
      maxOutputTokens: 700,
      timeoutMs: 35_000,
      prompt: JSON.stringify({
        business: lead.name,
        industry: lead.industry,
        location: lead.location,
        website: lead.website,
        audit: lead.audit,
        positioningAngle: lead.audit?.positioningAngle,
        sender: senderIdentity(),
      }),
    });
    const parsed = JSON.parse(stripFence(text)) as Partial<OutreachDraft>;
    return {
      draft: {
        subject: clean(parsed.subject, fallback.subject).slice(0, 100),
        body: clean(parsed.body, fallback.body).slice(0, 3000),
        cta: clean(parsed.cta, fallback.cta).slice(0, 240),
      },
      provider: "openai",
    };
  } catch {
    return { draft: fallback, provider: "fallback" };
  }
}

export async function findPublicBusinessEmail(lead: Lead): Promise<{
  email: string;
  sourceUrl: string;
  pagesChecked: number;
}> {
  if (!isAuditableWebsite(lead.website)) {
    return { email: "", sourceUrl: "", pagesChecked: 0 };
  }

  const startUrl = new URL(lead.website);
  const homepage = await fetchOfficialPage(startUrl.toString());
  if (!homepage) return { email: "", sourceUrl: "", pagesChecked: 0 };
  const officialHost = new URL(homepage.url).hostname;

  const pageUrls = [homepage.url, ...contactPageLinks(homepage.html, homepage.url)].slice(0, 3);
  const additional = await Promise.all(
    pageUrls.slice(1).map((url) => fetchOfficialPage(url)),
  );
  const pages = [homepage, ...additional.filter((page): page is OfficialPage => Boolean(page))];
  const candidates = new Map<string, { score: number; sourceUrl: string }>();

  for (const page of pages) {
    for (const candidate of emailCandidates(page.html)) {
      const score = emailCandidateScore(candidate.email, officialHost, candidate.mailto, page.url);
      if (score < 0) continue;
      const current = candidates.get(candidate.email);
      if (!current || score > current.score) {
        candidates.set(candidate.email, { score, sourceUrl: page.url });
      }
    }
  }

  const best = [...candidates.entries()].sort((left, right) => right[1].score - left[1].score)[0];
  return best
    ? { email: best[0], sourceUrl: best[1].sourceUrl, pagesChecked: pages.length }
    : { email: "", sourceUrl: "", pagesChecked: pages.length };
}

type OfficialPage = { html: string; url: string };

async function fetchOfficialPage(url: string): Promise<OfficialPage | null> {
  return fetchPublicHtml(url, { maxBytes: 1_200_000, timeoutMs: 10_000 });
}

function contactPageLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links: string[] = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const label = `${match[1]} ${match[2].replace(/<[^>]+>/g, " ")}`;
    if (!/\b(?:contact|about|team|staff|connect|get[\s-]*in[\s-]*touch)\b/i.test(label)) continue;
    try {
      const url = new URL(match[1], base);
      if (url.hostname !== base.hostname || !["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      const normalized = url.toString();
      if (!links.includes(normalized) && normalized !== base.toString()) links.push(normalized);
      if (links.length >= 2) break;
    } catch {
      // Ignore malformed links on the official website.
    }
  }
  return links;
}

function emailCandidates(html: string): Array<{ email: string; mailto: boolean }> {
  const decoded = html
    .replace(/&#x40;|&#64;|&commat;/gi, "@")
    .replace(/&#x2e;|&#46;|&period;/gi, ".")
    .replace(/&amp;/gi, "&");
  const result = new Map<string, boolean>();
  const mailtoPattern = /mailto:([^?"'\s<>]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = mailtoPattern.exec(decoded))) {
    try {
      const email = normalizePublicEmail(decodeURIComponent(match[1]));
      if (email) result.set(email, true);
    } catch {
      // Ignore invalid URI-encoded mailto values.
    }
  }

  const visiblePattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
  for (const value of decoded.match(visiblePattern) ?? []) {
    const email = normalizePublicEmail(value);
    if (email && !result.has(email)) result.set(email, false);
  }
  return [...result].map(([email, mailto]) => ({ email, mailto }));
}

function normalizePublicEmail(value: string): string {
  const email = value.trim().toLowerCase().replace(/[),.;:]+$/, "");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  const [local, domain] = email.split("@");
  if (/^(?:no-?reply|do-?not-?reply)$/.test(local)) return "";
  if (/^(?:example|email|domain|yourdomain)\.(?:com|org|net)$/.test(domain)) return "";
  if (/\.(?:png|jpg|jpeg|gif|svg|webp)$/i.test(email)) return "";
  return email;
}

function emailCandidateScore(email: string, websiteHost: string, mailto: boolean, sourceUrl: string): number {
  const [local, domain] = email.split("@");
  const host = websiteHost.toLowerCase().replace(/^www\./, "");
  const relatedDomain = domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
  const publicMailbox = /^(?:hello|info|contact|office|team|sales|support|admin|enquiries|inquiries|general|frontdesk|reception)/.test(local);
  const consumerMailbox = /^(?:gmail|outlook|hotmail|yahoo|icloud)\.com$/.test(domain);
  if (!relatedDomain && !consumerMailbox) return -1;
  return (relatedDomain ? 60 : 5) + (mailto ? 35 : 0) + (publicMailbox ? 20 : 0) + (/contact|get-in-touch/i.test(sourceUrl) ? 10 : 0);
}

type Performance = LeadAudit["performance"];

type WebsiteFacts = {
  reachable: boolean;
  internalPageCount: number;
  hasPortal: boolean;
  hasOnlineBooking: boolean;
  hasEcommerce: boolean;
  hasReservationsOrOrdering: boolean;
  hasPaidMembershipOrDonations: boolean;
};

const EMPTY_WEBSITE_FACTS: WebsiteFacts = {
  reachable: false,
  internalPageCount: 0,
  hasPortal: false,
  hasOnlineBooking: false,
  hasEcommerce: false,
  hasReservationsOrOrdering: false,
  hasPaidMembershipOrDonations: false,
};

async function getPageSpeed(website: string): Promise<Performance> {
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (!key || !isAuditableWebsite(website)) return EMPTY_PERFORMANCE;

  try {
    const endpoint = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    endpoint.searchParams.set("url", website);
    endpoint.searchParams.set("key", key);
    endpoint.searchParams.set("strategy", "mobile");
    for (const category of ["performance", "accessibility", "seo"]) {
      endpoint.searchParams.append("category", category);
    }
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) return EMPTY_PERFORMANCE;
    const payload = (await response.json()) as PageSpeedResponse;
    const categories = payload.lighthouseResult?.categories;
    return {
      performance: score(categories?.performance?.score),
      accessibility: score(categories?.accessibility?.score),
      seo: score(categories?.seo?.score),
    };
  } catch {
    return EMPTY_PERFORMANCE;
  }
}

async function inspectWebsite(website: string, fast = false): Promise<WebsiteFacts> {
  if (!isAuditableWebsite(website)) return EMPTY_WEBSITE_FACTS;

  try {
    const page = await fetchPublicHtml(website, {
      // Do not lower the byte limit in fast mode: portal and page-count
      // signals often live in navigation/footer markup near the end.
      maxBytes: 1_500_000,
      timeoutMs: fast ? 8_000 : 12_000,
    });
    if (!page) return EMPTY_WEBSITE_FACTS;
    const html = page.html;
    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ");
    const base = new URL(page.url);
    const internalPaths = new Set<string>();
    const linkSignals: string[] = [];
    const hrefPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;

    while ((match = hrefPattern.exec(html))) {
      try {
        const href = match[1].trim();
        if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) continue;
        const url = new URL(href, base);
        linkSignals.push(`${url.hostname}${url.pathname}${url.search}`.toLowerCase());
        if (url.hostname !== base.hostname || !["http:", "https:"].includes(url.protocol)) continue;
        if (/\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|docx?)$/i.test(url.pathname)) continue;
        internalPaths.add(url.pathname.replace(/\/$/, "") || "/");
      } catch {
        // Ignore malformed links; they are not useful complexity signals.
      }
    }

    const normalizedHtml = html.toLowerCase();
    const links = linkSignals.join(" ");
    // Provider widgets are commonly embedded through script/iframe `src`,
    // form `action`, or inline configuration rather than a visible anchor.
    // Include the raw markup so those sites are rejected before PageSpeed/AI.
    const integrationSignals = `${links} ${normalizedHtml}`;
    const hasBookingProvider = /(?:calendly\.com|acuityscheduling\.com|squareup\.com\/(?:appointments|book)|square\.site\/book|mindbody(?:online)?\.com|vagaro\.com|janeapp\.com|nexhealth\.com|zocdoc\.com|setmore\.com|schedulicity\.com|booksy\.com|fresha\.com|boulevard\.io|glossgenius\.com|opentable\.com|resy\.com)/i.test(
      integrationSignals,
    );
    const hasCommercePlatform = /(?:cdn\.shopify\.com|myshopify\.com|woocommerce|wc-cart-fragments|bigcommerce|squarespace-commerce|wixstores|ecwid)/i.test(
      normalizedHtml,
    );

    return {
      reachable: true,
      internalPageCount: internalPaths.size,
      hasPortal: /\b(?:patient|client|member)\s*(?:login|log in|portal)\b|\bportal\s*(?:login|access)\b/i.test(text),
      hasOnlineBooking:
        hasBookingProvider ||
        /\b(?:schedule|book)\s+(?:an?\s+)?(?:appointment\s+)?online\b|\bonline\s+(?:booking|scheduling)\b|\bbook\s+(?:an?\s+)?appointment\b/i.test(
          text,
        ) ||
        /\/(?:book|booking|appointments?|schedule)(?:\/|\?|$)/i.test(links),
      hasEcommerce:
        hasCommercePlatform ||
        /\b(?:add to (?:cart|bag)|shopping cart|view cart|proceed to checkout|checkout|buy now|shop now)\b/i.test(
          text,
        ) ||
        /\/(?:cart|checkout)(?:\/|\?|$)/i.test(links),
      hasReservationsOrOrdering:
        /\b(?:order online|online ordering|reserve a table|make a reservation|table reservations?)\b/i.test(
          text,
        ) ||
        /(?:opentable\.com|resy\.com|toasttab\.com|doordash\.com|ubereats\.com|grubhub\.com)/i.test(
          integrationSignals,
        ),
      hasPaidMembershipOrDonations:
        /\b(?:become a member|membership checkout|member subscription|donate now|make a donation)\b/i.test(
          text,
        ) ||
        /\/(?:donate|donation|membership\/checkout)(?:\/|\?|$)/i.test(links),
    };
  } catch {
    return EMPTY_WEBSITE_FACTS;
  }
}

function serviceFit(facts: WebsiteFacts, lead: Lead): {
  fit: "ideal" | "not_fit";
  signals: string[];
} {
  const signals: string[] = [];
  const hasWebsite = isAuditableWebsite(lead.website);
  if (!hasWebsite && !lead.phone.trim() && !lead.email.trim()) {
    signals.push("No public website, phone, or email contact path detected");
  }
  if (hasWebsite && !facts.reachable) {
    signals.push("Official website could not be safely verified");
  }
  const businessType = `${lead.industry} ${lead.name}`.toLowerCase();
  if (
    /\b(?:web(?:site)? design|web development|digital marketing|marketing agency|advertising agency|branding agency|seo agency|software company|saas|app development)\b/i.test(
      businessType,
    )
  ) {
    signals.push("Direct web, marketing, branding, or software competitor detected");
  }
  if (facts.hasPortal) signals.push("Patient or client login detected");
  if (facts.hasOnlineBooking) signals.push("Online booking or scheduling detected");
  if (facts.hasEcommerce) signals.push("Ecommerce, cart, or checkout detected");
  if (facts.hasReservationsOrOrdering) signals.push("Online ordering or reservations detected");
  if (facts.hasPaidMembershipOrDonations) signals.push("Paid membership or donation flow detected");
  if (facts.internalPageCount > 12) signals.push(`${facts.internalPageCount} internal pages detected`);
  return { fit: signals.length ? "not_fit" : "ideal", signals };
}

function fallbackAudit(
  lead: Lead,
  performance: Performance,
  websiteFacts: WebsiteFacts,
): LeadAudit {
  const hasWebsite = isAuditableWebsite(lead.website);
  const websiteUnverified = hasWebsite && !websiteFacts.reachable;
  const fit = serviceFit(websiteFacts, lead);
  const perf = performance.performance;
  const scoreValue = fit.fit === "not_fit"
    ? 25
    : websiteUnverified
    ? 45
    : !hasWebsite
    ? 94
    : perf === null
      ? 72
      : Math.max(35, Math.min(96, Math.round(100 - perf * 0.58)));
  const weaknesses = fit.fit === "not_fit"
    ? fit.signals
    : websiteUnverified
    ? [
        "The website could not be safely inspected",
        "Portal, booking, commerce, and site-size requirements remain unverified",
        "Qualification should be retried before outreach",
      ]
    : !hasWebsite
    ? [
        "No active business website was found",
        "Customers must rely on directory listings",
        "The business has no owned conversion path",
      ]
    : [
        perf !== null && perf < 70
          ? `Mobile performance is ${perf}/100`
          : "The current website has room for a clearer first impression",
        "The primary offer could be easier to understand above the fold",
        "A stronger consultation CTA could capture more intent",
      ];
  return {
    score: scoreValue,
    verdict: scoreValue >= 80 ? "strong" : scoreValue >= 60 ? "possible" : "low",
    serviceFit: fit.fit,
    complexitySignals: fit.signals,
    positioningAngle: fit.fit === "not_fit"
      ? "No outreach for Studio V1. The required functionality is outside the current offer."
      : "A visually distinctive, motion-led website that creates a premium first impression and guides visitors to one clear contact action.",
    summary: fit.fit === "not_fit"
      ? `${lead.name} is not a fit for Studio V1 because its current website depends on functionality or scale that the studio does not yet replace.`
      : websiteUnverified
      ? `${lead.name} cannot be qualified yet because its website could not be safely inspected for functionality and scale.`
      : !hasWebsite
      ? `${lead.name} has strong potential for a focused website that turns local discovery into direct enquiries.`
      : `${lead.name} already has a web presence, but a clearer premium story and conversion path could make it work harder.`
    ,
    weaknesses,
    opportunities: fit.fit === "not_fit"
      ? [
          "Keep the operational website and its workflows intact",
          "Do not promise to replace login, booking, or a large content library",
          "Revisit only when the studio supports the required integrations",
        ]
      : websiteUnverified
      ? [
          "Retry the website inspection before preparing outreach",
          "Confirm there is no portal, online booking, ecommerce, reservation flow, or large content library",
          "Only continue if the site fits Studio V1's focused marketing offer",
        ]
      : [
          `Lead with the strongest reason to choose ${lead.name}`,
          "Use premium art direction and purposeful motion to create an immediate visual impact",
          "Build a fast, mobile-first path to one clear contact action",
        ],
    performance,
  };
}

function fallbackOutreach(lead: Lead): OutreachDraft {
  const location = cityFromFormattedAddress(lead.location);
  const observation = outreachObservation(lead);
  return {
    subject: `A website idea for ${lead.name}`,
    body: `Hi ${lead.name} team,\n\nI came across ${lead.name} while researching local businesses in ${location}. ${observation}\n\nI run ${studioName()}. We create visually distinctive, motion-led websites that make a business feel premium from the first screen. The focus is a memorable first impression, a clear story, and one simple path to contact.\n\nWould you be open to seeing a visual concept for ${lead.name}?\n\nBest,\n${senderName()}\n${studioName()}`,
    cta: "Would you be open to seeing the concept?",
  };
}

function outreachObservation(lead: Lead): string {
  if (!isAuditableWebsite(lead.website)) {
    return "I could not find a current website, so potential customers may be relying on directory listings to learn about you.";
  }

  const performance = lead.audit?.performance.performance;
  if (typeof performance === "number" && performance < 70) {
    return `An automated mobile performance check of the current site scored ${performance}/100, so there may be room to make the experience faster and the path to contact clearer.`;
  }

  if (typeof lead.reviewCount === "number" && lead.reviewCount > 0) {
    return `Your ${lead.reviewCount} Google reviews are useful trust signals that could be brought closer to the main contact action.`;
  }

  return "I saw an opportunity to make the main value proposition and contact path clearer for visitors.";
}

function normalizeAudit(value: Partial<LeadAudit>, fallback: LeadAudit): LeadAudit {
  const scoreValue = typeof value.score === "number"
    ? Math.max(0, Math.min(100, Math.round(value.score)))
    : fallback.score;
  return {
    score: scoreValue,
    verdict: scoreValue >= 80 ? "strong" : scoreValue >= 60 ? "possible" : "low",
    serviceFit: fallback.serviceFit,
    complexitySignals: fallback.complexitySignals,
    positioningAngle: fallback.positioningAngle,
    summary: clean(value.summary, fallback.summary).slice(0, 700),
    weaknesses: stringList(value.weaknesses, fallback.weaknesses),
    opportunities: stringList(value.opportunities, fallback.opportunities),
    performance: fallback.performance,
  };
}

function demoLeads(query: string, location: string): DiscoveredLead[] {
  const names = ["Harbor & Pine", "Northline", "Juniper House", "Brightfield", "Goodwell"];
  return names.map((name, index) => ({
    sourceKey: `demo:${slug(query)}:${slug(location)}:${index}`,
    name: `${name} ${titleCase(singular(query))}`,
    industry: titleCase(singular(query)),
    location,
    website: index === 0 ? "" : `https://${slug(name)}.example`,
    email: `hello@${slug(name)}.example`,
    phone: index % 2 ? "(555) 014-0200" : "",
    rating: [4.8, 4.6, 4.9, 4.4, 4.7][index],
    reviewCount: [86, 41, 132, 27, 64][index],
    source: "demo",
  }));
}

function isAuditableWebsite(value: string): boolean {
  return publicWebsiteUrl(value) !== null;
}

function safeWebsite(value: unknown): string {
  if (typeof value !== "string") return "";
  return publicWebsiteUrl(value)?.toString() ?? "";
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 220))
    .filter(Boolean)
    .slice(0, 5);
  return result.length ? result : fallback;
}

function score(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * 100) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clean(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "business";
}

function singular(value: string): string {
  const cleaned = value.trim();
  return cleaned.endsWith("s") ? cleaned.slice(0, -1) : cleaned;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cityFromFormattedAddress(value: string): string {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const stateIndex = parts.findIndex((part) => /^[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(part));
  if (stateIndex > 0) return parts[stateIndex - 1];
  return parts.length === 2 ? parts[0] : parts.at(-2) || parts[0] || "your area";
}

type PlacesResponse = {
  nextPageToken?: string;
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    primaryTypeDisplayName?: { text?: string };
    businessStatus?: string;
  }>;
};

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; attempts: number },
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok || !RETRYABLE_HTTP_STATUS.has(response.status) || attempt === options.attempts - 1) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelay(response.headers.get("retry-after"), attempt));
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts - 1) throw error;
      await wait(retryDelay(null, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(5_000, dateDelay);
  }
  return Math.min(4_000, 400 * 2 ** attempt + Math.floor(Math.random() * 200));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type PageSpeedResponse = {
  lighthouseResult?: {
    categories?: Record<string, { score?: number }>;
  };
};

const AUDIT_PROMPT = `You are a personalization analyst for a premium web studio.
Use only the supplied facts. Deterministic code has already decided objective eligibility for Studio V1: a focused marketing/portfolio/small-company site with one simple contact form, without portals, user login, online booking, ecommerce, ordering, reservations, paid memberships, donations, or a large content system. The score and visual observations are optional outreach metadata only and must never determine eligibility. Never invent observations, awards, revenue, or website details.
Return ONLY JSON: {"score":0,"summary":"","weaknesses":["","",""],"opportunities":["","",""]}.`;

const OUTREACH_PROMPT = `Write a concise, human cold email to a local business from the sender named in the input JSON "sender" field.
Use only supplied facts. Position the sender's studio as a premium visual studio: distinctive art direction, purposeful motion, a memorable first impression, concise storytelling, and one clear contact action. Never promise patient/client login, portals, online booking, ecommerce, a large CMS, or a many-page rebuild. Be specific but never pretend to have seen something not provided. Do not overpraise, pressure, or claim guaranteed results. Keep the body under 130 words and plain text. The sending system adds the required compliance footer. Return ONLY JSON: {"subject":"","body":"","cta":""}.`;
