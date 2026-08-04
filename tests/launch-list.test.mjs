import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function listSavedForLaunchPages(database, pageSize = 37) {
  const saved = [];
  let cursor = null;

  while (true) {
    const rows = cursor
      ? database.prepare(
          `SELECT id, saved_for_launch, audit_json, updated_at
           FROM leads
           WHERE saved_for_launch = 1
             AND (updated_at < ? OR (updated_at = ? AND id < ?))
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        ).all(cursor.updatedAt, cursor.updatedAt, cursor.id, pageSize)
      : database.prepare(
          `SELECT id, saved_for_launch, audit_json, updated_at
           FROM leads
           WHERE saved_for_launch = 1
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        ).all(pageSize);

    saved.push(...rows);
    if (rows.length < pageSize) break;
    const last = rows.at(-1);
    cursor = { id: last.id, updatedAt: last.updated_at };
  }

  return saved;
}

test("old saved launch members remain complete beyond the recent-500 window", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY NOT NULL,
      saved_for_launch INTEGER NOT NULL,
      audit_json TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = database.prepare(
    "INSERT INTO leads (id, saved_for_launch, audit_json, updated_at) VALUES (?, ?, ?, ?)",
  );

  database.exec("BEGIN");
  try {
    for (let index = 0; index < 100; index += 1) {
      insert.run(
        `saved-${String(index).padStart(3, "0")}`,
        1,
        index % 2 === 0 ? null : JSON.stringify({ serviceFit: "not_fit" }),
        new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      );
    }
    for (let index = 0; index < 464; index += 1) {
      insert.run(
        `recent-${String(index).padStart(3, "0")}`,
        0,
        JSON.stringify({ serviceFit: "ideal" }),
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const recentWindow = database.prepare(
    `SELECT COALESCE(SUM(saved_for_launch), 0) AS saved_count
     FROM (
       SELECT saved_for_launch FROM leads ORDER BY updated_at DESC LIMIT 500
     )`,
  ).get();
  assert.equal(recentWindow.saved_count, 36);

  const durableSaved = listSavedForLaunchPages(database);
  assert.equal(durableSaved.length, 100);
  assert.ok(durableSaved.every((lead) => lead.saved_for_launch === 1));
  assert.ok(durableSaved.some((lead) => lead.audit_json === null));
  assert.ok(durableSaved.some((lead) => lead.audit_json?.includes("not_fit")));
  database.close();

  const [leadStore, leadsRoute, dashboard, leadShared] = await Promise.all([
    source("db/leads.ts"),
    source("app/api/leads/route.ts"),
    source("app/components/Dashboard.tsx"),
    source("app/components/lead-shared.tsx"),
  ]);
  assert.match(leadStore, /export async function listSavedForLaunchLeads/);
  assert.match(leadStore, /eq\(leads\.savedForLaunch, true\)/);
  assert.match(leadStore, /orderBy\(desc\(leads\.updatedAt\), desc\(leads\.id\)\)/);
  assert.match(leadsRoute, /savedForLaunchLeads/);
  assert.match(
    leadsRoute,
    /savedForLaunchCount:\s*savedForLaunchLeads\.length/,
  );

  const launchGateStart = leadShared.indexOf("function isLaunchReadyLead");
  assert.ok(launchGateStart >= 0);
  const launchGateEnd = leadShared.indexOf("}", launchGateStart);
  const launchGate = leadShared.slice(launchGateStart, launchGateEnd);
  assert.match(launchGate, /return lead\.savedForLaunch/);
  assert.doesNotMatch(launchGate, /audit|serviceFit/);

  assert.match(
    dashboard,
    /if \(queueView === "launch"\) return savedLaunch\.leads/,
  );
  assert.match(dashboard, /saved:\s*savedLaunch\.count/);
});
