import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  batchD1BoundValues,
  D1_MAX_BOUND_PARAMETERS,
} from "../db/d1-limits.ts";
import { safeOperationalErrorMessage } from "../lib/safe-error.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("campaign planning keeps the owner's requested target and never enables outreach", async () => {
  const director = await source("lib/campaign-director.ts");

  assert.match(director, /targetCount:\s*fallback\.targetCount/);
  assert.match(director, /prepareDrafts:\s*false/);
  assert.doesNotMatch(director, /targetCount:\s*clampCount\(value\.targetCount/);
  assert.doesNotMatch(director, /prepareDrafts:\s*true/);
  assert.match(director, /Visual quality, modernity, style, and PageSpeed are never eligibility criteria/);
  assert.doesNotMatch(director, /visual presentation strongly affects trust/i);
  assert.doesNotMatch(director, /needs? (?:a )?(?:strong|modern|visual) website/i);
});

test("Places discovery requests full pages and exposes pagination", async () => {
  const engine = await source("lib/lead-engine.ts");

  assert.match(
    engine,
    /(?:PLACES_PAGE_SIZE\s*=\s*20|pageSize:\s*20|options\.pageSize\s*\?\?\s*20)/,
  );
  assert.match(engine, /nextPageToken/);
  assert.match(engine, /pageToken/);
  assert.match(engine, /places\.businessStatus/);
  assert.match(engine, /place\.businessStatus === "OPERATIONAL"/);
  assert.doesNotMatch(engine, /pageSize:\s*8/);
});

test("unsupported website functionality is rejected before PageSpeed or AI", async () => {
  const engine = await source("lib/lead-engine.ts");

  const inspection = engine.indexOf("const websiteFacts = await inspectWebsite");
  const deterministicExit = engine.indexOf('deterministic.serviceFit === "not_fit"');
  const pageSpeed = engine.indexOf("await getPageSpeed");
  const ai = engine.indexOf("await generateOpenAIText", pageSpeed);

  assert.ok(inspection >= 0);
  assert.ok(deterministicExit > inspection);
  assert.ok(pageSpeed > deterministicExit);
  assert.ok(ai > pageSpeed);
  const fastReturn = engine.indexOf("if (options.fast)");
  assert.ok(fastReturn > deterministicExit);
  assert.ok(fastReturn < pageSpeed);
  assert.match(engine, /hasOnlineBooking/);
  assert.match(engine, /hasPortal/);
  assert.match(engine, /hasEcommerce/);
  assert.match(engine, /hasReservationsOrOrdering/);
  assert.match(engine, /hasPaidMembershipOrDonations/);
  assert.match(engine, /Direct web, marketing, branding, or software competitor detected/);
});

test("research jobs and lead membership are persisted with resumable progress", async () => {
  const [schema, jobs, jobsRoute, stepRoute] = await Promise.all([
    source("db/schema.ts"),
    source("db/research-jobs.ts"),
    source("app/api/research/jobs/route.ts"),
    source("app/api/research/jobs/step/route.ts"),
  ]);

  assert.match(schema, /researchJobs/);
  assert.match(schema, /researchJobLeads/);
  assert.match(schema, /lockedUntil/);
  assert.match(schema, /stopReason/);
  assert.match(jobs, /INSERT OR IGNORE/i);
  assert.match(jobs, /pending/);
  assert.match(jobs, /AND status = 'pending'/);
  assert.match(jobs, /expectedLockedUntil/);
  assert.match(jobs, /WHERE NOT EXISTS[\s\S]*status = 'running'/);
  assert.match(jobsRoute, /createOrResumeResearchJob/);
  assert.match(jobsRoute, /findActiveResearchJob/);
  assert.match(jobsRoute, /getResearchJob/);
  assert.match(jobsRoute, /guardOwnerApi/);
  assert.match(stepRoute, /acquireResearchJobLease/);
  assert.match(stepRoute, /guardOwnerApi/);
  assert.match(stepRoute, /MAX_PLACES_REQUESTS/);
  assert.match(stepRoute, /MAX_ANALYSIS_CONCURRENCY\s*=\s*10/);
  assert.match(stepRoute, /fast:\s*true/);
  assert.match(stepRoute, /researchJobLeaseIsActive/);
  assert.match(stepRoute, /leaseToken/);
  assert.doesNotMatch(stepRoute, /REUSABLE_AUDIT_DAYS|hasReusableAudit/);
  assert.doesNotMatch(stepRoute, /findPublicBusinessEmail|sendGmailMessage|sendLeadEmail/);
});

