import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { findLeadsByIds } from "@/db/leads";
import { researchJobLeads, researchJobs } from "@/db/schema";
import type {
  CampaignPlan,
  Lead,
  ResearchJob,
  ResearchJobLead,
  ResearchJobLeadStatus,
  ResearchJobStatus,
} from "@/lib/types";

const CREATE_RESEARCH_JOBS_TABLE = `CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  target_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  plan_json TEXT NOT NULL,
  search_index INTEGER NOT NULL DEFAULT 0,
  page_token TEXT NOT NULL DEFAULT '',
  page_number INTEGER NOT NULL DEFAULT 0,
  places_requests INTEGER NOT NULL DEFAULT 0,
  searches_completed INTEGER NOT NULL DEFAULT 0,
  raw_count INTEGER NOT NULL DEFAULT 0,
  unique_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  locked_until TEXT NOT NULL DEFAULT '',
  heartbeat_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_RESEARCH_JOB_LEADS_TABLE = `CREATE TABLE IF NOT EXISTS research_job_leads (
  job_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, lead_id),
  FOREIGN KEY (job_id) REFERENCES research_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
)`;

const CREATE_JOB_STATUS_INDEX =
  "CREATE INDEX IF NOT EXISTS research_jobs_status_updated_idx ON research_jobs (status, updated_at)";
const CREATE_JOB_LEAD_STATUS_INDEX =
  "CREATE INDEX IF NOT EXISTS research_job_leads_job_status_idx ON research_job_leads (job_id, status, created_at)";
const CREATE_JOB_LEAD_INDEX =
  "CREATE INDEX IF NOT EXISTS research_job_leads_lead_idx ON research_job_leads (lead_id)";

let schemaReady: Promise<void> | null = null;

export async function ensureResearchJobSchema() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  if (!schemaReady) {
    schemaReady = env.DB
      .batch([
        env.DB.prepare(CREATE_RESEARCH_JOBS_TABLE),
        env.DB.prepare(CREATE_RESEARCH_JOB_LEADS_TABLE),
        env.DB.prepare(CREATE_JOB_STATUS_INDEX),
        env.DB.prepare(CREATE_JOB_LEAD_STATUS_INDEX),
        env.DB.prepare(CREATE_JOB_LEAD_INDEX),
      ])
      .then(() => undefined);
  }
  try {
    await schemaReady;
  } catch (error) {
    schemaReady = null;
    throw error;
  }
}

export async function createResearchJob(
  plan: CampaignPlan,
): Promise<ResearchJob> {
  await ensureResearchJobSchema();
  const now = new Date().toISOString();
  const row: typeof researchJobs.$inferInsert = {
    id: crypto.randomUUID(),
    targetCount: plan.targetCount,
    status: "running",
    planJson: JSON.stringify(plan),
    searchIndex: 0,
    pageToken: "",
    pageNumber: 0,
    placesRequests: 0,
    searchesCompleted: 0,
    rawCount: 0,
    uniqueCount: 0,
    duplicateCount: 0,
    checkedCount: 0,
    qualifiedCount: 0,
    rejectedCount: 0,
    failedCount: 0,
    stopReason: "",
    lastError: "",
    lockedUntil: "",
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(researchJobs).values(row);
  return toResearchJob(row as typeof researchJobs.$inferSelect);
}

export async function findActiveResearchJob(): Promise<ResearchJob | null> {
  await ensureResearchJobSchema();
  const [row] = await getDb()
    .select()
    .from(researchJobs)
    .where(eq(researchJobs.status, "running"))
    .orderBy(desc(researchJobs.updatedAt))
    .limit(1);
  return row ? toResearchJob(row) : null;
}

export async function createOrResumeResearchJob(
  plan: CampaignPlan,
): Promise<{ job: ResearchJob; created: boolean }> {
  await ensureResearchJobSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO research_jobs (
       id, target_count, status, plan_json, search_index, page_token,
       page_number, places_requests, searches_completed, raw_count,
       unique_count, duplicate_count, checked_count, qualified_count,
       rejected_count, failed_count, stop_reason, last_error, locked_until,
       heartbeat_at, created_at, updated_at
     )
     SELECT ?, ?, 'running', ?, 0, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            '', '', '', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM research_jobs WHERE status = 'running'
     )`,
  )
    .bind(id, plan.targetCount, JSON.stringify(plan), now, now, now)
    .run();

  if ((result.meta?.changes ?? 0) > 0) {
    const job = await getResearchJob(id);
    if (!job) throw new Error("Research job was not readable after creation");
    return { job, created: true };
  }

  const job = await findActiveResearchJob();
  if (!job) throw new Error("An active research job changed while resuming");
  return { job, created: false };
}

