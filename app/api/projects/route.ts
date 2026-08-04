import { createProject, listProjects } from "@/db/projects";
import { guardOwnerApi } from "@/lib/owner-auth";
import type { BusinessInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    return Response.json({ projects: await listProjects() });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as Partial<BusinessInput>;
    const input: BusinessInput = {
      name: required(payload.name, "name"),
      industry: required(payload.industry, "industry"),
      description: required(payload.description, "description"),
      audience: required(payload.audience, "audience"),
      offer: required(payload.offer, "offer"),
      location: optional(payload.location),
      website: optional(payload.website),
      tone: optional(payload.tone) || "premium",
    };

    const project = await createProject(input);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return routeError(error, 400);
  }
}

function required(value: unknown, field: string): string {
  const cleaned = optional(value);
  if (!cleaned) throw new Error(`${field} is required`);
  return cleaned;
}

function optional(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 1600) : "";
}

function routeError(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status = message.includes("required") ? 400 : fallbackStatus;
  return Response.json({ error: message }, { status });
}