test("Places pages are inserted below D1's bound-parameter limit", async () => {
  const [leadStore, limits] = await Promise.all([
    source("db/leads.ts"),
    source("db/d1-limits.ts"),
  ]);
  const columnNames = Array.from({ length: 25 }, (_, index) => `column_${index}`);
  const mockLeads = sqliteTable(
    "leads",
    Object.fromEntries(columnNames.map((name) => [name, text(name)])),
  );
  const rows = Array.from({ length: 20 }, (_, rowIndex) =>
    Object.fromEntries(
      columnNames.map((name, columnIndex) => [
        name,
        `row-${rowIndex}-value-${columnIndex}`,
      ]),
    ),
  );
  const buildInsert = (batch) =>
    drizzle({}).insert(mockLeads).values(batch).onConflictDoNothing().toSQL();
  const mockD1Run = (query) => {
    if (query.params.length > 100) {
      throw new Error("D1_ERROR: too many SQL variables");
    }
    return query.params.length;
  };

  assert.equal(buildInsert(rows.slice(0, 1)).params.length, 25);
  assert.equal(buildInsert(rows).params.length, 500);
  assert.throws(
    () => mockD1Run(buildInsert(rows)),
    /D1_ERROR: too many SQL variables/,
  );

  const safeBatchSize = Math.floor(100 / 25);
  assert.equal(safeBatchSize, 4);
  assert.equal(buildInsert(rows.slice(0, safeBatchSize)).params.length, 100);
  assert.equal(buildInsert(rows.slice(0, safeBatchSize + 1)).params.length, 125);
  for (let index = 0; index < rows.length; index += safeBatchSize) {
    assert.doesNotThrow(() =>
      mockD1Run(buildInsert(rows.slice(index, index + safeBatchSize))),
    );
  }

  assert.match(limits, /D1_MAX_BOUND_PARAMETERS\s*=\s*100/);
  assert.match(leadStore, /maxD1InsertRows\(25\)/);
  assert.match(leadStore, /index \+= LEAD_INSERT_BATCH_SIZE/);
  assert.match(leadStore, /index \+ LEAD_INSERT_BATCH_SIZE/);
});

test("lead lookup values are split into D1-safe queries", async () => {
  const leadStore = await source("db/leads.ts");
  const mockLeads = sqliteTable("leads", { id: text("id") });
  const ids = Array.from({ length: 201 }, (_, index) => `lead-${index}`);
  const buildLookup = (batch) =>
    drizzle({})
      .select()
      .from(mockLeads)
      .where(inArray(mockLeads.id, batch))
      .toSQL();
  const mockD1Run = (query) => {
    if (query.params.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error("D1_ERROR: too many SQL variables");
    }
    return query.params.length;
  };

  assert.throws(
    () => mockD1Run(buildLookup(ids.slice(0, 200))),
    /too many SQL variables/,
  );

  const batches = batchD1BoundValues(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 1]);
  assert.deepEqual(batches.flat(), ids);
  for (const batch of batches) {
    assert.doesNotThrow(() => mockD1Run(buildLookup(batch)));
  }

  assert.match(leadStore, /batchD1BoundValues\(uniqueIds\)/);
  assert.match(leadStore, /batchD1BoundValues\(sourceKeys\)/);
  assert.doesNotMatch(leadStore, /index \+= 200|index \+ 200/);
  assert.match(leadStore, /const uniqueIds = \[\.\.\.new Set/);
  assert.match(leadStore, /return uniqueIds\.flatMap/);
});

test("research errors surface a safe nested D1 cause without leaking SQL", () => {
  const cause = new Error("D1_ERROR: too many SQL variables at offset 42");
  const wrapped = new Error(
    'Failed query: select * from "leads" where "id" in (?, ?)\nparams: secret-id',
    { cause },
  );

  const message = safeOperationalErrorMessage(wrapped);
  assert.equal(
    message,
    "Database query exceeded Cloudflare D1's safe parameter limit.",
  );
  assert.doesNotMatch(message, /select|secret-id|params/i);
  assert.equal(
    safeOperationalErrorMessage(
      new Error("D1_EXEC_ERROR: bind failed params: secret-lead-id"),
    ),
    "Database query failed while processing research results.",
  );

  const hostileCause = new Error("outer operational failure");
  Object.defineProperty(hostileCause, "cause", {
    get() {
      throw new Error("cause getter must not escape");
    },
  });
  assert.equal(
    safeOperationalErrorMessage(hostileCause),
    "outer operational failure",
  );

  const cycleA = new Error("cycle a");
  const cycleB = new Error("cycle b");
  cycleA.cause = cycleB;
  cycleB.cause = cycleA;
  assert.equal(safeOperationalErrorMessage(cycleA), "cycle a");
  assert.equal(
    safeOperationalErrorMessage(new Error("Places API temporarily unavailable")),
    "Places API temporarily unavailable",
  );
});

test("qualification is objective and never gated by a subjective audit score", async () => {
  const [engine, action] = await Promise.all([
    source("lib/lead-engine.ts"),
    source("app/api/leads/action/route.ts"),
  ]);

  const gateStart = engine.indexOf("export function isQualifiedOpportunity");
  const gateEnd = engine.indexOf("export async function discoverBusinesses", gateStart);
  const gate = engine.slice(gateStart, gateEnd);
  assert.match(gate, /serviceFit === "ideal"/);
  assert.doesNotMatch(gate, /audit\.score|audit\.verdict|audit\.performance/);
  assert.doesNotMatch(action, /MIN_QUALIFIED_SCORE|audit\.score\s*>?=/);
});

test("dashboard shows saved research status and can resume an interrupted search", async () => {
  const [dashboard, leadShared] = await Promise.all([
    source("app/components/Dashboard.tsx"),
    source("app/components/lead-shared.tsx"),
  ]);

  assert.match(dashboard, /\/api\/research\/jobs/);
  assert.match(dashboard, /Resume saved search/);
  assert.match(dashboard, /stopReason/);
  assert.match(dashboard, /qualifiedCount/);
  assert.match(dashboard, /duplicateCount/);
  assert.match(dashboard, /status === "partial"/);
  assert.match(leadShared, /function isLaunchReadyLead/);
  assert.doesNotMatch(dashboard, /MIN_LAUNCH_SCORE|audit\.score\s*>?=/);
});
