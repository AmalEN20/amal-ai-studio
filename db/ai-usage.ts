import { env } from "cloudflare:workers";
import {
  DEFAULT_MONTHLY_BUDGET_USD,
  ensureAiBudgetSchemaGuards,
  HARD_AI_MONTHLY_CAP_USD,
} from "@/db/schema-guards";

export { HARD_AI_MONTHLY_CAP_USD } from "@/db/schema-guards";

export type AiFeature =
  | "campaign_plan"
  | "lead_audit"
  | "outreach_draft"
  | "site_generation";

export type OpenAIUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type AiUsageTotals = OpenAIUsage & {
  calls: number;
  estimatedCostUsd: number;
};

export type AiUsageSummary = {
  monthStart: string;
  month: AiUsageTotals;
  allTime: AiUsageTotals;
  monthlyBudgetUsd: number;
  remainingBudgetUsd: number;
  budgetUsedPercent: number;
  byFeature: Array<{
    feature: AiFeature;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
};

export type AiBudgetReservation = {
  id: string;
  monthStart: string;
  reservedCostMicros: number;
};

const CREATE_USAGE_TABLE = `CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

const CREATE_SETTINGS_TABLE = `CREATE TABLE IF NOT EXISTS ai_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_USAGE_INDEX =
  "CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at)";

const CREATE_BUDGET_LEDGER_TABLE = `CREATE TABLE IF NOT EXISTS ai_budget_ledger (
  month_start TEXT PRIMARY KEY NOT NULL,
  spent_cost_micros INTEGER NOT NULL DEFAULT 0,
  reserved_cost_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`;

const CREATE_BUDGET_RESERVATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  month_start TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  reserved_cost_micros INTEGER NOT NULL,
  actual_cost_micros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_BUDGET_RESERVATIONS_INDEX =
  "CREATE INDEX IF NOT EXISTS ai_budget_reservations_month_status_idx ON ai_budget_reservations (month_start, status)";

async function ensureSchema() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  await env.DB.batch([
    env.DB.prepare(CREATE_USAGE_TABLE),
    env.DB.prepare(CREATE_SETTINGS_TABLE),
    env.DB.prepare(CREATE_BUDGET_LEDGER_TABLE),
    env.DB.prepare(CREATE_BUDGET_RESERVATIONS_TABLE),
    env.DB.prepare(CREATE_USAGE_INDEX),
    env.DB.prepare(CREATE_BUDGET_RESERVATIONS_INDEX),
  ]);
  await ensureAiBudgetSchemaGuards(env.DB);
}

