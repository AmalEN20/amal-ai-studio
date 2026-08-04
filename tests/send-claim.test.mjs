import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("real email sends require an atomic approved-to-sending claim", async () => {
  const [leadActions, leadStore, types] = await Promise.all([
    source("app/api/leads/action/route.ts"),
    source("db/leads.ts"),
    source("lib/types.ts"),
  ]);

  const claimStart = leadStore.indexOf(
    "export async function claimApprovedLeadForSending",
  );
  const releaseStart = leadStore.indexOf(
    "export async function releaseLeadSendClaim",
  );
  const claim = leadStore.slice(claimStart, releaseStart);
  const release = leadStore.slice(
    releaseStart,
    leadStore.indexOf("function toLead", releaseStart),
  );

  assert.ok(claimStart >= 0);
  assert.ok(releaseStart > claimStart);
  assert.match(types, /"approved",\s*"sending",\s*"sent"/);
  assert.match(claim, /stage:\s*"sending"/);
  assert.match(
    claim,
    /where\(and\(eq\(leads\.id, id\), eq\(leads\.stage, "approved"\)\)\)/,
  );
  assert.match(claim, /\.returning\(\)/);
  assert.match(release, /stage:\s*"approved"/);
  assert.match(
    release,
    /where\(and\(eq\(leads\.id, id\), eq\(leads\.stage, "sending"\)\)\)/,
  );

  const routeClaim = leadActions.indexOf(
    "await claimApprovedLeadForSending(lead.id)",
  );
  const gmailSend = leadActions.indexOf("await sendLeadEmail(claimedLead)");
  const failureRelease = leadActions.indexOf(
    "await releaseLeadSendClaim(claimedLead.id, message)",
  );
  assert.ok(routeClaim >= 0);
  assert.ok(gmailSend > routeClaim);
  assert.ok(failureRelease > gmailSend);
  assert.match(leadActions, /status:\s*409/);
  assert.match(leadActions, /error instanceof GmailSendError && error\.mayHaveSent/);
  assert.match(leadActions, /Automatic retry is locked to prevent a duplicate/);
});

test("ambiguous Gmail failures remain locked and every network call has a timeout", async () => {
  const gmail = await source("lib/gmail.ts");

  assert.match(gmail, /class GmailSendError extends Error/);
  assert.match(gmail, /Gmail delivery status is unknown/);
  assert.match(gmail, /AbortSignal\.timeout\(20_000\)/);
  assert.match(gmail, /AbortSignal\.timeout\(15_000\)/);
  assert.match(gmail, /response\.status === 408/);
  assert.match(gmail, /response\.status === 409/);
  assert.match(gmail, /response\.status >= 500/);
});

test("research skips leads while an email send is in flight", async () => {
  const researchStep = await source("app/api/research/jobs/step/route.ts");
  const skipStart = researchStep.indexOf("function isPreviouslyProcessedLead");
  const skipList = researchStep.slice(
    skipStart,
    researchStep.indexOf("function countOutcomes", skipStart),
  );

  assert.ok(skipStart >= 0);
  assert.match(skipList, /"sending"/);
});
