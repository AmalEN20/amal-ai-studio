import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// The dashboard UI is split across the main component, the lead detail
// panel, and shared lead primitives.
const dashboardSource = async () => {
  const [main, detail, shared] = await Promise.all([
    source("app/components/Dashboard.tsx"),
    source("app/components/LeadDetail.tsx"),
    source("app/components/lead-shared.tsx"),
  ]);
  return main + detail + shared;
};

test("generated lead concepts are not represented as delivered websites", async () => {
  const [types, actions, dashboard, leadStore, envExample, readme] = await Promise.all([
    source("lib/types.ts"),
    source("app/api/leads/action/route.ts"),
    dashboardSource(),
    source("db/leads.ts"),
    source(".env.example"),
    source("README.md"),
  ]);

  assert.match(types, /"concept_ready"/);
  assert.doesNotMatch(types, /"delivered"/);
  assert.match(actions, /stage:\s*"concept_ready"/);
  assert.doesNotMatch(actions, /stage:\s*"delivered"/);
  assert.match(dashboard, /concept_ready:\s*"Concept ready"/);
  assert.match(dashboard, /It has not been deployed or delivered/);
  assert.doesNotMatch(dashboard, /Site ready|sites ready/);
  assert.match(leadStore, /UPDATE leads SET stage = 'concept_ready' WHERE stage = 'delivered'/);
  assert.match(leadStore, /stage === "delivered" \? "concept_ready"/);
  assert.match(envExample, /OUTREACH_LAUNCH_ENABLED=false/);
  assert.match(readme, /OUTREACH_LAUNCH_ENABLED=false/);
});

test("sent-stage UI says that inbound replies are recorded manually", async () => {
  const dashboard = await dashboardSource();

  assert.match(dashboard, /Check Gmail manually/);
  assert.match(dashboard, /Record positive reply/);
  assert.match(dashboard, /Positive reply recorded manually/);
  assert.doesNotMatch(dashboard, /system will monitor Gmail/i);
});
