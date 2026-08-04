export const PIPELINE_STEPS = [
  "intake",
  "research",
  "strategy",
  "copy",
  "build",
  "qa",
  "deploy",
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type StageState = "queued" | "active" | "done" | "ready";

export type BusinessInput = {
  name: string;
  industry: string;
  description: string;
  audience: string;
  offer: string;
  location: string;
  website: string;
  tone: string;
};

export type ServiceItem = {
  title: string;
  description: string;
};

export type GeneratedSite = {
  research: {
    summary: string;
    differentiators: string[];
    customerNeeds: string[];
  };
  strategy: {
    positioning: string;
    primaryGoal: string;
    sections: string[];
  };
  copy: {
    eyebrow: string;
    headline: string;
    subheadline: string;
    primaryCta: string;
    secondaryCta: string;
    services: ServiceItem[];
    proofLabel: string;
    testimonial: {
      quote: string;
      name: string;
      role: string;
    };
    finalCtaTitle: string;
    finalCtaBody: string;
  };
  design: {
    themeName: string;
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentSoft: string;
  };
  stats: Array<{ value: string; label: string }>;
};

export type Project = BusinessInput & {
  id: string;
  status: PipelineStep;
  stages: Record<PipelineStep, StageState>;
  site: GeneratedSite | null;
  provider: "pending" | "openai" | "fallback";
  createdAt: string;
  updatedAt: string;
};

export const LEAD_STAGES = [
  "discovered",
  "qualified",
  "drafted",
  "approved",
  "sending",
  "sent",
  "replied",
  "building",
  "concept_ready",
  "unsubscribed",
  "rejected",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export type LeadAudit = {
  score: number;
  verdict: "strong" | "possible" | "low";
  serviceFit?: "ideal" | "not_fit";
  complexitySignals?: string[];
  positioningAngle?: string;
  summary: string;
  weaknesses: string[];
  opportunities: string[];
  performance: {
    performance: number | null;
    accessibility: number | null;
    seo: number | null;
  };
};

export type OutreachDraft = {
  subject: string;
  body: string;
  cta: string;
};

export type DiscoveredLead = {
  sourceKey: string;
  name: string;
  industry: string;
  location: string;
  website: string;
  email: string;
  phone: string;
  rating: number | null;
  reviewCount: number | null;
  source: "google_places" | "demo" | "manual" | "website";
};

export type Lead = DiscoveredLead & {
  id: string;
  searchBatchId: string;
  stage: LeadStage;
  savedForLaunch: boolean;
  savedForLaunchAt: string;
  audit: LeadAudit | null;
  outreach: OutreachDraft | null;
  site: GeneratedSite | null;
  analysisProvider: "pending" | "openai" | "fallback";
  sendProvider: "pending" | "gmail" | "demo";
  gmailMessageId: string;
  gmailThreadId: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignSearch = {
  query: string;
  location: string;
  reason: string;
};

export type CampaignPlan = {
  title: string;
  summary: string;
  targetCount: number;
  prepareDrafts: boolean;
  searches: CampaignSearch[];
};

export const RESEARCH_JOB_STATUSES = [
  "running",
  "complete",
  "partial",
  "failed",
  "cancelled",
] as const;

export type ResearchJobStatus = (typeof RESEARCH_JOB_STATUSES)[number];

export const RESEARCH_JOB_LEAD_STATUSES = [
  "pending",
  "qualified",
  "rejected",
  "failed",
  "skipped",
  "waitlist",
] as const;

export type ResearchJobLeadStatus =
  (typeof RESEARCH_JOB_LEAD_STATUSES)[number];

export type ResearchJob = {
  id: string;
  targetCount: number;
  status: ResearchJobStatus;
  plan: CampaignPlan;
  searchIndex: number;
  pageToken: string;
  pageNumber: number;
  placesRequests: number;
  searchesCompleted: number;
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  checkedCount: number;
  qualifiedCount: number;
  rejectedCount: number;
  failedCount: number;
  stopReason: string;
  lastError: string;
  lockedUntil: string;
  heartbeatAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchJobLead = {
  jobId: string;
  leadId: string;
  status: ResearchJobLeadStatus;
  error: string;
  createdAt: string;
  updatedAt: string;
};
