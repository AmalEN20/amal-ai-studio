import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createWebsiteIntakeLink,
  readWebsiteIntakeConfig,
  runWebsiteIntakeBatch,
  sha256Base64Url,
} from "../lib/website-intake-adapter.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const configured = {
  baseUrl: "https://website.test",
  apiToken: "test-token-never-log",
  workerId: "test-worker-1",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fixture(options = {}) {
  const bytes = new TextEncoder().encode("verified asset bytes");
  const sha256 = await sha256Base64Url(bytes);
  const submissionId = options.submissionId ?? "sub_fixture_1";
  const sourceType = options.source ?? "website";
  const correlation =
    sourceType === "gmail_outreach"
      ? {
          lead_ref: "lead-existing-1",
          gmail_thread_ref: "thread-existing-1",
          contact_email: "client@example.com",
        }
      : null;

  return {
    bytes,
    list: {
      api_version: "2026-07-16",
      submissions: [
        {
          submission_id: submissionId,
          reference: "EVL-FIXTURE1",
          schema_version: 3,
          source: sourceType,
          business_name: "Fixture Studio",
          created_at: "2026-07-17T00:00:00.000Z",
          ready_at: "2026-07-17T00:01:00.000Z",
          asset_count: 1,
        },
      ],
      next_cursor: null,
    },
    claim: {
      api_version: "2026-07-16",
      submission_id: submissionId,
      status: "claimed",
      claim_token: "claim-token-never-log",
      lease_expires_at: "2026-07-17T00:06:00.000Z",
    },
    brief: {
      api_version: "2026-07-16",
      submission: {
        submission_id: submissionId,
        reference: "EVL-FIXTURE1",
        schema_version: options.schemaVersion ?? 3,
        source: sourceType,
        normalized_email: "client@example.com",
        contact_name: "Client Name",
        business_name: "Fixture Studio",
        industry: "Design",
        project_type: "marketing_site",
        primary_goal: "Book consultations",
        audience: "Founders",
        answers: { schema_version: 3, style_keywords: ["Editorial"] },
        correlation,
        assets: [
          {
            asset_id: "asset_fixture_1",
            filename: "reference.png",
            content_type: "image/png",
            role: "reference",
            size_bytes: bytes.byteLength,
            sha256,
            download_path:
              `/api/internal/v1/intake/asset?submission_id=${submissionId}&asset_id=asset_fixture_1`,
          },
        ],
      },
    },
  };
}

function createRepository(options = {}) {
  const imports = new Map();
  const calls = [];
  return {
    calls,
    imports,
    async findImport(submissionId) {
      calls.push(["findImport", submissionId]);
      return imports.get(submissionId) ?? null;
    },
    async findLinkedLead(leadRef) {
      calls.push(["findLinkedLead", leadRef]);
      return options.linkedLead ?? null;
    },
    async commitImport(input) {
      calls.push(["commitImport", input]);
      const existing = imports.get(input.submission.submissionId);
      if (existing) return existing;
      const saved = {
        aiOsRecordId: input.linkedLeadId ?? `lead_${input.submission.submissionId}`,
        leadId: input.linkedLeadId ?? `lead_${input.submission.submissionId}`,
        acknowledged: false,
      };
      imports.set(input.submission.submissionId, saved);
      return saved;
    },
    async markAcknowledged(submissionId) {
      calls.push(["markAcknowledged", submissionId]);
      const saved = imports.get(submissionId);
      imports.set(submissionId, { ...saved, acknowledged: true });
    },
  };
}

function createAssetStore() {
  const puts = [];
  return {
    puts,
    async put(input) {
      puts.push(input);
      return input.objectKey;
    },
  };
}

