import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { batchD1BoundValues, maxD1InsertRows } from "@/db/d1-limits";
import { leads } from "@/db/schema";
import type {
  DiscoveredLead,
  GeneratedSite,
  Lead,
  LeadAudit,
  LeadStage,
  OutreachDraft,
} from "@/lib/types";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  search_batch_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  location TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  rating TEXT,
  review_count TEXT,
  source TEXT NOT NULL DEFAULT 'demo',
  stage TEXT NOT NULL DEFAULT 'discovered',
  saved_for_launch INTEGER NOT NULL DEFAULT 0,
  saved_for_launch_at TEXT NOT NULL DEFAULT '',
  audit_json TEXT,
  outreach_json TEXT,
  site_json TEXT,
  analysis_provider TEXT NOT NULL DEFAULT 'pending',
  send_provider TEXT NOT NULL DEFAULT 'pending',
  gmail_message_id TEXT NOT NULL DEFAULT '',
  gmail_thread_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS leads_updated_at_idx ON leads (updated_at)";

let schemaReady: Promise<void> | null = null;

// Drizzle binds all 25 lead columns for every row. Cloudflare D1 accepts at
// most 100 bound parameters per statement, so four rows (100 bindings) is the
// largest safe multi-row insert.
const LEAD_INSERT_BATCH_SIZE = maxD1InsertRows(25);
const SAVED_FOR_LAUNCH_PAGE_SIZE = 250;

async function ensureSchema() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(CREATE_TABLE),
        env.DB.prepare(CREATE_INDEX),
        env.DB.prepare(
          "UPDATE leads SET stage = 'concept_ready' WHERE stage = 'delivered'",
        ),
      ]);
    })();
  }
  try {
    await schemaReady;
  } catch (error) {
    schemaReady = null;
    throw error;
  }
}

export async function listLeads(limit = 500): Promise<Lead[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
  const rows = await getDb()
    .select()
    .from(leads)
    .orderBy(desc(leads.updatedAt))
    .limit(safeLimit);
  return rows.map(toLead);
}

export async function listSavedForLaunchLeads(): Promise<Lead[]> {
  await ensureSchema();
  const saved: Lead[] = [];
  let cursor: { id: string; updatedAt: string } | null = null;

  while (true) {
    const cursorFilter: SQL | undefined = cursor
      ? or(
          lt(leads.updatedAt, cursor.updatedAt),
          and(
            eq(leads.updatedAt, cursor.updatedAt),
            lt(leads.id, cursor.id),
          ),
        )
      : undefined;
    const rows: Array<typeof leads.$inferSelect> = await getDb()
      .select()
      .from(leads)
      .where(
        cursorFilter
          ? and(eq(leads.savedForLaunch, true), cursorFilter)
          : eq(leads.savedForLaunch, true),
      )
      .orderBy(desc(leads.updatedAt), desc(leads.id))
      .limit(SAVED_FOR_LAUNCH_PAGE_SIZE);

    saved.push(...rows.map(toLead));
    if (rows.length < SAVED_FOR_LAUNCH_PAGE_SIZE) break;

    const last: typeof leads.$inferSelect | undefined = rows.at(-1);
    if (!last) break;
    cursor = { id: last.id, updatedAt: last.updatedAt };
  }

  return saved;
}

export async function findLead(id: string): Promise<Lead | null> {
  await ensureSchema();
  const [row] = await getDb()
    .select()
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  return row ? toLead(row) : null;
}

export async function findLeadsByIds(ids: string[]): Promise<Lead[]> {
  await ensureSchema();
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const rows: Array<typeof leads.$inferSelect> = [];
  for (const idBatch of batchD1BoundValues(uniqueIds)) {
    rows.push(
      ...(await getDb()
        .select()
        .from(leads)
        .where(inArray(leads.id, idBatch))),
    );
  }
  const byId = new Map(rows.map((row) => [row.id, toLead(row)]));
  return uniqueIds.flatMap((id) => {
    const lead = byId.get(id);
    return lead ? [lead] : [];
  });
}

