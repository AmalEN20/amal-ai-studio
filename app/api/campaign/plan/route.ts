import { createCampaignPlan } from "@/lib/campaign-director";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as { targetCount?: number };
    const targetCount = requiredTargetCount(payload.targetCount);
    const result = await createCampaignPlan(targetCount);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 400 });
  }
}

function requiredTargetCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Qualified client target is required");
  }
  return Math.max(1, Math.min(50, Math.round(value)));
}
