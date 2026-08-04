import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AI_BUDGET_SCHEMA_GUARDS,
  DEFAULT_MONTHLY_BUDGET_USD,
  ensureAiBudgetSchemaGuards,
  HARD_AI_MONTHLY_CAP_USD,
} from "../db/schema-guards.ts";

test("AI budget runtime and atomic guards share one cap source", () => {
  const reservationTrigger = AI_BUDGET_SCHEMA_GUARDS.find((statement) =>
    statement.includes("ai_budget_reservation_insert\n"),
  );

  assert.ok(reservationTrigger);
  assert.ok(
    reservationTrigger.includes(String(HARD_AI_MONTHLY_CAP_USD * 1_000_000)),
  );
  assert.match(
    reservationTrigger,
    new RegExp(`\\n\\s+${DEFAULT_MONTHLY_BUDGET_USD}\\n`),
  );
});

test("AI budget trigger atomically reserves, settles, and releases micros", async () => {
  const migration = await readFile(
    new URL("../drizzle/0006_lean_toro.sql", import.meta.url),
    "utf8",
  );
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ai_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ai_usage (
      id TEXT PRIMARY KEY NOT NULL,
      feature TEXT NOT NULL,
      model TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  for (const guard of AI_BUDGET_SCHEMA_GUARDS) db.exec(guard);
  db.prepare(
    "INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?)",
  ).run("monthly_budget_usd", "1", "now");
  db.prepare(
    `INSERT INTO ai_budget_ledger
     (month_start, spent_cost_micros, reserved_cost_micros, updated_at)
     VALUES (?, ?, 0, ?)`,
  ).run("2026-07-01", 900_000, "now");

  const reserve = db.prepare(
    `INSERT INTO ai_budget_reservations
     (id, month_start, feature, model, project_id, reserved_cost_micros,
      actual_cost_micros, status, created_at, updated_at)
     VALUES (?, ?, 'lead_audit', 'gpt-5.6-luna', '', ?, 0, 'reserved', ?, ?)`,
  );
  reserve.run("reservation-1", "2026-07-01", 100_000, "now", "now");
  assert.deepEqual(
    { ...db.prepare(
      "SELECT spent_cost_micros, reserved_cost_micros FROM ai_budget_ledger",
    ).get() },
    { spent_cost_micros: 900_000, reserved_cost_micros: 100_000 },
  );
  assert.throws(
    () => reserve.run("reservation-2", "2026-07-01", 1, "now", "now"),
    /AI_MONTHLY_BUDGET_EXCEEDED/,
  );
  assert.throws(
    () => reserve.run("invalid-reservation", "2026-07-01", -1, "now", "now"),
    /AI_INVALID_BUDGET_RESERVATION/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ai_budget_reservations
       SET status = 'settled', actual_cost_micros = 100001
       WHERE id = 'reservation-1'`,
    ).run(),
    /AI_INVALID_BUDGET_RESERVATION_UPDATE/,
  );

  db.prepare(
    `UPDATE ai_budget_reservations
     SET status = 'settled', actual_cost_micros = 60_000, updated_at = 'later'
     WHERE id = 'reservation-1'`,
  ).run();
  assert.deepEqual(
    { ...db.prepare(
      "SELECT spent_cost_micros, reserved_cost_micros FROM ai_budget_ledger",
    ).get() },
    { spent_cost_micros: 960_000, reserved_cost_micros: 0 },
  );

  reserve.run("reservation-3", "2026-07-01", 40_000, "now", "now");
  db.prepare(
    "UPDATE ai_budget_reservations SET status = 'released' WHERE id = ?",
  ).run("reservation-3");
  assert.deepEqual(
    { ...db.prepare(
      "SELECT spent_cost_micros, reserved_cost_micros FROM ai_budget_ledger",
    ).get() },
    { spent_cost_micros: 960_000, reserved_cost_micros: 0 },
  );
});

test("AI budget guards install once per database and retry after a failed install", async () => {
  let successfulRuns = 0;
  const database = {
    prepare: () => ({
      run: async () => {
        successfulRuns += 1;
      },
    }),
  };

  await ensureAiBudgetSchemaGuards(database);
  await ensureAiBudgetSchemaGuards(database);
  assert.equal(successfulRuns, AI_BUDGET_SCHEMA_GUARDS.length);

  let attempts = 0;
  const flakyDatabase = {
    prepare: () => ({
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary install failure");
      },
    }),
  };

  await assert.rejects(
    ensureAiBudgetSchemaGuards(flakyDatabase),
    /temporary install failure/,
  );
  await ensureAiBudgetSchemaGuards(flakyDatabase);
  assert.equal(attempts, AI_BUDGET_SCHEMA_GUARDS.length + 1);
});

test("OpenAI calls reserve before fetch and fail closed for unknown pricing", async () => {
  const [usageSource, openaiSource] = await Promise.all([
    readFile(new URL("../db/ai-usage.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/openai.ts", import.meta.url), "utf8"),
  ]);

  assert.ok(
    openaiSource.indexOf("await reserveAiBudget") <
      openaiSource.indexOf("await fetchOpenAIWithRetry"),
  );
  assert.match(openaiSource, /await settleAiBudgetReservation/);
  assert.match(openaiSource, /await releaseAiBudgetReservation/);
  assert.match(openaiSource, /if \(!openAIRequestSucceeded\)/);
  assert.match(usageSource, /await ensureAiBudgetSchemaGuards\(env\.DB\)/);
  assert.match(usageSource, /throw new Error\(`No approved pricing is configured/);
  assert.doesNotMatch(usageSource, /if \(!pricing\) return 0/);
});
