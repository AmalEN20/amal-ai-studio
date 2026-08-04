import {
  createOrResumeResearchJob,
  findActiveResearchJob,
  finishResearchJob,
  getResearchJob,
  listResearchJobLeads,
  listResearchJobs,
} from "@/db/research-jobs";
import { createCampaignPlan } from "@/lib/campaign-director";
import { guardOwnerApi } from "@/lib/owner-auth";
import { safeOperationalErrorMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return Response.json({ jobs: await listResearchJobs(20) });
    }

    const job = await getResearchJob(id);
    if (!job) {
      return Response.json({ error: "Research job not found" }, { status: 404 });
    }

    return Response.json(await jobSnapshot(job));
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as { targetCount?: number };
    const targetCount = requiredTargetCount(payload.targetCount);
    const active = await findActiveResearchJob();
    if (active) {
      return Response.json({ job: active, provider: "existing", resumed: true });
    }
    const { plan, provider } = await createCampaignPlan(targetCount);

    // Owner intent is authoritative even if a model-generated plan is ever
    // malformed. Research also never prepares or sends outreach.
    const result = await createOrResumeResearchJob({
      ...plan,
      targetCount,
      prepareDrafts: false,
    });

    return Response.json(
      {
        job: result.job,
        provider: result.created ? provider : "existing",
        resumed: !result.created,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return routeError(error, 400);
  }
}

export async function DELETE(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return Response.json({ error: "Research job id is required" }, { status: 400 });
    }
    const job = await getResearchJob(id);
    if (!job) {
      return Response.json({ error: "Research job not found" }, { status: 404 });
    }
    if (job.status !== "running") return Response.json({ job });

    return Response.json({
      job: await finishResearchJob(
        id,
        "cancelled",
        "Cancelled by the owner. Qualified opportunities already saved were kept.",
      ),
    });
  } catch (error) {
    return routeError(error);
  }
}

async function jobSnapshot(job: NonNullable<Awaited<ReturnType<typeof getResearchJob>>>) {
  const entries = await listResearchJobLeads(job.id);
  return {
    job,
    entries,
    // A flat list keeps the dashboard contract simple while entries preserves
    // per-run status for diagnostics and future filters.
    leads: entries.map(({ lead, membership }) => ({
      ...lead,
      researchStatus: membership.status,
      researchError: membership.error,
    })),
  };
}

function requiredTargetCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Qualified opportunity target is required");
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 50) {
    throw new Error("Qualified opportunity target must be between 1 and 50");
  }
  return rounded;
}

function routeError(error: unknown, status = 500) {
  return Response.json(
    { error: safeOperationalErrorMessage(error) },
    { status },
  );
}