export type SaveDiscoveredLeadsResult = {
  leads: Lead[];
  insertedIds: string[];
  duplicateIds: string[];
};

export async function saveDiscoveredLeads(
  discovered: DiscoveredLead[],
  searchBatchId = "",
): Promise<Lead[]> {
  const result = await saveDiscoveredLeadsDetailed(discovered, searchBatchId);
  return result.leads;
}

export async function saveDiscoveredLeadsDetailed(
  discovered: DiscoveredLead[],
  searchBatchId = "",
): Promise<SaveDiscoveredLeadsResult> {
  await ensureSchema();
  const db = getDb();
  if (discovered.length === 0) {
    return { leads: [], insertedIds: [], duplicateIds: [] };
  }

  const uniqueItems = [...new Map(
    discovered
      .filter((item) => item.sourceKey)
      .map((item) => [item.sourceKey, item] as const),
  ).values()];
  const sourceKeys = uniqueItems.map((item) => item.sourceKey);
  const existingRows: Array<typeof leads.$inferSelect> = [];
  for (const sourceKeyBatch of batchD1BoundValues(sourceKeys)) {
    existingRows.push(
      ...(await db
        .select()
        .from(leads)
        .where(inArray(leads.sourceKey, sourceKeyBatch))),
    );
  }
  const existingKeys = new Set(existingRows.map((row) => row.sourceKey));
  const now = new Date().toISOString();
  const newRows: Array<typeof leads.$inferInsert> = uniqueItems
    .filter((item) => !existingKeys.has(item.sourceKey))
    .map((item) => ({
      id: crypto.randomUUID(),
      sourceKey: item.sourceKey,
      searchBatchId,
      name: item.name,
      industry: item.industry,
      location: item.location,
      website: item.website,
      email: item.email,
      phone: item.phone,
      rating: item.rating === null ? null : String(item.rating),
      reviewCount: item.reviewCount === null ? null : String(item.reviewCount),
      source: item.source,
      stage: "discovered",
      savedForLaunch: false,
      savedForLaunchAt: "",
      auditJson: null,
      outreachJson: null,
      siteJson: null,
      analysisProvider: "pending",
      sendProvider: "pending",
      gmailMessageId: "",
      gmailThreadId: "",
      lastError: "",
      createdAt: now,
      updatedAt: now,
    }));

  // The unique source_key constraint resolves races between safe D1 batches.
  for (let index = 0; index < newRows.length; index += LEAD_INSERT_BATCH_SIZE) {
    await db
      .insert(leads)
      .values(newRows.slice(index, index + LEAD_INSERT_BATCH_SIZE))
      .onConflictDoNothing();
  }

  const canonicalRows: Array<typeof leads.$inferSelect> = [];
  for (const sourceKeyBatch of batchD1BoundValues(sourceKeys)) {
    canonicalRows.push(
      ...(await db
        .select()
        .from(leads)
        .where(inArray(leads.sourceKey, sourceKeyBatch))),
    );
  }
  const canonicalByKey = new Map(
    canonicalRows.map((row) => [row.sourceKey, row]),
  );
  const attemptedIds = new Set(newRows.map((row) => row.id));
  const insertedIds: string[] = [];
  const duplicateIds: string[] = [];
  for (const row of canonicalRows) {
    if (attemptedIds.has(row.id)) insertedIds.push(row.id);
    else duplicateIds.push(row.id);
  }

  // Preserve the legacy behavior: return one canonical Lead for every input
  // item, in the same order. Existing rows keep their original search batch;
  // per-run membership now lives in research_job_leads.
  const saved = discovered.flatMap((item) => {
    const row = canonicalByKey.get(item.sourceKey);
    return row ? [toLead(row)] : [];
  });
  return { leads: saved, insertedIds, duplicateIds };
}