export async function getResearchJob(id: string): Promise<ResearchJob | null> {
  await ensureResearchJobSchema();
  const [row] = await getDb()
    .select()
    .from(researchJobs)
    .where(eq(researchJobs.id, id))
    .limit(1);
  return row ? toResearchJob(row) : null;
}

export async function listResearchJobs(limit = 20): Promise<ResearchJob[]> {
  await ensureResearchJobSchema();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await getDb()
    .select()
    .from(researchJobs)
    .orderBy(desc(researchJobs.updatedAt))
    .limit(safeLimit);
  return rows.map(toResearchJob);
}

export type ResearchJobPatch = Partial<
  Pick<
    ResearchJob,
    | "status"
    | "searchIndex"
    | "pageToken"
    | "pageNumber"
    | "placesRequests"
    | "searchesCompleted"
    | "rawCount"
    | "uniqueCount"
    | "duplicateCount"
    | "checkedCount"
    | "qualifiedCount"
    | "rejectedCount"
    | "failedCount"
    | "stopReason"
    | "lastError"
    | "lockedUntil"
    | "heartbeatAt"
  >
>;

export async function updateResearchJob(
  id: string,
  patch: ResearchJobPatch,
  expectedLockedUntil?: string,
): Promise<ResearchJob> {
  await ensureResearchJobSchema();
  const now = new Date().toISOString();
  const changed = await getDb()
    .update(researchJobs)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.searchIndex !== undefined
        ? { searchIndex: patch.searchIndex }
        : {}),
      ...(patch.pageToken !== undefined ? { pageToken: patch.pageToken } : {}),
      ...(patch.pageNumber !== undefined
        ? { pageNumber: patch.pageNumber }
        : {}),
      ...(patch.placesRequests !== undefined
        ? { placesRequests: patch.placesRequests }
        : {}),
      ...(patch.searchesCompleted !== undefined
        ? { searchesCompleted: patch.searchesCompleted }
        : {}),
      ...(patch.rawCount !== undefined ? { rawCount: patch.rawCount } : {}),
      ...(patch.uniqueCount !== undefined
        ? { uniqueCount: patch.uniqueCount }
        : {}),
      ...(patch.duplicateCount !== undefined
        ? { duplicateCount: patch.duplicateCount }
        : {}),
      ...(patch.checkedCount !== undefined
        ? { checkedCount: patch.checkedCount }
        : {}),
      ...(patch.qualifiedCount !== undefined
        ? { qualifiedCount: patch.qualifiedCount }
        : {}),
      ...(patch.rejectedCount !== undefined
        ? { rejectedCount: patch.rejectedCount }
        : {}),
      ...(patch.failedCount !== undefined
        ? { failedCount: patch.failedCount }
        : {}),
      ...(patch.stopReason !== undefined
        ? { stopReason: patch.stopReason }
        : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.lockedUntil !== undefined
        ? { lockedUntil: patch.lockedUntil }
        : {}),
      ...(patch.heartbeatAt !== undefined
        ? { heartbeatAt: patch.heartbeatAt }
        : {}),
      updatedAt: now,
    })
    .where(
      expectedLockedUntil
        ? and(
            eq(researchJobs.id, id),
            eq(researchJobs.status, "running"),
            eq(researchJobs.lockedUntil, expectedLockedUntil),
          )
        : eq(researchJobs.id, id),
    )
    .returning({ id: researchJobs.id });

  if (expectedLockedUntil && changed.length === 0) {
    throw new Error("Research job lease lost");
  }

  const job = await getResearchJob(id);
  if (!job) throw new Error("Research job not found after update");
  return job;
}

export type ResearchJobProgressDelta = Partial<
  Pick<
    ResearchJob,
    | "placesRequests"
    | "searchesCompleted"
    | "rawCount"
    | "uniqueCount"
    | "duplicateCount"
    | "checkedCount"
    | "qualifiedCount"
    | "rejectedCount"
    | "failedCount"
  >
>;

const PROGRESS_COLUMNS: Record<keyof ResearchJobProgressDelta, string> = {
  placesRequests: "places_requests",
  searchesCompleted: "searches_completed",
  rawCount: "raw_count",
  uniqueCount: "unique_count",
  duplicateCount: "duplicate_count",
  checkedCount: "checked_count",
  qualifiedCount: "qualified_count",
  rejectedCount: "rejected_count",
  failedCount: "failed_count",
};

