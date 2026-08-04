import {
  getAiUsageSummary,
  setAiMonthlyBudget,
} from "@/db/ai-usage";
import {
  configuredOpenAIModel,
  openAIConfigured,
} from "@/lib/openai";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    return Response.json(await usagePayload());
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as { monthlyBudgetUsd?: unknown };
    const monthlyBudgetUsd = Number(payload.monthlyBudgetUsd);
    await setAiMonthlyBudget(monthlyBudgetUsd);
    return Response.json(await usagePayload());
  } catch (error) {
    return routeError(error, 400);
  }
}

async function usagePayload() {
  return {
    configured: openAIConfigured(),
    model: configuredOpenAIModel(),
    summary: await getAiUsageSummary(),
  };
}

function routeError(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status });
}
