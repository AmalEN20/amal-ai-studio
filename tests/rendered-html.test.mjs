import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the private acquisition dashboard and complete pipeline", async () => {
  const [page, layout, dashboardMain, leadDetail, leadShared, usageDashboard, usagePage, leadEngine, openai, aiUsageRoute, campaignDirector, campaignRoute, gmail, leadActions, leadSchema, viteConfig] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/LeadDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/lead-shared.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AiUsageDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/usage/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/lead-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/openai.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai-usage/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/campaign-director.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/campaign/plan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/gmail.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/leads/action/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);
  const dashboard = dashboardMain + leadDetail + leadShared;

  assert.match(layout, /Amal AI Studio — Private AI Acquisition OS/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /requireChatGPTUser/);
  assert.match(page, /getConfiguredOwnerEmail/);
  assert.ok(dashboardMain.indexOf("export function Dashboard") >= 0);
  // The legacy dashboard was removed; the rendered Dashboard must expose
  // exactly one visible <h1> with the approved heading.
  const visibleHeadings = [...dashboardMain.matchAll(/<h1[^>]*>([^<]+)<\/h1>/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(visibleHeadings, [
    "Building What Others Can’t Imagine.",
  ]);
  assert.doesNotMatch(dashboard, /LegacyDashboard/);
  assert.doesNotMatch(dashboard, /Build a qualified opportunity base\./);
  assert.match(dashboard, /QUALIFIED RESEARCH/);
  assert.match(dashboard, /Qualified opportunities to find/);
  assert.match(dashboard, /Start research/);
  assert.match(dashboard, /Current search/);
  assert.match(dashboard, /Previous searches/);
  assert.match(dashboard, /New search/);
  assert.match(dashboard, /Nothing is sent automatically/);
  assert.match(dashboard, /Opportunity queue/);
  assert.match(dashboard, /Run AI audit/);
  assert.match(dashboard, /Generate concept/);
  assert.match(dashboard, /Check Gmail manually/);
  assert.doesNotMatch(dashboard, /system will monitor Gmail/i);
  assert.match(dashboard, /concept_ready/);
  assert.doesNotMatch(leadActions, /stage:\s*"delivered"/);
  assert.match(leadActions, /stage:\s*"concept_ready"/);
  assert.match(dashboard, /landing-preview/);
  assert.match(dashboard, /AI usage/);
  assert.doesNotMatch(dashboard, /[А-Яа-яЁё]/);
  assert.match(usageDashboard, /AI usage,/);
  assert.match(usageDashboard, /Local budget remaining/);
  assert.match(usageDashboard, /Refresh ledger/);
  assert.match(usagePage, /requireChatGPTUser/);
  assert.match(leadEngine, /places:searchText/);
  assert.match(openai, /api\.openai\.com\/v1\/responses/);
  assert.match(openai, /reserveAiBudget/);
  assert.match(openai, /settleAiBudgetReservation/);
  assert.match(openai, /releaseAiBudgetReservation/);
  assert.match(openai, /max_output_tokens:/);
  assert.match(aiUsageRoute, /getAiUsageSummary/);
  assert.match(aiUsageRoute, /setAiMonthlyBudget/);
  assert.match(leadEngine, /demoLeads/);
  assert.match(leadEngine, /findPublicBusinessEmail/);
  assert.match(leadEngine, /audit\.serviceFit === "ideal"/);
  assert.doesNotMatch(leadEngine, /MIN_QUALIFIED_SCORE|audit\.score\s*>?=/);
  assert.match(campaignDirector, /MAX_TARGETS = 50/);
  assert.match(campaignDirector, /targetCount/);
  assert.match(campaignDirector, /owner approval before any email is sent/);
  assert.match(campaignRoute, /createCampaignPlan/);
  assert.match(gmail, /gmail\/v1\/users\/me\/messages\/send/);
  assert.match(gmail, /OUTREACH_POSTAL_ADDRESS/);
  assert.match(gmail, /Reply “unsubscribe”/);
  assert.match(leadActions, /lead\.stage !== "approved"/);
  assert.match(leadActions, /isQualifiedOpportunity/);
  assert.match(leadActions, /lead\.stage !== "sent"/);
  assert.match(leadActions, /stage: "unsubscribed"/);
  assert.match(dashboard, /PUBLIC BUSINESS EMAIL/);
  assert.match(dashboard, /Find public email/);
  assert.match(dashboard, /PO Box required/);
  assert.match(leadSchema, /searchBatchId/);
  // Fresh clones have no private .openai/hosting.json; the build must fall
  // back to the standard local binding names.
  assert.match(viteConfig, /d1: "DB", r2: "INTAKE_ASSETS"/);
  assert.match(viteConfig, /existsSync\(hostingPath\)/);
  assert.doesNotMatch(page + layout + dashboard, /codex-preview|react-loading-skeleton/i);
});