type LeadUpdate = {
  stage?: LeadStage;
  savedForLaunch?: boolean;
  savedForLaunchAt?: string;
  email?: string;
  audit?: LeadAudit | null;
  outreach?: OutreachDraft | null;
  site?: GeneratedSite | null;
  analysisProvider?: Lead["analysisProvider"];
  sendProvider?: Lead["sendProvider"];
  gmailMessageId?: string;
  gmailThreadId?: string;
  lastError?: string;
};

export async function updateLead(id: string, update: LeadUpdate): Promise<Lead> {
  await ensureSchema();
  await getDb()
    .update(leads)
    .set({
      ...(update.stage ? { stage: update.stage } : {}),
      ...(update.savedForLaunch !== undefined
        ? { savedForLaunch: update.savedForLaunch }
        : {}),
      ...(update.savedForLaunchAt !== undefined
        ? { savedForLaunchAt: update.savedForLaunchAt }
        : {}),
      ...(update.email !== undefined ? { email: update.email } : {}),
      ...(update.audit !== undefined
        ? { auditJson: update.audit ? JSON.stringify(update.audit) : null }
        : {}),
      ...(update.outreach !== undefined
        ? {
            outreachJson: update.outreach
              ? JSON.stringify(update.outreach)
              : null,
          }
        : {}),
      ...(update.site !== undefined
        ? { siteJson: update.site ? JSON.stringify(update.site) : null }
        : {}),
      ...(update.analysisProvider
        ? { analysisProvider: update.analysisProvider }
        : {}),
      ...(update.sendProvider ? { sendProvider: update.sendProvider } : {}),
      ...(update.gmailMessageId !== undefined
        ? { gmailMessageId: update.gmailMessageId }
        : {}),
      ...(update.gmailThreadId !== undefined
        ? { gmailThreadId: update.gmailThreadId }
        : {}),
      ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(leads.id, id));

  const lead = await findLead(id);
  if (!lead) throw new Error("Lead not found after update");
  return lead;
}

export async function claimApprovedLeadForSending(
  id: string,
): Promise<Lead | null> {
  await ensureSchema();
  const [row] = await getDb()
    .update(leads)
    .set({
      stage: "sending",
      lastError: "",
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(leads.id, id), eq(leads.stage, "approved")))
    .returning();
  return row ? toLead(row) : null;
}

export async function releaseLeadSendClaim(
  id: string,
  lastError: string,
): Promise<Lead | null> {
  await ensureSchema();
  const [row] = await getDb()
    .update(leads)
    .set({
      stage: "approved",
      lastError,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(leads.id, id), eq(leads.stage, "sending")))
    .returning();
  return row ? toLead(row) : null;
}

function toLead(row: typeof leads.$inferSelect): Lead {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    searchBatchId: row.searchBatchId,
    name: row.name,
    industry: row.industry,
    location: row.location,
    website: row.website,
    email: row.email,
    phone: row.phone,
    rating: row.rating === null ? null : Number(row.rating),
    reviewCount: row.reviewCount === null ? null : Number(row.reviewCount),
    source: row.source as Lead["source"],
    // `delivered` was used by early builds for an internal generated concept.
    // It never meant that a deployed website had reached the client.
    stage: normalizeLeadStage(row.stage),
    savedForLaunch: row.savedForLaunch,
    savedForLaunchAt: row.savedForLaunchAt,
    audit: row.auditJson ? (JSON.parse(row.auditJson) as LeadAudit) : null,
    outreach: row.outreachJson
      ? (JSON.parse(row.outreachJson) as OutreachDraft)
      : null,
    site: row.siteJson ? (JSON.parse(row.siteJson) as GeneratedSite) : null,
    analysisProvider: row.analysisProvider as Lead["analysisProvider"],
    sendProvider: row.sendProvider as Lead["sendProvider"],
    gmailMessageId: row.gmailMessageId,
    gmailThreadId: row.gmailThreadId,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeLeadStage(stage: string): LeadStage {
  return stage === "delivered" ? "concept_ready" : (stage as LeadStage);
}
