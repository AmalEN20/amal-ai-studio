import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { unstable_splitSqlQuery } from "wrangler";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function loadMigrations() {
  const journal = JSON.parse(await source("drizzle/meta/_journal.json"));
  return Promise.all(
    journal.entries.map(async ({ tag }) => ({
      name: `${tag}.sql`,
      sql: await source(`drizzle/${tag}.sql`),
    })),
  );
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  return database;
}

function applyMigration(database, migration) {
  const migrationWithJournal = `${migration.sql}\nINSERT INTO d1_migrations (name) VALUES ('${migration.name}');`;
  const statements = unstable_splitSqlQuery(migrationWithJournal);

  database.exec("BEGIN");
  try {
    for (const statement of statements) {
      database.exec(statement);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function asLegacyMigration(migration) {
  if (migration.name !== "0001_loud_silk_fever.sql") return migration;
  return {
    ...migration,
    sql: migration.sql.replace(
      "\t`search_batch_id` text DEFAULT '' NOT NULL,\n",
      "",
    ),
  };
}

function columnNames(database, table) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function assertResearchSchema(database) {
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('research_jobs', 'research_job_leads')",
      )
      .get().count,
    2,
  );
  assert.deepEqual(
    { ...database
      .prepare(
        "SELECT name FROM d1_migrations WHERE name = '0005_sour_winter_soldier.sql'",
      )
      .get() },
    { name: "0005_sour_winter_soldier.sql" },
  );
}

test("clean D1 migration chain creates search_batch_id exactly once", async () => {
  const database = createDatabase();
  for (const migration of await loadMigrations()) applyMigration(database, migration);

  assert.equal(
    columnNames(database, "leads").filter((name) => name === "search_batch_id").length,
    1,
  );
  assertResearchSchema(database);
  database.close();
});

test("legacy D1 with runtime-added search_batch_id upgrades without data loss", async () => {
  const migrations = await loadMigrations();
  const database = createDatabase();
  for (const migration of migrations.slice(0, 5).map(asLegacyMigration)) {
    applyMigration(database, migration);
  }

  database.exec(
    "ALTER TABLE leads ADD COLUMN search_batch_id TEXT NOT NULL DEFAULT ''",
  );
  database.prepare(
    `INSERT INTO leads (
      id, source_key, search_batch_id, name, industry, location, website, email,
      phone, source, stage, saved_for_launch, saved_for_launch_at, analysis_provider,
      send_provider, gmail_message_id, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', '', '', 'places', 'qualified', 1, ?,
      'test', 'pending', '', '', ?, ?)`,
  ).run(
    "lead-legacy",
    "legacy-source-key",
    "batch-before-upgrade",
    "Legacy Company",
    "studio",
    "Seattle, WA",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );

  for (const migration of migrations.slice(5)) applyMigration(database, migration);

  assert.equal(
    columnNames(database, "leads").filter((name) => name === "search_batch_id").length,
    1,
  );
  assert.deepEqual(
    { ...database
      .prepare(
        "SELECT id, source_key, search_batch_id, name FROM leads WHERE id = 'lead-legacy'",
      )
      .get() },
    {
      id: "lead-legacy",
      source_key: "legacy-source-key",
      search_batch_id: "batch-before-upgrade",
      name: "Legacy Company",
    },
  );
  assertResearchSchema(database);
  database.close();
});

test("research migration resumes safely after its tables already exist", async () => {
  const migrations = await loadMigrations();
  const database = createDatabase();
  for (const migration of migrations.slice(0, 5).map(asLegacyMigration)) {
    applyMigration(database, migration);
  }
  database.exec(
    "ALTER TABLE leads ADD COLUMN search_batch_id TEXT NOT NULL DEFAULT ''",
  );

  const statements = migrations[5].sql.split("--> statement-breakpoint");
  for (const statement of statements.slice(0, 5)) {
    if (statement.trim()) database.exec(statement);
  }
  applyMigration(database, migrations[5]);

  assertResearchSchema(database);
  assert.equal(
    columnNames(database, "leads").filter((name) => name === "search_batch_id").length,
    1,
  );
  database.close();
});

test("runtime schema bootstrap no longer hides duplicate-column errors", async () => {
  const leadsSource = await source("db/leads.ts");
  assert.doesNotMatch(
    leadsSource,
    /ALTER TABLE leads ADD COLUMN search_batch_id/,
  );
  assert.match(leadsSource, /search_batch_id TEXT NOT NULL DEFAULT ''/);
});

test("hosted migrations keep compound triggers out of migration SQL", async () => {
  const [budgetMigration, clientMigration] = await Promise.all([
    source("drizzle/0006_lean_toro.sql"),
    source("drizzle/0007_client_fulfillment_foundation.sql"),
  ]);

  for (const migration of [budgetMigration, clientMigration]) {
    assert.doesNotMatch(migration, /CREATE TRIGGER/);
    assert.doesNotMatch(
      migration,
      /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) `(?!IF NOT EXISTS)/gm,
    );
    assert.doesNotMatch(
      migration,
      /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?!IF NOT EXISTS)/gm,
    );
  }
});

test("AI budget migration resumes after a partially created legacy schema", async () => {
  const migrations = await loadMigrations();
  const database = createDatabase();
  for (const migration of migrations.slice(0, 6)) applyMigration(database, migration);

  const [ledgerTable] = migrations[6].sql.split("--> statement-breakpoint");
  database.exec(ledgerTable);
  database.prepare(
    `INSERT INTO ai_budget_ledger (
      month_start, spent_cost_micros, reserved_cost_micros, updated_at
    ) VALUES (?, ?, ?, ?)`,
  ).run("2026-07-01", 1234, 56, "before-upgrade");

  applyMigration(database, migrations[6]);
  applyMigration(database, migrations[7]);

  assert.deepEqual(
    { ...database.prepare(
      "SELECT * FROM ai_budget_ledger WHERE month_start = '2026-07-01'",
    ).get() },
    {
      month_start: "2026-07-01",
      spent_cost_micros: 1234,
      reserved_cost_micros: 56,
      updated_at: "before-upgrade",
    },
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('ai_budget_ledger', 'ai_budget_reservations')",
    ).get().count,
    2,
  );
  database.close();
});

test("client workflow migration resumes after its first table already exists", async () => {
  const migrations = await loadMigrations();
  const database = createDatabase();
  for (const migration of migrations.slice(0, 7)) applyMigration(database, migration);

  const [customerTable] = migrations[7].sql.split("--> statement-breakpoint");
  database.exec(customerTable);
  database.prepare(
    `INSERT INTO client_customers (
      id, lead_id, name, company_name, email, phone, status, created_at, updated_at
    ) VALUES (?, '', ?, ?, ?, '', 'active', ?, ?)`,
  ).run(
    "customer-before-upgrade",
    "Legacy Customer",
    "Legacy Co",
    "legacy@example.com",
    "before-upgrade",
    "before-upgrade",
  );

  applyMigration(database, migrations[7]);

  assert.deepEqual(
    { ...database.prepare(
      "SELECT id, company_name, email FROM client_customers WHERE id = 'customer-before-upgrade'",
    ).get() },
    {
      id: "customer-before-upgrade",
      company_name: "Legacy Co",
      email: "legacy@example.com",
    },
  );
  assert.equal(
    database.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'client_customers', 'client_orders', 'quote_versions', 'payment_records',
         'intake_submissions', 'client_builds', 'build_approvals', 'client_workflow_events'
       )`,
    ).get().count,
    8,
  );
  database.close();
});