export async function incrementResearchJobProgress(
  id: string,
  delta: ResearchJobProgressDelta,
  expectedLockedUntil?: string,
): Promise<ResearchJob> {
  await ensureResearchJobSchema();
  const entries = Object.entries(delta).filter(
    (entry): entry is [keyof ResearchJobProgressDelta, number] =>
      Number.isFinite(entry[1]),
  );
  const now = new Date().toISOString();
  if (entries.length === 0) {
    return updateResearchJob(id, { heartbeatAt: now }, expectedLockedUntil);
  }

  const updates = entries.map(
    ([key]) => `${PROGRESS_COLUMNS[key]} = MAX(0, ${PROGRESS_COLUMNS[key]} + ?)`,
  );
  updates.push("heartbeat_at = ?", "updated_at = ?");
  const values = entries.map(([, value]) => Math.trunc(value));
  const leaseGuard = expectedLockedUntil
    ? " AND status = 'running' AND locked_until = ?"
    : "";
  const result = await env.DB.prepare(
    `UPDATE research_jobs SET ${updates.join(", ")} WHERE id = ?${leaseGuard}`,
  )
    .bind(...values, now, now, id, ...(expectedLockedUntil ? [expectedLockedUntil] : []))
    .run();

  if (expectedLockedUntil && (result.meta?.changes ?? 0) < 1) {
    throw new Error("Research job lease lost");
  }

  const job = await getResearchJob(id);
  if (!job) throw new Error("Research job not found after progress update");
  return job;
}

export async function finishResearchJob(
  id: string,
  status: Exclude<ResearchJobStatus, "running">,
  stopReason = "",
  lastError = "",
  expectedLockedUntil?: string,
): Promise<ResearchJob> {
  return updateResearchJob(id, {
    status,
    stopReason,
    lastError,
    lockedUntil: "",
    heartbeatAt: new Date().toISOString(),
  }, expectedLockedUntil);
}

export const completeResearchJob = finishResearchJob;

export async function acquireResearchJobLease(
  id: string,
  leaseSeconds = 180,
): Promise<ResearchJob | null> {
  await ensureResearchJobSchema();
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(
    now.getTime() + Math.max(10, Math.min(300, leaseSeconds)) * 1_000,
  ).toISOString();
  const result = await env.DB.prepare(
    `UPDATE research_jobs
       SET locked_until = ?, heartbeat_at = ?, updated_at = ?
     WHERE id = ?
       AND status = 'running'
       AND (locked_until = '' OR locked_until < ?)`,
  )
    .bind(lockedUntil, nowIso, nowIso, id, nowIso)
    .run();
  if ((result.meta?.changes ?? 0) < 1) return null;
  return getResearchJob(id);
}

