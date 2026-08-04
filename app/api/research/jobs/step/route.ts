import { saveDiscoveredLeadsDetailed, updateLead } from "@/db/leads";
import {
  acquireResearchJobLease,
  addResearchJobLeads,
  finishResearchJob,
  getResearchJob,
  incrementResearchJobProgress,
  listPendingResearchJobLeads,
  listResearchJobLeadIds,
  markResearchJobLead,
  releaseResearchJobLease,
  researchJobLeaseIsActive,
  updateResearchJob,
} from "@/db/research-jobs";
import {
  analyzeLead,
  discoverBusinesses,
  isQualifiedOpportunity,
} from "@/lib/lead-engine";
import { guardOwnerApi } from "@/lib/owner-auth";
import { safeOperationalErrorMessage } from "@/lib/safe-error";
import type { Lead, ResearchJob } from "@/lib/types";

export const dynamic = "force-dynamic";

// These are hard cost and runtime boundaries, not success thresholds. Hitting
// one produces a visible partial result instead of pretending the target was met.
export const MAX_PLACES_REQUESTS = 100;
const MAX_PAGES_PER_SEARCH = 3;
const MAX_ANALYSIS_CONCURRENCY = 10;
const LEASE_SECONDS = 180;

type LeadOutcome =
  | "qualified"
  | "rejected"
  | "failed"
  | "skipped"
  | "unchanged";

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  let jobId = "";
  let leaseToken = "";

  try {
    const payload = (await request.json()) as { jobId?: string };
    jobId = requiredJobId(payload.jobId);

    const existing = await getResearchJob(jobId);
    if (!existing) {
      return Response.json({ error: "Research job not found" }, { status: 404 });
    }
    if (existing.status !== "running") {
      return Response.json({ job: existing, didWork: false });
    }

    const leased = await acquireResearchJobLease(jobId, LEASE_SECONDS);
    if (!leased) {
      const current = await getResearchJob(jobId);
      if (current && current.status !== "running") {
        return Response.json({ job: current, didWork: false });
      }
      return Response.json(
        {
          error: "This research job is already being processed",
          job: current,
        },
        { status: 409 },
      );
    }
    leaseToken = leased.lockedUntil;

    // Membership transitions are atomic, while aggregate counters are stored
    // separately. Reconcile them after taking the lease so a worker crash
    // between those writes cannot lose qualified opportunities or re-run them.
    const reconciled = await reconcileResearchJobProgress(leased, leaseToken);
    const result = await runBoundedStep(reconciled, leaseToken);
    return Response.json(result);
  } catch (error) {
    const message = errorMessage(error);
    let job: ResearchJob | null = null;
    if (jobId) {
      try {
        job = await finishResearchJob(
          jobId,
          "failed",
          "Research stopped because an internal job step failed. No outreach was sent.",
          message,
          leaseToken || undefined,
        );
      } catch {
        job = await getResearchJob(jobId).catch(() => null);
      }
    }
    return Response.json({ error: message, job }, { status: 500 });
  } finally {
    if (jobId && leaseToken) {
      await releaseResearchJobLease(jobId, leaseToken).catch(() => false);
    }
  }
}

async function runBoundedStep(job: ResearchJob, leaseToken: string): Promise<{
  job: ResearchJob;
  didWork: boolean;
  operation: "analysis" | "discovery" | "complete" | "partial";
  processed: number;
  discovered: number;
}> {
  if (job.qualifiedCount >= job.targetCount) {
    const complete = await completeAtExactTarget(job, leaseToken);
    return stepResult(complete, "complete");
  }

  const remainingTarget = job.targetCount - job.qualifiedCount;
  let pending = await listPendingResearchJobLeads(
    job.id,
    Math.min(MAX_ANALYSIS_CONCURRENCY, remainingTarget),
  );
  let discovered = 0;
  let operation: "analysis" | "discovery" = "analysis";

  if (pending.length === 0) {
    const terminal = await terminalPartialIfNeeded(job, leaseToken);
    if (terminal) return stepResult(terminal, "partial");

    const discovery = await discoverNextPage(job, leaseToken);
    if (discovery.terminal) return stepResult(discovery.terminal, "partial");
    job = discovery.job;
    discovered = discovery.discovered;
    operation = "discovery";

    pending = await listPendingResearchJobLeads(
      job.id,
      Math.min(MAX_ANALYSIS_CONCURRENCY, job.targetCount - job.qualifiedCount),
    );
    if (pending.length === 0) {
      const afterEmptyPage = await terminalPartialIfNeeded(job, leaseToken);
      return afterEmptyPage
        ? stepResult(afterEmptyPage, "partial", 0, discovered)
        : {
            job,
            didWork: true,
            operation,
            processed: 0,
            discovered,
          };
    }
  }

  // The batch never exceeds the remaining target, so a parallel batch cannot
  // overshoot the exact requested number even if every candidate qualifies.
  const outcomes = await Promise.all(
    pending.map((lead) => qualifyLeadForResearch(job, lead, leaseToken)),
  );
  const progress = countOutcomes(outcomes);
  job = await incrementResearchJobProgress(job.id, progress, leaseToken);

  if (job.qualifiedCount >= job.targetCount) {
    const complete = await completeAtExactTarget(job, leaseToken);
    return stepResult(complete, "complete", progress.checkedCount, discovered);
  }

  const terminal = await terminalPartialIfNeeded(job, leaseToken);
  if (terminal) {
    return stepResult(terminal, "partial", progress.checkedCount, discovered);
  }

  return {
    job,
    didWork: true,
    operation,
    processed: progress.checkedCount,
    discovered,
  };
}