export async function reserveAiBudget(input: {
  feature: AiFeature;
  model: string;
  projectId?: string;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
}): Promise<AiBudgetReservation> {
  await ensureSchema();

  // pricingForModel throws before any network request for an unknown model.
  const reservedCostMicros = estimateOpenAIRequestReservationMicros(input.model, {
    instructions: input.instructions,
    prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens,
  });
  const id = crypto.randomUUID();
  const monthStart = startOfCurrentMonth();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_budget_ledger (
        month_start, spent_cost_micros, reserved_cost_micros, updated_at
      )
      SELECT ?, COALESCE(SUM(estimated_cost_micros), 0), 0, ?
      FROM ai_usage WHERE created_at >= ?
      ON CONFLICT(month_start) DO NOTHING`,
    ).bind(monthStart, now, monthStart),
    env.DB.prepare(
      `UPDATE ai_budget_ledger
       SET spent_cost_micros = MAX(
         spent_cost_micros,
         COALESCE((
           SELECT SUM(estimated_cost_micros)
           FROM ai_usage WHERE created_at >= ?
         ), 0)
       ), updated_at = ?
       WHERE month_start = ?`,
    ).bind(monthStart, now, monthStart),
  ]);

  try {
    await env.DB.prepare(
      `INSERT INTO ai_budget_reservations (
        id, month_start, feature, model, project_id, reserved_cost_micros,
        actual_cost_micros, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?)`,
    )
      .bind(
        id,
        monthStart,
        input.feature,
        input.model,
        input.projectId ?? "",
        reservedCostMicros,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (isBudgetExceededError(error)) {
      throw new Error(
        `AI monthly budget cannot cover this request. Requests are blocked before calling OpenAI (hard cap: $${HARD_AI_MONTHLY_CAP_USD}).`,
      );
    }
    throw new Error("AI budget ledger is unavailable; OpenAI request blocked for safety", {
      cause: error,
    });
  }

  return { id, monthStart, reservedCostMicros };
}

export async function settleAiBudgetReservation(input: {
  reservation: AiBudgetReservation;
  model: string;
  usage: OpenAIUsage;
}) {
  await ensureSchema();
  const actualCostMicros = estimateOpenAICostMicros(input.model, input.usage);
  if (actualCostMicros > input.reservation.reservedCostMicros) {
    throw new Error(
      "OpenAI usage exceeded its fail-safe reservation; the reservation remains held and further requests are blocked",
    );
  }

  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_usage (
        id, feature, model, project_id, input_tokens, cached_input_tokens,
        output_tokens, reasoning_tokens, total_tokens, estimated_cost_micros, created_at
      )
      SELECT ?, feature, ?, project_id, ?, ?, ?, ?, ?, ?, ?
      FROM ai_budget_reservations
      WHERE id = ? AND status = 'reserved'`,
    ).bind(
      crypto.randomUUID(),
      input.model,
      input.usage.inputTokens,
      input.usage.cachedInputTokens,
      input.usage.outputTokens,
      input.usage.reasoningTokens,
      input.usage.totalTokens,
      actualCostMicros,
      now,
      input.reservation.id,
    ),
    env.DB.prepare(
      `UPDATE ai_budget_reservations
       SET status = 'settled', actual_cost_micros = ?, updated_at = ?
       WHERE id = ? AND status = 'reserved'`,
    ).bind(actualCostMicros, now, input.reservation.id),
  ]);

  if (numeric(results[1]?.meta?.changes) !== 1) {
    throw new Error("AI budget reservation was already settled or released");
  }
}

export async function releaseAiBudgetReservation(reservationId: string) {
  await ensureSchema();
  const result = await env.DB.prepare(
    `UPDATE ai_budget_reservations
     SET status = 'released', updated_at = ?
     WHERE id = ? AND status = 'reserved'`,
  )
    .bind(new Date().toISOString(), reservationId)
    .run();
  if (numeric(result.meta?.changes) !== 1) {
    throw new Error("AI budget reservation was already settled or released");
  }
}

export async function getAiUsageSummary(): Promise<AiUsageSummary> {
  await ensureSchema();
  const monthStart = startOfCurrentMonth();
  const [month, allTime, budgetRow, byFeatureResult, ledgerRow] = await Promise.all([
    totalsSince(monthStart),
    totalsSince(null),
    env.DB.prepare("SELECT value FROM ai_settings WHERE key = ?")
      .bind("monthly_budget_usd")
      .first<{ value: string }>(),
    env.DB.prepare(
      `SELECT feature, COUNT(*) AS calls,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_micros), 0) AS estimated_cost_micros
       FROM ai_usage WHERE created_at >= ?
       GROUP BY feature ORDER BY estimated_cost_micros DESC`,
    )
      .bind(monthStart)
      .all<FeatureRow>(),
    env.DB.prepare(
      `SELECT reserved_cost_micros FROM ai_budget_ledger WHERE month_start = ?`,
    )
      .bind(monthStart)
      .first<{ reserved_cost_micros: number | string | null }>(),
  ]);

  const storedBudget = Number(budgetRow?.value);
  const configuredBudget = Number.isFinite(storedBudget) && storedBudget > 0
    ? storedBudget
    : DEFAULT_MONTHLY_BUDGET_USD;
  const monthlyBudgetUsd = Math.min(configuredBudget, HARD_AI_MONTHLY_CAP_USD);
  const reservedBudgetUsd = microsToUsd(ledgerRow?.reserved_cost_micros);
  const remainingBudgetUsd = Math.max(
    0,
    monthlyBudgetUsd - month.estimatedCostUsd - reservedBudgetUsd,
  );

  return {
    monthStart,
    month,
    allTime,
    monthlyBudgetUsd,
    remainingBudgetUsd,
    budgetUsedPercent: Math.min(100, (month.estimatedCostUsd / monthlyBudgetUsd) * 100),
    byFeature: (byFeatureResult.results ?? []).map((row: FeatureRow) => ({
      feature: row.feature as AiFeature,
      calls: Number(row.calls) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      estimatedCostUsd: microsToUsd(row.estimated_cost_micros),
    })),
  };
}