function createFetch(fx, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });

    assert.equal(init.headers.Authorization, `Bearer ${configured.apiToken}`);
    assert.equal(init.headers.Accept, "application/json");
    if (url.pathname.endsWith("/submissions")) return json(fx.list);
    if (url.pathname.endsWith("/claims")) return json(fx.claim, 201);
    if (url.pathname.endsWith("/brief")) {
      assert.equal(init.headers["X-Evele-Claim-Token"], fx.claim.claim_token);
      return json(fx.brief);
    }
    if (url.pathname.endsWith("/asset")) {
      assert.equal(init.headers["X-Evele-Claim-Token"], fx.claim.claim_token);
      return new Response(options.assetBytes ?? fx.bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url.pathname.endsWith("/imports")) {
      assert.equal(init.headers["X-Evele-Claim-Token"], fx.claim.claim_token);
      return json({ status: "imported" });
    }
    if (url.pathname.endsWith("/releases")) {
      assert.equal(init.headers["X-Evele-Claim-Token"], fx.claim.claim_token);
      return json({ status: "failed_or_released" });
    }
    throw new Error(`Unexpected mock path ${url.pathname}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("missing website configuration is fail-closed and performs no work", async () => {
  let requests = 0;
  const result = await runWebsiteIntakeBatch({
    config: null,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not fetch");
    },
    repository: createRepository(),
    assetStore: createAssetStore(),
  });

  assert.deepEqual(result, {
    status: "disabled",
    listed: 0,
    imported: 0,
    acknowledged: 0,
    released: 0,
    skipped: 0,
  });
  assert.equal(requests, 0);
  assert.equal(
    readWebsiteIntakeConfig({
      EVELE_WEBSITE_BASE_URL: "https://website.test",
      EVELE_WEBSITE_API_TOKEN: "",
      EVELE_WEBSITE_IMPORT_WORKER_ID: "worker-1",
    }),
    null,
  );
});

test("standalone intake follows bounded list, claim, verify, save, acknowledge order", async () => {
  const fx = await fixture();
  const repository = createRepository();
  const assetStore = createAssetStore();
  const fetchImpl = createFetch(fx);
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl,
    repository,
    assetStore,
    listLimit: 7,
  });

  assert.equal(result.imported, 1);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.released, 0);
  assert.equal(fetchImpl.calls[0].url.searchParams.get("status"), "ready");
  assert.equal(fetchImpl.calls[0].url.searchParams.get("limit"), "7");
  assert.ok(fetchImpl.calls.every(({ init }) => init.redirect === "error"));
  assert.equal(
    fetchImpl.calls.filter(({ url }) => url.pathname.endsWith("/submissions")).length,
    1,
  );
  assert.equal(assetStore.puts.length, 1);
  assert.deepEqual(Array.from(assetStore.puts[0].bytes), Array.from(fx.bytes));
  const commitIndex = repository.calls.findIndex(([name]) => name === "commitImport");
  const ackRequestIndex = fetchImpl.calls.findIndex(({ url }) =>
    url.pathname.endsWith("/imports"),
  );
  assert.ok(commitIndex >= 0);
  assert.ok(ackRequestIndex >= 0);
  assert.equal(repository.imports.get("sub_fixture_1").acknowledged, true);
});

test("linked intake attaches only to the exact lead, thread, and normalized email", async () => {
  const fx = await fixture({ source: "gmail_outreach" });
  const repository = createRepository({
    linkedLead: {
      id: "lead-existing-1",
      normalizedEmail: "client@example.com",
      gmailThreadId: "thread-existing-1",
    },
  });
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl: createFetch(fx),
    repository,
    assetStore: createAssetStore(),
  });

  assert.equal(result.imported, 1);
  const [, committed] = repository.calls.find(([name]) => name === "commitImport");
  assert.equal(committed.linkedLeadId, "lead-existing-1");
});

test("a linked mismatch is released once and never guessed or auto-retried", async () => {
  const fx = await fixture({ source: "gmail_outreach" });
  const repository = createRepository({
    linkedLead: {
      id: "lead-existing-1",
      normalizedEmail: "different@example.com",
      gmailThreadId: "thread-existing-1",
    },
  });
  const fetchImpl = createFetch(fx);
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl,
    repository,
    assetStore: createAssetStore(),
  });

  assert.equal(result.imported, 0);
  assert.equal(result.released, 1);
  assert.equal(repository.calls.some(([name]) => name === "commitImport"), false);
  const releases = fetchImpl.calls.filter(({ url }) => url.pathname.endsWith("/releases"));
  assert.equal(releases.length, 1);
  assert.equal(releases[0].body.reason, "Linked intake correlation mismatch");
  assert.ok(releases[0].body.reason.length <= 120);
  assert.equal(fetchImpl.calls.some(({ url }) => url.pathname.endsWith("/retries")), false);
});

test("asset size or SHA-256 mismatch blocks durable import and releases safely", async () => {
  const fx = await fixture();
  const fetchImpl = createFetch(fx, {
    assetBytes: new TextEncoder().encode("tampered"),
  });
  const repository = createRepository();
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl,
    repository,
    assetStore: createAssetStore(),
  });

  assert.equal(result.imported, 0);
  assert.equal(result.released, 1);
  assert.equal(repository.calls.some(([name]) => name === "commitImport"), false);
  const release = fetchImpl.calls.find(({ url }) => url.pathname.endsWith("/releases"));
  assert.equal(release.body.reason, "Asset integrity verification failed");
});

test("temporary downstream failure releases a bounded generic reason without secrets", async () => {
  const fx = await fixture();
  const repository = createRepository();
  repository.commitImport = async () => {
    throw new Error(
      "D1 failed for client@example.com using test-token-never-log and private answers",
    );
  };
  const fetchImpl = createFetch(fx);
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl,
    repository,
    assetStore: createAssetStore(),
  });

  assert.equal(result.imported, 0);
  assert.equal(result.released, 1);
  const release = fetchImpl.calls.find(({ url }) => url.pathname.endsWith("/releases"));
  assert.equal(release.body.reason, "Temporary AI OS import failure");
  assert.ok(release.body.reason.length <= 120);
  assert.doesNotMatch(release.body.reason, /client|token|answers/i);
  assert.equal(fetchImpl.calls.some(({ url }) => url.pathname.endsWith("/retries")), false);
});

test("crash retry acknowledges an existing durable import without duplicate save", async () => {
  const fx = await fixture();
  const repository = createRepository();
  repository.imports.set("sub_fixture_1", {
    aiOsRecordId: "lead_sub_fixture_1",
    leadId: "lead_sub_fixture_1",
    acknowledged: false,
  });
  const fetchImpl = createFetch(fx);
  const result = await runWebsiteIntakeBatch({
    config: configured,
    fetchImpl,
    repository,
    assetStore: createAssetStore(),
  });

  assert.equal(result.imported, 0);
  assert.equal(result.acknowledged, 1);
  assert.equal(repository.calls.some(([name]) => name === "commitImport"), false);
  assert.equal(fetchImpl.calls.some(({ url }) => url.pathname.endsWith("/brief")), false);
  assert.equal(fetchImpl.calls.some(({ url }) => url.pathname.endsWith("/asset")), false);
});

test("intake-link client sends only opaque exact correlation through authenticated API", async () => {
  const calls = [];
  const response = await createWebsiteIntakeLink({
    config: configured,
    correlation: {
      leadRef: "lead-existing-1",
      gmailThreadRef: "thread-existing-1",
      contactEmail: "CLIENT@EXAMPLE.COM",
      expiresInSeconds: 604800,
    },
    fetchImpl: async (input, init) => {
      calls.push({ input, init, body: JSON.parse(init.body) });
      return json(
        {
          api_version: "2026-07-16",
          intake_url: "https://website.test/contact?intake=opaque-signed-reference",
          expires_at: "2026-07-24T00:00:00.000Z",
        },
        201,
      );
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    lead_ref: "lead-existing-1",
    gmail_thread_ref: "thread-existing-1",
    contact_email: "client@example.com",
    expires_in_seconds: 604800,
  });
  assert.equal(response.intakeUrl.includes("lead-existing-1"), false);
  assert.equal(response.intakeUrl.includes("thread-existing-1"), false);
});

test("website intake migration is additive, preserves rows, and enforces submission uniqueness", async () => {
  const [base, migration] = await Promise.all([
    source("drizzle/0007_client_fulfillment_foundation.sql"),
    source("drizzle/0008_website_intake_adapter.sql"),
  ]);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE leads (
      id text PRIMARY KEY NOT NULL,
      source_key text NOT NULL UNIQUE,
      name text NOT NULL,
      industry text NOT NULL,
      location text NOT NULL,
      website text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      phone text NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT 'demo',
      stage text NOT NULL DEFAULT 'discovered',
      gmail_message_id text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      updated_at text NOT NULL
    )
  `);
  database.exec("INSERT INTO leads VALUES ('legacy-lead', 'legacy-key', 'Legacy', 'Studio', 'Seattle', '', 'legacy@example.com', '', 'places', 'sent', 'msg-1', 'before', 'before')");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }

  assert.equal(database.prepare("SELECT name FROM leads WHERE id = 'legacy-lead'").get().name, "Legacy");
  assert.equal(
    database.prepare("SELECT gmail_thread_id FROM leads WHERE id = 'legacy-lead'").get()
      .gmail_thread_id,
    "",
  );
  database.prepare(
    `INSERT INTO website_intake_imports (
      submission_id, public_reference, schema_version, source, normalized_email,
      lead_id, gmail_thread_id, brief_json, status, imported_at, acknowledged_at
    ) VALUES (?, ?, 3, 'website', ?, ?, '', '{}', 'saved', 'now', '')`,
  ).run("sub_unique", "EVL-1", "one@example.com", "legacy-lead");
  assert.throws(
    () =>
      database.prepare(
        `INSERT INTO website_intake_imports (
          submission_id, public_reference, schema_version, source, normalized_email,
          lead_id, gmail_thread_id, brief_json, status, imported_at, acknowledged_at
        ) VALUES (?, ?, 3, 'website', ?, ?, '', '{}', 'saved', 'now', '')`,
      ).run("sub_unique", "EVL-2", "two@example.com", "legacy-lead"),
    /UNIQUE constraint failed/,
  );
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|REPLACE)\b/i);
  assert.ok(base.includes("client_customers"));
  database.close();
});

test("production routes are owner-only and the adapter has no downstream side effects", async () => {
  const [workerRoute, linkRoute, wrapper, adapter, environment] = await Promise.all([
    source("app/api/website-intake/route.ts"),
    source("app/api/website-intake/link/route.ts"),
    source("lib/website-intake.ts"),
    source("lib/website-intake-adapter.ts"),
    source(".env.example"),
  ]);
  assert.match(workerRoute, /guardOwnerApi/);
  assert.match(linkRoute, /guardOwnerApi/);
  assert.match(wrapper, /readWebsiteIntakeConfig/);
  assert.match(wrapper, /env\.INTAKE_ASSETS/);
  assert.doesNotMatch(
    `${workerRoute}\n${linkRoute}\n${wrapper}\n${adapter}`,
    /sendLeadEmail|recordPayment|createClientBuild|recordBuildDeployment|deploy_site|publish/i,
  );
  assert.match(environment, /EVELE_WEBSITE_BASE_URL=\n/);
  assert.match(environment, /EVELE_WEBSITE_API_TOKEN=\n/);
  assert.match(environment, /EVELE_WEBSITE_IMPORT_WORKER_ID=\n/);
  assert.match(environment, /OUTREACH_LAUNCH_ENABLED=false/);
});