async function discoverNextPage(job: ResearchJob, leaseToken: string): Promise<{
  job: ResearchJob;
  discovered: number;
  terminal: ResearchJob | null;
}> {
  const search = job.plan.searches[job.searchIndex];
  if (!search) {
    return { job, discovered: 0, terminal: await exhaustedPlan(job, leaseToken) };
  }

  let result: Awaited<ReturnType<typeof discoverBusinesses>>;
  try {
    result = await discoverBusinesses(search.query, search.location, {
      pageSize: 20,
      pageToken: job.pageToken || undefined,
    });
  } catch (error) {
    const detail = errorMessage(error);
    job = await updateResearchJob(job.id, {
      searchIndex: job.searchIndex + 1,
      pageToken: "",
      pageNumber: 0,
      searchesCompleted: job.searchesCompleted + 1,
      lastError: `Skipped ${search.query} in ${search.location}: ${detail}`,
    }, leaseToken);
    job = await incrementResearchJobProgress(
      job.id,
      { placesRequests: 1 },
      leaseToken,
    );
    return { job, discovered: 0, terminal: null };
  }

  if (result.provider === "demo") {
    const terminal = await finishResearchJob(
      job.id,
      "partial",
      "Google Places is not connected, so real client research was not started. Demo businesses were not added.",
      "",
      leaseToken,
    );
    return { job: terminal, discovered: 0, terminal };
  }

  if (!(await researchJobLeaseIsActive(job.id, leaseToken))) {
    throw new Error("Research job lease lost");
  }
  const canonical = await saveDiscoveredLeadsDetailed(result.leads, job.id);
  const membership = await addResearchJobLeads(
    job.id,
    canonical.leads.map((lead) => lead.id),
    leaseToken,
  );

  const nextPageNumber = job.pageNumber + 1;
  const canContinueThisSearch = Boolean(result.nextPageToken) &&
    nextPageNumber < MAX_PAGES_PER_SEARCH &&
    job.placesRequests + 1 < MAX_PLACES_REQUESTS;

  job = await updateResearchJob(job.id, canContinueThisSearch
    ? {
        pageToken: result.nextPageToken,
        pageNumber: nextPageNumber,
        lastError: "",
      }
    : {
        searchIndex: job.searchIndex + 1,
        pageToken: "",
        pageNumber: 0,
        searchesCompleted: job.searchesCompleted + 1,
        lastError: "",
      }, leaseToken);

  job = await incrementResearchJobProgress(job.id, {
    placesRequests: 1,
    rawCount: result.leads.length,
    uniqueCount: membership.insertedIds.length,
    duplicateCount: membership.duplicateIds.length,
  }, leaseToken);

  return {
    job,
    discovered: membership.insertedIds.length,
    terminal: null,
  };
}

async function qualifyLeadForResearch(
  job: ResearchJob,
  lead: Lead,
  leaseToken: string,
): Promise<LeadOutcome> {
  const jobId = job.id;
  try {
    if (!(await researchJobLeaseIsActive(jobId, leaseToken))) {
      return "unchanged";
    }
    if (
      lead.savedForLaunch &&
      lead.searchBatchId === jobId &&
      isQualifiedOpportunity(lead.audit)
    ) {
      const changed = await markResearchJobLead(
        jobId,
        lead.id,
        "qualified",
        "",
        leaseToken,
      );
      return changed ? "qualified" : "unchanged";
    }
    // A canonical lead can participate in many research jobs, but a company
    // that has already entered the outreach/delivery pipeline must never be
    // presented as a fresh launch opportunity. Unsubscribed companies are
    // suppressed here as well, before any website or AI work is attempted.
    if (isPreviouslyProcessedLead(lead)) {
      const changed = await markResearchJobLead(
        jobId,
        lead.id,
        "skipped",
        `Excluded from fresh research because its canonical stage is ${lead.stage}.`,
        leaseToken,
      );
      return changed ? "skipped" : "unchanged";
    }

    // Re-run the cheap deterministic V1 checks for every fresh membership.
    // Old audits may predate the objective scope rules and are never trusted
    // as a shortcut here.
    const analysis = await analyzeLead(lead, { fast: true });
    const qualified = isQualifiedOpportunity(analysis.audit);

    if (!(await researchJobLeaseIsActive(jobId, leaseToken))) {
      return "unchanged";
    }

    await updateLead(lead.id, {
      stage: qualified ? "qualified" : "rejected",
      savedForLaunch: qualified,
      savedForLaunchAt: qualified
        ? lead.savedForLaunchAt || new Date().toISOString()
        : "",
      audit: analysis.audit,
      outreach: null,
      analysisProvider: analysis.provider,
      lastError: "",
    });

    const changed = await markResearchJobLead(
      jobId,
      lead.id,
      qualified ? "qualified" : "rejected",
      "",
      leaseToken,
    );
    return changed ? (qualified ? "qualified" : "rejected") : "unchanged";
  } catch (error) {
    const detail = errorMessage(error);
    const active = await researchJobLeaseIsActive(jobId, leaseToken).catch(() => false);
    if (!active) return "unchanged";
    await updateLead(lead.id, { lastError: detail }).catch(() => undefined);
    const changed = await markResearchJobLead(
      jobId,
      lead.id,
      "failed",
      detail,
      leaseToken,
    );
    return changed ? "failed" : "unchanged";
  }
}

