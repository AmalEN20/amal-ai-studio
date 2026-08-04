import {
  completeProject,
  findProject,
  markProjectActive,
} from "@/db/projects";
import { generateSite } from "@/lib/generator";
import { guardOwnerApi } from "@/lib/owner-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as { projectId?: string };
    if (!payload.projectId) {
      return Response.json({ error: "projectId is required" }, { status: 400 });
    }

    const project = await findProject(payload.projectId);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    await markProjectActive(project.id, "research");
    const result = await generateSite(project);
    await markProjectActive(project.id, "qa");
    const completed = await completeProject(project.id, result.site, result.provider);

    return Response.json({ project: completed, warning: result.warning ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
