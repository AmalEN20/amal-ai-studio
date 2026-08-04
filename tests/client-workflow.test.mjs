import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CLIENT_WORKFLOW_SCHEMA_GUARDS,
  ensureClientWorkflowSchemaGuards,
} from "../db/schema-guards.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const digest = (character) => `sha256:${character.repeat(64)}`;

async function createWorkflowDatabase() {
  const migration = await source("drizzle/0007_client_fulfillment_foundation.sql");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
  for (const guard of CLIENT_WORKFLOW_SCHEMA_GUARDS) database.exec(guard);
  return database;
}

function seedOrder(database) {
  const now = "2026-07-16T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO client_customers (
        id, lead_id, name, company_name, email, phone, status, created_at, updated_at
      ) VALUES (?, '', ?, ?, ?, '', 'active', ?, ?)`,
    )
    .run("customer-1", "Ada Owner", "Example Co", "ada@example.com", now, now);
  database
    .prepare(
      `INSERT INTO client_orders (
        id, customer_id, lead_id, state, currency, portal_token_hash,
        current_quote_version_id, active_build_id, last_transition_event_id,
        paid_at, intake_completed_at, delivered_at, created_at, updated_at
      ) VALUES (?, ?, '', 'quote_draft', 'USD', ?, '', '', ?, '', '', '', ?, ?)`,
    )
    .run("order-1", "customer-1", digest("1"), "event-created", now, now);
  database
    .prepare(
      `INSERT INTO client_workflow_events (
        id, order_id, event_type, from_state, to_state, actor_type,
        actor_id, details_json, created_at
      ) VALUES (?, ?, 'order.created', '', 'quote_draft', 'owner', 'owner-1', '{}', ?)`,
    )
    .run("event-created", "order-1", now);
}

test("client workflow migration is numbered and applies cleanly", async () => {
  const [journal, migration] = await Promise.all([
    source("drizzle/meta/_journal.json"),
    source("drizzle/0007_client_fulfillment_foundation.sql"),
  ]);
  const parsed = JSON.parse(journal);
  const clientMigration = parsed.entries.find(
    (entry) => entry.tag === "0007_client_fulfillment_foundation",
  );

  assert.equal(clientMigration.idx, 7);
  assert.equal(clientMigration.tag, "0007_client_fulfillment_foundation");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `client_customers`/);
  assert.doesNotMatch(migration, /CREATE TRIGGER/);
  assert.equal(CLIENT_WORKFLOW_SCHEMA_GUARDS.length, 9);

  const database = await createWorkflowDatabase();
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get()
      .count,
    8,
  );
  database.close();
});

test("client workflow guards install once per database", async () => {
  let runs = 0;
  const database = {
    prepare: () => ({
      run: async () => {
        runs += 1;
      },
    }),
  };

  await ensureClientWorkflowSchemaGuards(database);
  await ensureClientWorkflowSchemaGuards(database);
  assert.equal(runs, CLIENT_WORKFLOW_SCHEMA_GUARDS.length);

  const helpers = await source("db/client-workflow.ts");
  assert.equal(
    helpers.match(/await ensureMutationGuards\(\);/g)?.length,
    12,
  );
});

test("database guards payment, intake, QA, exact approval, and deployment", async () => {
  const database = await createWorkflowDatabase();
  seedOrder(database);

  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'paid' WHERE id = 'order-1'"),
    /INVALID_ORDER_TRANSITION/,
  );

  database
    .prepare(
      `INSERT INTO quote_versions (
        id, order_id, version, currency, amount_minor, scope_json, terms_json,
        content_digest, created_by, created_at
      ) VALUES (?, ?, 1, 'USD', 5000, '{}', '{}', ?, 'owner-1', ?)`,
    )
    .run("quote-1", "order-1", digest("a"), "2026-07-16T00:01:00.000Z");
  database.exec(
    "UPDATE client_orders SET current_quote_version_id = 'quote-1' WHERE id = 'order-1'",
  );
  database.exec("UPDATE client_orders SET state = 'quote_sent' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'awaiting_payment' WHERE id = 'order-1'");
  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'paid' WHERE id = 'order-1'"),
    /PAYMENT_REQUIRED/,
  );

  database
    .prepare(
      `INSERT INTO payment_records (
        id, order_id, provider, provider_payment_id, provider_customer_id,
        provider_event_hash, status, currency, amount_minor, paid_at,
        refunded_at, created_at, updated_at
      ) VALUES (?, ?, 'test-provider', 'payment-1', '', ?, 'succeeded', 'USD', 5000, ?, '', ?, ?)`,
    )
    .run(
      "payment-1",
      "order-1",
      digest("2"),
      "2026-07-16T00:02:00.000Z",
      "2026-07-16T00:02:00.000Z",
      "2026-07-16T00:02:00.000Z",
    );
  database.exec("UPDATE client_orders SET state = 'paid' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'intake_pending' WHERE id = 'order-1'");
  assert.throws(
    () =>
      database.exec("UPDATE client_orders SET state = 'intake_complete' WHERE id = 'order-1'"),
    /INTAKE_REQUIRED/,
  );

  database
    .prepare(
      `INSERT INTO intake_submissions (
        id, order_id, version, status, answers_json, content_digest, created_at, submitted_at
      ) VALUES (?, ?, 1, 'submitted', '{}', ?, ?, ?)`,
    )
    .run(
      "intake-1",
      "order-1",
      digest("b"),
      "2026-07-16T00:03:00.000Z",
      "2026-07-16T00:03:00.000Z",
    );
  database.exec("UPDATE client_orders SET state = 'intake_complete' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'generation_ready' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'generating' WHERE id = 'order-1'");

  database
    .prepare(
      `INSERT INTO client_builds (
        id, order_id, revision, status, artifact_ref, source_digest, build_digest,
        qa_status, qa_report_json, deployment_ref, deployed_at, created_at, updated_at
      ) VALUES (?, ?, 1, 'generated', 'artifact:test', ?, ?, 'pending', '{}', '', '', ?, ?)`,
    )
    .run(
      "build-1",
      "order-1",
      digest("c"),
      digest("d"),
      "2026-07-16T00:04:00.000Z",
      "2026-07-16T00:04:00.000Z",
    );
  database.exec("UPDATE client_orders SET active_build_id = 'build-1' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'qa_pending' WHERE id = 'order-1'");
  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'client_review' WHERE id = 'order-1'"),
    /QA_REQUIRED/,
  );

  database.exec(
    "UPDATE client_builds SET status = 'qa_passed', qa_status = 'passed' WHERE id = 'build-1'",
  );
  database.exec("UPDATE client_orders SET state = 'client_review' WHERE id = 'order-1'");
  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'approved' WHERE id = 'order-1'"),
    /EXACT_BUILD_APPROVAL_REQUIRED/,
  );

  database
    .prepare(
      `INSERT INTO build_approvals (
        id, order_id, build_id, build_digest, status, approver_customer_id,
        approval_token_hash, note, created_at
      ) VALUES (?, ?, ?, ?, 'approved', ?, NULL, '', ?)`,
    )
    .run(
      "approval-wrong",
      "order-1",
      "build-1",
      digest("e"),
      "customer-1",
      "2026-07-16T00:05:00.000Z",
    );
  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'approved' WHERE id = 'order-1'"),
    /EXACT_BUILD_APPROVAL_REQUIRED/,
  );

  database
    .prepare(
      `INSERT INTO build_approvals (
        id, order_id, build_id, build_digest, status, approver_customer_id,
        approval_token_hash, note, created_at
      ) VALUES (?, ?, ?, ?, 'approved', ?, ?, '', ?)`,
    )
    .run(
      "approval-exact",
      "order-1",
      "build-1",
      digest("d"),
      "customer-1",
      digest("3"),
      "2026-07-16T00:06:00.000Z",
    );
  database.exec("UPDATE client_orders SET state = 'approved' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'deploy_ready' WHERE id = 'order-1'");
  database.exec("UPDATE client_orders SET state = 'deploying' WHERE id = 'order-1'");
  assert.throws(
    () => database.exec("UPDATE client_orders SET state = 'delivered' WHERE id = 'order-1'"),
    /DEPLOYMENT_REFERENCE_REQUIRED/,
  );
  database.exec("UPDATE client_builds SET deployment_ref = 'deployment:test' WHERE id = 'build-1'");
  database.exec("UPDATE client_orders SET state = 'delivered' WHERE id = 'order-1'");
  assert.equal(
    database.prepare("SELECT state FROM client_orders WHERE id = 'order-1'").get().state,
    "delivered",
  );
  database.close();
});

test("quotes, approvals, and workflow events are immutable or append-only", async () => {
  const database = await createWorkflowDatabase();
  seedOrder(database);
  database
    .prepare(
      `INSERT INTO quote_versions (
        id, order_id, version, currency, amount_minor, scope_json, terms_json,
        content_digest, created_by, created_at
      ) VALUES ('quote-1', 'order-1', 1, 'USD', 100, '{}', '{}', ?, 'owner-1', ?)`,
    )
    .run(digest("a"), "2026-07-16T00:01:00.000Z");

  assert.throws(
    () => database.exec("UPDATE quote_versions SET amount_minor = 101 WHERE id = 'quote-1'"),
    /QUOTE_VERSION_IMMUTABLE/,
  );
  assert.throws(
    () => database.exec("DELETE FROM quote_versions WHERE id = 'quote-1'"),
    /QUOTE_VERSION_IMMUTABLE/,
  );
  assert.throws(
    () =>
      database.exec(
        "UPDATE client_workflow_events SET event_type = 'changed' WHERE id = 'event-created'",
      ),
    /WORKFLOW_EVENT_APPEND_ONLY/,
  );
  assert.throws(
    () => database.exec("DELETE FROM client_workflow_events WHERE id = 'event-created'"),
    /WORKFLOW_EVENT_APPEND_ONLY/,
  );
  database.close();
});

test("digests and public token material are hash-only", async () => {
  const [domain, helpers, schema, migration] = await Promise.all([
    source("lib/client-workflow.ts"),
    source("db/client-workflow.ts"),
    source("db/schema.ts"),
    source("drizzle/0007_client_fulfillment_foundation.sql"),
  ]);

  assert.match(domain, /assertProductionGenerationReady/);
  assert.match(domain, /assertExactBuildApproval/);
  assert.match(domain, /assertOptionalSha256Hash/);
  assert.match(domain, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(domain, /\^sha256:\[a-f0-9\]\{64\}\$\/i/);
  assert.match(helpers, /last_transition_event_id = \?/);
  assert.match(helpers, /last_transition_event_id = \?\s*\n\s*\)/);
  assert.match(helpers, /portalTokenHash \|\| null/);
  assert.match(helpers, /providerEventHash: input\.providerEventHash \|\| null/);
  assert.match(helpers, /approvalTokenHash: input\.approvalTokenHash \|\| null/);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS `build_approvals` \([\s\S]*?`build_digest` text NOT NULL CHECK/,
  );
  assert.doesNotMatch(schema, /\b(cardNumber|card_number|pan|cvv|cvc)\b/i);
  assert.doesNotMatch(migration, /\b(card_number|pan|cvv|cvc)\b/i);
  assert.doesNotMatch(schema, /portalToken:\s*text/);
  assert.doesNotMatch(schema, /approvalToken:\s*text/);

  const database = await createWorkflowDatabase();
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO client_customers (
          id, lead_id, name, company_name, email, phone, status, created_at, updated_at
        ) VALUES ('customer-1', '', 'Name', 'Co', 'name@example.com', '', 'active', 'now', 'now')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO client_orders (
          id, customer_id, lead_id, state, currency, portal_token_hash,
          current_quote_version_id, active_build_id, last_transition_event_id,
          paid_at, intake_completed_at, delivered_at, created_at, updated_at
        ) VALUES ('order-1', 'customer-1', '', 'quote_draft', 'USD', 'raw-public-token', '', '', '', '', '', '', 'now', 'now')`,
      )
      .run();
  }, /CHECK constraint failed/);
  database.close();
});
