import { createLinkedWebsiteIntakeUrl } from "@/lib/website-intake";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;
  try {
    const payload = (await request.json()) as {
      leadId?: string;
      expiresInSeconds?: number;
    };
    if (typeof payload.leadId !== "string" || !payload.leadId.trim()) {
      return Response.json({ error: "leadId is required" }, { status: 400 });
    }
    return Response.json(
      await createLinkedWebsiteIntakeUrl({
        leadId: payload.leadId.trim(),
        expiresInSeconds: payload.expiresInSeconds,
      }),
      { status: 201 },
    );
  } catch {
    return Response.json(
      { error: "Linked website intake is unavailable or has no exact correlation" },
      { status: 409 },
    );
  }
}
