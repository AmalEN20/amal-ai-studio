import {
  listLeads,
  listSavedForLaunchLeads,
  saveDiscoveredLeads,
} from "@/db/leads";
import { gmailConfigured } from "@/lib/gmail";
import { discoverBusinesses } from "@/lib/lead-engine";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const [recentLeads, savedForLaunchLeads] = await Promise.all([
      listLeads(),
      listSavedForLaunchLeads(),
    ]);
    return Response.json({
      leads: recentLeads,
      savedForLaunchLeads,
      savedForLaunchCount: savedForLaunchLeads.length,
      integrations: {
        gmail: gmailConfigured(),
        googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim()),
        pageSpeed: Boolean(process.env.PAGESPEED_API_KEY?.trim()),
        openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
        outreachReady: Boolean(process.env.OUTREACH_POSTAL_ADDRESS?.trim()),
        launchEnabled: process.env.OUTREACH_LAUNCH_ENABLED === "true",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as {
      query?: string;
      location?: string;
      searchBatchId?: string;
    };
    const query = required(payload.query, "query");
    const location = required(payload.location, "location");
    const result = await discoverBusinesses(query, location);
    const searchBatchId = optionalBatchId(payload.searchBatchId);
    const leads = await saveDiscoveredLeads(result.leads, searchBatchId);
    return Response.json({
      leads,
      provider: result.provider,
      warning:
        result.provider === "demo"
          ? "Google Places is not connected, so safe demo businesses are shown."
          : null,
    });
  } catch (error) {
    return routeError(error, 400);
  }
}

function optionalBatchId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim().slice(0, 140);
}

function routeError(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status: fallbackStatus });
}
