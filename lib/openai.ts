import {
  releaseAiBudgetReservation,
  reserveAiBudget,
  settleAiBudgetReservation,
  type AiFeature,
  type OpenAIUsage,
} from "@/db/ai-usage";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

export function openAIConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function configuredOpenAIModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

export async function generateOpenAIText(input: {
  feature: AiFeature;
  instructions: string;
  prompt: string;
  projectId?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const model = configuredOpenAIModel();
  const maxOutputTokens = clamp(input.maxOutputTokens ?? 1800, 128, 4_000);
  const timeoutMs = clamp(input.timeoutMs ?? 60_000, 5_000, 120_000);
  const reservation = await reserveAiBudget({
    feature: input.feature,
    model,
    projectId: input.projectId,
    instructions: input.instructions,
    prompt: input.prompt,
    maxOutputTokens,
  });
  let openAIRequestSucceeded = false;

  try {
    const response = await fetchOpenAIWithRetry({
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        model,
        instructions: input.instructions,
        input: input.prompt,
        max_output_tokens: maxOutputTokens,
      }),
    }, timeoutMs);

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI returned ${response.status}: ${detail.slice(0, 180)}`);
    }

    openAIRequestSucceeded = true;
    const payload = (await response.json()) as OpenAIResponse;
    const outputText = readOutputText(payload);
    await settleAiBudgetReservation({
      reservation,
      model: payload.model || model,
      usage: normalizeUsage(payload.usage),
    });
    return outputText;
  } catch (error) {
    if (!openAIRequestSucceeded) {
      try {
        await releaseAiBudgetReservation(reservation.id);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "OpenAI request failed and its AI budget reservation could not be released",
        );
      }
    }
    // If OpenAI succeeded but response parsing or settlement failed, keep the
    // full reservation held. This is deliberately fail-closed: unknown spend
    // can never be returned to the available balance.
    throw error;
  }
}

type OpenAIResponse = {
  model?: string;
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

function normalizeUsage(usage: OpenAIResponse["usage"]): OpenAIUsage {
  const inputTokens = safeTokenCount(usage?.input_tokens);
  const outputTokens = safeTokenCount(usage?.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: safeTokenCount(usage?.input_tokens_details?.cached_tokens),
    outputTokens,
    reasoningTokens: safeTokenCount(usage?.output_tokens_details?.reasoning_tokens),
    totalTokens: safeTokenCount(usage?.total_tokens) || inputTokens + outputTokens,
  };
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function readOutputText(payload: OpenAIResponse): string {
  if (payload.output_text) return payload.output_text;
  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && item.text)
    .map((item) => item.text)
    .join("");
  if (!text) throw new Error("OpenAI response did not contain text");
  return text;
}

const RETRYABLE_OPENAI_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function fetchOpenAIWithRetry(
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const attempts = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (
        response.ok ||
        !RETRYABLE_OPENAI_STATUS.has(response.status) ||
        attempt === attempts - 1
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelay(response.headers.get("retry-after"), attempt));
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await wait(retryDelay(null, attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenAI request failed after retries");
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(8_000, Math.max(0, seconds * 1_000));
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(8_000, dateDelay);
  }
  return Math.min(5_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