export async function setAiMonthlyBudget(monthlyBudgetUsd: number) {
  if (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 1 || monthlyBudgetUsd > HARD_AI_MONTHLY_CAP_USD) {
    throw new Error(`Monthly AI budget must be between $1 and $${HARD_AI_MONTHLY_CAP_USD}`);
  }
  await ensureSchema();
  await env.DB.prepare(
    `INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind("monthly_budget_usd", monthlyBudgetUsd.toFixed(2), new Date().toISOString())
    .run();
}

export async function assertAiBudgetAvailable() {
  const summary = await getAiUsageSummary();
  if (summary.remainingBudgetUsd <= 0) {
    throw new Error(
      `AI monthly budget reached. Requests are blocked until the next month or an owner-approved budget change (hard cap: $${HARD_AI_MONTHLY_CAP_USD}).`,
    );
  }
  return summary;
}

type TotalsRow = {
  calls: number | string | null;
  input_tokens: number | string | null;
  cached_input_tokens: number | string | null;
  output_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  total_tokens: number | string | null;
  estimated_cost_micros: number | string | null;
};

type FeatureRow = {
  feature: string;
  calls: number | string;
  total_tokens: number | string;
  estimated_cost_micros: number | string;
};

async function totalsSince(since: string | null): Promise<AiUsageTotals> {
  const where = since ? " WHERE created_at >= ?" : "";
  const statement = env.DB.prepare(
    `SELECT COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(estimated_cost_micros), 0) AS estimated_cost_micros
     FROM ai_usage${where}`,
  );
  const row = since
    ? await statement.bind(since).first<TotalsRow>()
    : await statement.first<TotalsRow>();
  return {
    calls: numeric(row?.calls),
    inputTokens: numeric(row?.input_tokens),
    cachedInputTokens: numeric(row?.cached_input_tokens),
    outputTokens: numeric(row?.output_tokens),
    reasoningTokens: numeric(row?.reasoning_tokens),
    totalTokens: numeric(row?.total_tokens),
    estimatedCostUsd: microsToUsd(row?.estimated_cost_micros),
  };
}

export function estimateOpenAICostMicros(model: string, usage: OpenAIUsage): number {
  const pricing = pricingForModel(model);
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const usd =
    (uncachedInput / 1_000_000) * pricing.inputPerMillion +
    (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.max(0, Math.round(usd * 1_000_000));
}

export function estimateOpenAIRequestReservationMicros(
  model: string,
  input: { instructions: string; prompt: string; maxOutputTokens: number },
): number {
  const pricing = pricingForModel(model);
  // A BPE token contains at least one input byte. The extra 2,048 tokens cover
  // Responses API framing and leave a conservative margin for hidden metadata.
  const inputTokenUpperBound =
    utf8ByteLength(input.instructions) + utf8ByteLength(input.prompt) + 2_048;
  const outputTokenUpperBound = Math.max(0, Math.round(input.maxOutputTokens));
  const usd =
    (inputTokenUpperBound / 1_000_000) * pricing.inputPerMillion +
    (outputTokenUpperBound / 1_000_000) * pricing.outputPerMillion;
  return Math.max(1, Math.ceil(usd * 1_000_000));
}

function pricingForModel(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-5.6-luna")) {
    return { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 6 };
  }
  throw new Error(`No approved pricing is configured for OpenAI model: ${model}`);
}

function startOfCurrentMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function numeric(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function microsToUsd(value: number | string | null | undefined): number {
  return Math.round((numeric(value) / 1_000_000) * 1_000_000) / 1_000_000;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBudgetExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AI_MONTHLY_BUDGET_EXCEEDED");
}
