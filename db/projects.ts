import { desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  PIPELINE_STEPS,
  type BusinessInput,
  type GeneratedSite,
  type PipelineStep,
  type Project,
  type StageState,
} from "@/lib/types";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  description TEXT NOT NULL,
  audience TEXT NOT NULL,
  offer TEXT NOT NULL,
  location TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'premium',
  status TEXT NOT NULL DEFAULT 'intake',
  stages_json TEXT NOT NULL,
  site_json TEXT,
  provider TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS projects_created_at_idx ON projects (created_at)";

async function ensureSchema() {
  const d1 = env.DB;
  if (!d1) throw new Error("D1 binding DB is unavailable");
  await d1.batch([
    d1.prepare(CREATE_TABLE),
    d1.prepare(CREATE_INDEX),
  ]);
}

export async function listProjects(): Promise<Project[]> {
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(projects)
    .orderBy(desc(projects.createdAt))
    .limit(50);
  return rows.map(toProject);
}

export async function findProject(id: string): Promise<Project | null> {
  await ensureSchema();
  const [row] = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return row ? toProject(row) : null;
}

export async function createProject(input: BusinessInput): Promise<Project> {
  await ensureSchema();
  const now = new Date().toISOString();
  const stages = Object.fromEntries(
    PIPELINE_STEPS.map((step, index) => [
      step,
      index === 0 ? "done" : "queued",
    ]),
  ) as Record<PipelineStep, StageState>;

  const row = {
    id: crypto.randomUUID(),
    ...input,
    status: "intake",
    stagesJson: JSON.stringify(stages),
    siteJson: null,
    provider: "pending",
    createdAt: now,
    updatedAt: now,
  };

  await getDb().insert(projects).values(row);
  return toProject(row);
}

export async function markProjectActive(
  id: string,
  status: PipelineStep,
): Promise<void> {
  const project = await findProject(id);
  if (!project) throw new Error("Project not found");
  const stages = { ...project.stages };
  for (const step of PIPELINE_STEPS) {
    const index = PIPELINE_STEPS.indexOf(step);
    const statusIndex = PIPELINE_STEPS.indexOf(status);
    stages[step] = index < statusIndex ? "done" : index === statusIndex ? "active" : "queued";
  }
  await getDb()
    .update(projects)
    .set({
      status,
      stagesJson: JSON.stringify(stages),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id));
}

export async function completeProject(
  id: string,
  site: GeneratedSite,
  provider: "openai" | "fallback",
): Promise<Project> {
  const stages = Object.fromEntries(
    PIPELINE_STEPS.map((step) => [step, step === "deploy" ? "ready" : "done"]),
  ) as Record<PipelineStep, StageState>;

  await getDb()
    .update(projects)
    .set({
      status: "deploy",
      stagesJson: JSON.stringify(stages),
      siteJson: JSON.stringify(site),
      provider,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id));

  const project = await findProject(id);
  if (!project) throw new Error("Project not found after generation");
  return project;
}

function toProject(row: typeof projects.$inferSelect): Project {
  const parsedStages = JSON.parse(row.stagesJson) as Record<PipelineStep, StageState>;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    description: row.description,
    audience: row.audience,
    offer: row.offer,
    location: row.location,
    website: row.website,
    tone: row.tone,
    status: row.status as PipelineStep,
    stages: parsedStages,
    site: row.siteJson ? (JSON.parse(row.siteJson) as GeneratedSite) : null,
    provider: row.provider as Project["provider"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