function isPreviouslyProcessedLead(lead: Lead): boolean {
  if (lead.savedForLaunch) return true;
  return [
    "qualified",
    "rejected",
    "drafted",
    "approved",
    "sending",
    "sent",
    "replied",
    "building",
    "concept_ready",
    "unsubscribed",
  ].includes(lead.stage);
}

function countOutcomes(outcomes: LeadOutcome[]) {
  return {
    checkedCount: outcomes.filter((outcome) => outcome !== "unchanged").length,
    qualifiedCount: outcomes.filter((outcome) => outcome === "qualified").length,
    rejectedCount: outcomes.filter((outcome) => outcome === "rejected").length,
    failedCount: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

async function reconcileResearchJobProgress(
  job: ResearchJob,
  leaseToken: string,
): Promise<ResearchJob> {
  const [qualified, rejected, failed, skipped, pending, waitlist] =
    await Promise.all([
      listResearchJobLeadIds(job.id, ["qualified"]),
      listResearchJobLeadIds(job.id, ["rejected"]),
      listResearchJobLeadIds(job.id, ["failed"]),
      listResearchJobLeadIds(job.id, ["skipped"]),
      listResearchJobLeadIds(job.id, ["pending"]),
      listResearchJobLeadIds(job.id, ["waitlist"]),
    ]);
  const checkedCount =
    qualified.length + rejected.length + failed.length + skipped.length;
  const uniqueCount = checkedCount + pending.length + waitlist.length;

  if (
    job.checkedCount === checkedCount &&
    job.qualifiedCount === qualified.length &&
    job.rejectedCount === rejected.length &&
    job.failedCount === failed.length &&
    job.uniqueCount === uniqueCount
  ) {
    return job;
  }

  return updateResearchJob(job.id, {
    checkedCount,
    qualifiedCount: qualified.length,
    rejectedCount: rejected.length,
    failedCount: failed.length,
    uniqueCount,
    heartbeatAt: new Date().toISOString(),
  }, leaseToken);
}

async function completeAtExactTarget(
  job: ResearchJob,
  leaseToken: string,
): Promise<ResearchJob> {
  const waitlist = await listResearchJobLeadIds(job.id, ["pending"]);
  await Promise.all(
    waitlist.map((leadId) =>
      markResearchJobLead(job.id, leadId, "waitlist", "", leaseToken)
    ),
  );
  return finishResearchJob(job.id, "complete", "", "", leaseToken);
}

async function terminalPartialIfNeeded(
  job: ResearchJob,
  leaseToken: string,
): Promise<ResearchJob | null> {
  const pending = await listPendingResearchJobLeads(job.id, 1);
  if (pending.length > 0) return null;

  if (job.placesRequests >= MAX_PLACES_REQUESTS) {
    return finishResearchJob(
      job.id,
      "partial",
      `Safety cap reached after ${MAX_PLACES_REQUESTS} Google Places requests. ${job.qualifiedCount} of ${job.targetCount} qualified opportunities were saved.`,
      "",
      leaseToken,
    );
  }
  if (job.searchIndex >= job.plan.searches.length) {
    return exhaustedPlan(job, leaseToken);
  }
  return null;
}

function exhaustedPlan(job: ResearchJob, leaseToken: string) {
  return finishResearchJob(
    job.id,
    "partial",
    `The saved plan exhausted ${job.searchesCompleted} market searches after checking ${job.checkedCount} candidates. ${job.qualifiedCount} of ${job.targetCount} qualified opportunities were saved; start a new search to expand into more markets.`,
    "",
    leaseToken,
  );
}

function stepResult(
  job: ResearchJob,
  operation: "complete" | "partial",
  processed = 0,
  discovered = 0,
) {
  return {
    job,
    didWork: processed > 0 || discovered > 0,
    operation,
    processed,
    discovered,
  };
}

function requiredJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Research job id is required");
  }
  return value.trim().slice(0, 100);
}

function errorMessage(error: unknown): string {
  return safeOperationalErrorMessage(error);
}
