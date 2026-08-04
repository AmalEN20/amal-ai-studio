import {
  runConfiguredWebsiteIntakeBatch,
  websiteIntakeStatus,
} from "@/lib/website-intake";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;
  return Response.json(websiteIntakeStatus());
}

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;
  try {
    const payload = (await request.json().catch(() => ({}))) as { limit?: number };
    return Response.json(await runConfiguredWebsiteIntakeBatch(payload.limit));
  } catch {
    return Response.json(
      { error: "Website intake batch failed without starting an automatic retry" },
      { status: 502 },
    );
  }
}
