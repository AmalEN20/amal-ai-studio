import { verifyGmailConnection } from "@/lib/gmail";
import { discoverBusinesses } from "@/lib/lead-engine";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; detail: string };

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  const [googlePlaces, pageSpeed, gmail] = await Promise.all([
    runCheck(async () => {
      const result = await discoverBusinesses("dentists", "Bellevue, WA");
      if (result.provider !== "google_places") throw new Error("Google Places key is missing");
      return `${result.leads.length} live businesses found`;
    }),
    runCheck(verifyPageSpeed),
    runCheck(async () => {
      const result = await verifyGmailConnection();
      return `Connected as ${result.sender}`;
    }),
  ]);

  const complianceReady = Boolean(process.env.OUTREACH_POSTAL_ADDRESS?.trim());
  const launchEnabled = process.env.OUTREACH_LAUNCH_ENABLED === "true";
  return Response.json({
    checks: {
      googlePlaces,
      pageSpeed,
      gmail,
      outreach: {
        ok: complianceReady && launchEnabled,
        detail: !launchEnabled
          ? "Launch mode is paused — suitable leads are saved only"
          : complianceReady
            ? "Launch mode enabled and compliance address configured"
            : "Launch blocked until the public business mailbox is added",
      } satisfies Check,
    },
  });
}

async function verifyPageSpeed(): Promise<string> {
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (!key) throw new Error("PageSpeed key is missing");

  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", "https://www.google.com");
  endpoint.searchParams.set("strategy", "mobile");
  endpoint.searchParams.set("category", "performance");
  endpoint.searchParams.set("key", key);

  const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PageSpeed returned ${response.status}`);
  const payload = (await response.json()) as {
    lighthouseResult?: { categories?: { performance?: { score?: number } } };
  };
  const score = payload.lighthouseResult?.categories?.performance?.score;
  return typeof score === "number"
    ? `Live test passed (${Math.round(score * 100)}/100)`
    : "Live test passed";
}

async function runCheck(task: () => Promise<string>): Promise<Check> {
  try {
    return { ok: true, detail: await task() };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 160) : "Connection failed",
    };
  }
}