export async function renewResearchJobLease(
  id: string,
  expectedLockedUntil: string,
  leaseSeconds = 180,
): Promise<string | null> {
  await ensureResearchJobSchema();
  const now = new Date();
  const nextLockedUntil = new Date(
    now.getTime() + Math.max(10, Math.min(300, leaseSeconds)) * 1_000,
  ).toISOString();
  const result = await env.DB.prepare(
    `UPDATE research_jobs
       SET locked_until = ?, heartbeat_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND locked_until = ?`,
  )
    .bind(
      nextLockedUntil,
      now.toISOString(),
      now.toISOString(),
      id,
      expectedLockedUntil,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0 ? nextLockedUntil : null;
}

export async function releaseResearchJobLease(
  id: string,
  expectedLockedUntil: string,
): Promise<boolean> {
  await ensureResearchJobSchema();
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE research_jobs SET locked_until = '', heartbeat_at = ?, updated_at = ? WHERE id = ? AND locked_until = ?",
  )
    .bind(now, now, id, expectedLockedUntil)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function researchJobLeaseIsActive(
  id: string,
  expectedLockedUntil: string,
): Promise<boolean> {
  await ensureResearchJobSchema();
  const row = await env.DB.prepare(
    `SELECT id FROM research_jobs
     WHERE id = ? AND status = 'running' AND locked_until = ?
     LIMIT 1`,
  )
    .bind(id, expectedLockedUntil)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

export async function addResearchJobLeads(
  jobId: string,
  leadIds: string[],
  expectedLockedUntil?: string,
): Promise<{ insertedIds: string[]; duplicateIds: string[] }> {
  await ensureResearchJobSchema();
  const uniqueLeadIds = [...new Set(leadIds.filter(Boolean))];
  if (uniqueLeadIds.length === 0) {
    return { insertedIds: [], duplicateIds: [] };
  }

  const now = new Date().toISOString();
  const results = await env.DB.batch(
    uniqueLeadIds.map((leadId) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO research_job_leads
          (job_id, lead_id, status, error, created_at, updated_at)
         SELECT ?, ?, 'pending', '', ?, ?
         ${expectedLockedUntil
           ? "WHERE EXISTS (SELECT 1 FROM research_jobs WHERE id = ? AND status = 'running' AND locked_until = ?)"
           : ""}`,
      ).bind(
        jobId,
        leadId,
        now,
        now,
        ...(expectedLockedUntil ? [jobId, expectedLockedUntil] : []),
      ),
    ),
  );
  const insertedIds: string[] = [];
  const duplicateIds: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index] as { meta?: { changes?: number } };
    if ((result.meta?.changes ?? 0) > 0) insertedIds.push(uniqueLeadIds[index]);
    else duplicateIds.push(uniqueLeadIds[index]);
  }
  if (
    expectedLockedUntil &&
    !(await researchJobLeaseIsActive(jobId, expectedLockedUntil))
  ) {
    throw new Error("Research job lease lost");
  }
  return { insertedIds, duplicateIds };
}

async function listResearchJobMemberships(
  jobId: string,
  statuses?: ResearchJobLeadStatus[],
  limit = 2_000,
): Promise<ResearchJobLead[]> {
  await ensureResearchJobSchema();
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const where =
    statuses && statuses.length > 0
      ? and(
          eq(researchJobLeads.jobId, jobId),
          inArray(researchJobLeads.status, statuses),
        )
      : eq(researchJobLeads.jobId, jobId);
  const rows = await getDb()
    .select()
    .from(researchJobLeads)
    .where(where)
    .orderBy(asc(researchJobLeads.createdAt))
    .limit(safeLimit);
  return rows.map(toResearchJobLead);
}

export async function listResearchJobLeadIds(
  jobId: string,
  statuses?: ResearchJobLeadStatus[],
): Promise<string[]> {
  const memberships = await listResearchJobMemberships(jobId, statuses);
  return memberships.map((membership) => membership.leadId);
}

export async function listResearchJobLeads(
  jobId: string,
  statuses?: ResearchJobLeadStatus[],
): Promise<Array<{ membership: ResearchJobLead; lead: Lead }>> {
  const memberships = await listResearchJobMemberships(jobId, statuses);
  const found = await findLeadsByIds(
    memberships.map((membership) => membership.leadId),
  );
  const byId = new Map(found.map((lead) => [lead.id, lead]));
  return memberships.flatMap((membership) => {
    const lead = byId.get(membership.leadId);
    return lead ? [{ membership, lead }] : [];
  });
}

export async function listPendingResearchJobLeads(
  jobId: string,
  limit = 4,
): Promise<Lead[]> {
  const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const memberships = await listResearchJobMemberships(
    jobId,
    ["pending"],
    safeLimit,
  );
  const found = await findLeadsByIds(
    memberships.map((membership) => membership.leadId),
  );
  const byId = new Map(found.map((lead) => [lead.id, lead]));
  return memberships.flatMap((membership) => {
    const lead = byId.get(membership.leadId);
    return lead ? [lead] : [];
  });
}

export async function markResearchJobLead(
  jobId: string,
  leadId: string,
  status: Exclude<ResearchJobLeadStatus, "pending">,
  error = "",
  expectedLockedUntil?: string,
): Promise<boolean> {
  await ensureResearchJobSchema();
  const now = new Date().toISOString();
  const leaseGuard = expectedLockedUntil
    ? ` AND EXISTS (
         SELECT 1 FROM research_jobs
          WHERE id = ? AND status = 'running' AND locked_until = ?
       )`
    : "";
  const result = await env.DB.prepare(
    `UPDATE research_job_leads
       SET status = ?, error = ?, updated_at = ?
     WHERE job_id = ? AND lead_id = ? AND status = 'pending'${leaseGuard}`,
  )
    .bind(
      status,
      error,
      now,
      jobId,
      leadId,
      ...(expectedLockedUntil ? [jobId, expectedLockedUntil] : []),
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

function toResearchJob(row: typeof researchJobs.$inferSelect): ResearchJob {
  return {
    id: row.id,
    targetCount: row.targetCount,
    status: row.status as ResearchJobStatus,
    plan: JSON.parse(row.planJson) as CampaignPlan,
    searchIndex: row.searchIndex,
    pageToken: row.pageToken,
    pageNumber: row.pageNumber,
    placesRequests: row.placesRequests,
    searchesCompleted: row.searchesCompleted,
    rawCount: row.rawCount,
    uniqueCount: row.uniqueCount,
    duplicateCount: row.duplicateCount,
    checkedCount: row.checkedCount,
    qualifiedCount: row.qualifiedCount,
    rejectedCount: row.rejectedCount,
    failedCount: row.failedCount,
    stopReason: row.stopReason,
    lastError: row.lastError,
    lockedUntil: row.lockedUntil,
    heartbeatAt: row.heartbeatAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toResearchJobLead(
  row: typeof researchJobLeads.$inferSelect,
): ResearchJobLead {
  return {
    jobId: row.jobId,
    leadId: row.leadId,
    status: row.status as ResearchJobLeadStatus,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
