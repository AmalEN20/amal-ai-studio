export const WEBSITE_API_VERSION = "2026-07-16";
export const WEBSITE_FORM_SCHEMA_VERSION = 3;

const MAX_LIST_LIMIT = 25;
const DEFAULT_LIST_LIMIT = 10;
const CLAIM_LEASE_SECONDS = 300;
const MAX_ASSETS_PER_SUBMISSION = 25;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_SUBMISSION_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export type WebsiteIntakeConfig = {
  baseUrl: string;
  apiToken: string;
  workerId: string;
};

export type WebsiteIntakeImportRecord = {
  aiOsRecordId: string;
  leadId: string;
  acknowledged: boolean;
};

export type WebsiteLinkedLead = {
  id: string;
  normalizedEmail: string;
  gmailThreadId: string;
};

export type WebsiteIntakeAsset = {
  assetId: string;
  filename: string;
  contentType: string;
  role: string;
  sizeBytes: number;
  sha256: string;
  downloadPath: string;
};

export type WebsiteIntakeSubmission = {
  submissionId: string;
  publicReference: string;
  schemaVersion: number;
  source: "website" | "gmail_outreach";
  normalizedEmail: string;
  contactName: string;
  businessName: string;
  industry: string;
  projectType: string;
  primaryGoal: string;
  audience: string;
  answers: unknown;
  correlation: {
    leadRef: string;
    gmailThreadRef: string;
    contactEmail: string;
  } | null;
  assets: WebsiteIntakeAsset[];
  raw: unknown;
};

export type StoredWebsiteIntakeAsset = WebsiteIntakeAsset & {
  objectKey: string;
};

export type WebsiteIntakeRepository = {
  findImport(submissionId: string): Promise<WebsiteIntakeImportRecord | null>;
  findLinkedLead(leadRef: string): Promise<WebsiteLinkedLead | null>;
  commitImport(input: {
    submission: WebsiteIntakeSubmission;
    linkedLeadId: string | null;
    assets: StoredWebsiteIntakeAsset[];
  }): Promise<WebsiteIntakeImportRecord>;
  markAcknowledged(submissionId: string): Promise<void>;
};

export type WebsiteIntakeAssetStore = {
  put(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<string>;
};

type WebsiteIntakeBatchResult = {
  status: "disabled" | "completed";
  listed: number;
  imported: number;
  acknowledged: number;
  released: number;
  skipped: number;
};

class WebsiteIntakeError extends Error {
  readonly releaseReason: string;

  constructor(message: string, releaseReason: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WebsiteIntakeError";
    this.releaseReason = releaseReason;
  }
}

class WebsiteHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Website intake API returned ${status}`);
    this.name = "WebsiteHttpError";
    this.status = status;
  }
}

export function readWebsiteIntakeConfig(
  values: Record<string, string | undefined> = process.env,
): WebsiteIntakeConfig | null {
  const baseUrl = values.EVELE_WEBSITE_BASE_URL?.trim();
  const apiToken = values.EVELE_WEBSITE_API_TOKEN?.trim();
  const workerId = values.EVELE_WEBSITE_IMPORT_WORKER_ID?.trim();
  if (!baseUrl || !apiToken || !workerId) return null;
  if (apiToken.length > 4096 || /[\r\n]/.test(apiToken)) return null;
  if (!isOpaqueIdentifier(workerId)) return null;

  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return { baseUrl: parsed.origin, apiToken, workerId };
  } catch {
    return null;
  }
}

export async function runWebsiteIntakeBatch(input: {
  config: WebsiteIntakeConfig | null;
  fetchImpl?: typeof fetch;
  repository: WebsiteIntakeRepository;
  assetStore: WebsiteIntakeAssetStore;
  listLimit?: number;
}): Promise<WebsiteIntakeBatchResult> {
  if (!input.config) return emptyBatchResult("disabled");
  const config = assertConfig(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  const listLimit = clampInteger(
    input.listLimit ?? DEFAULT_LIST_LIMIT,
    1,
    MAX_LIST_LIMIT,
  );
  const listUrl = internalUrl(config, "/api/internal/v1/intake/submissions");
  listUrl.searchParams.set("status", "ready");
  listUrl.searchParams.set("limit", String(listLimit));
  const listPayload = await requestJson(fetchImpl, listUrl, config);
  const ready = parseReadyList(listPayload).slice(0, listLimit);
  const result = emptyBatchResult("completed");
  result.listed = ready.length;

  for (const item of ready) {
    let claimToken = "";
    try {
      const claimPayload = await requestJson(
        fetchImpl,
        internalUrl(config, "/api/internal/v1/intake/claims"),
        config,
        {
          method: "POST",
          body: {
            submission_id: item.submissionId,
            worker_id: config.workerId,
            lease_seconds: CLAIM_LEASE_SECONDS,
          },
        },
      );
      claimToken = requiredString(claimPayload, "claim_token", 512);

      const existing = await input.repository.findImport(item.submissionId);
      if (existing) {
        await acknowledgeImport(
          fetchImpl,
          config,
          claimToken,
          item.submissionId,
          existing.aiOsRecordId,
        );
        await input.repository.markAcknowledged(item.submissionId);
        result.acknowledged += 1;
        continue;
      }

      const briefUrl = internalUrl(config, "/api/internal/v1/intake/brief");
      briefUrl.searchParams.set("submission_id", item.submissionId);
      const briefPayload = await requestJson(fetchImpl, briefUrl, config, {
        claimToken,
      });
      const submission = parseBrief(briefPayload, item.submissionId);
      if (submission.schemaVersion !== WEBSITE_FORM_SCHEMA_VERSION) {
        throw new WebsiteIntakeError(
          "Unsupported website form schema",
          "Unsupported website intake schema",
        );
      }

      const linkedLeadId = await resolveLinkedLead(
        submission,
        input.repository,
      );
      const storedAssets = await downloadAndStoreAssets({
        config,
        fetchImpl,
        claimToken,
        submission,
        assetStore: input.assetStore,
      });
      const imported = await input.repository.commitImport({
        submission,
        linkedLeadId,
        assets: storedAssets,
      });
      result.imported += 1;

      await acknowledgeImport(
        fetchImpl,
        config,
        claimToken,
        submission.submissionId,
        imported.aiOsRecordId,
      );
      await input.repository.markAcknowledged(submission.submissionId);
      result.acknowledged += 1;
    } catch (error) {
      if (error instanceof WebsiteHttpError && error.status === 409 && !claimToken) {
        result.skipped += 1;
        continue;
      }
      if (!claimToken) {
        result.skipped += 1;
        continue;
      }

      const reason = safeReleaseReason(error);
      try {
        await requestJson(
          fetchImpl,
          internalUrl(config, "/api/internal/v1/intake/releases"),
          config,
          {
            method: "POST",
            claimToken,
            body: { submission_id: item.submissionId, reason },
          },
        );
        result.released += 1;
      } catch {
        result.skipped += 1;
      }
    }
  }

  return result;
}

export async function createWebsiteIntakeLink(input: {
  config: WebsiteIntakeConfig;
  correlation: {
    leadRef: string;
    gmailThreadRef: string;
    contactEmail: string;
    expiresInSeconds?: number;
  };
  fetchImpl?: typeof fetch;
}): Promise<{ intakeUrl: string; expiresAt: string }> {
  const config = assertConfig(input.config);
  const leadRef = assertOpaqueIdentifier(input.correlation.leadRef, "leadRef");
  const gmailThreadRef = assertOpaqueIdentifier(
    input.correlation.gmailThreadRef,
    "gmailThreadRef",
  );
  const contactEmail = normalizeEmail(input.correlation.contactEmail);
  const expiresInSeconds = clampInteger(
    input.correlation.expiresInSeconds ?? 604_800,
    300,
    2_592_000,
  );
  const payload = await requestJson(
    input.fetchImpl ?? fetch,
    internalUrl(config, "/api/internal/v1/intake-links"),
    config,
    {
      method: "POST",
      body: {
        lead_ref: leadRef,
        gmail_thread_ref: gmailThreadRef,
        contact_email: contactEmail,
        expires_in_seconds: expiresInSeconds,
      },
    },
  );
  const intakeUrl = requiredString(payload, "intake_url", 2048);
  const expiresAt = requiredString(payload, "expires_at", 64);
  const parsed = new URL(intakeUrl);
  if (parsed.origin !== new URL(config.baseUrl).origin || !parsed.searchParams.get("intake")) {
    throw new Error("Website returned an invalid intake URL");
  }
  return { intakeUrl, expiresAt };
}

async function resolveLinkedLead(
  submission: WebsiteIntakeSubmission,
  repository: WebsiteIntakeRepository,
): Promise<string | null> {
  if (submission.source === "website") return null;
  const correlation = submission.correlation;
  if (!correlation) {
    throw new WebsiteIntakeError(
      "Linked intake is missing correlation",
      "Linked intake correlation mismatch",
    );
  }
  const lead = await repository.findLinkedLead(correlation.leadRef);
  if (
    !lead ||
    lead.id !== correlation.leadRef ||
    !lead.gmailThreadId ||
    lead.gmailThreadId !== correlation.gmailThreadRef ||
    normalizeEmail(lead.normalizedEmail) !== submission.normalizedEmail ||
    normalizeEmail(correlation.contactEmail) !== submission.normalizedEmail
  ) {
    throw new WebsiteIntakeError(
      "Linked intake correlation did not match",
      "Linked intake correlation mismatch",
    );
  }
  return lead.id;
}

async function downloadAndStoreAssets(input: {
  config: WebsiteIntakeConfig;
  fetchImpl: typeof fetch;
  claimToken: string;
  submission: WebsiteIntakeSubmission;
  assetStore: WebsiteIntakeAssetStore;
}): Promise<StoredWebsiteIntakeAsset[]> {
  if (input.submission.assets.length > MAX_ASSETS_PER_SUBMISSION) {
    throw new WebsiteIntakeError(
      "Website intake has too many assets",
      "Asset limits exceeded",
    );
  }
  const totalBytes = input.submission.assets.reduce(
    (total, asset) => total + asset.sizeBytes,
    0,
  );
  if (totalBytes > MAX_SUBMISSION_ASSET_BYTES) {
    throw new WebsiteIntakeError(
      "Website intake assets exceed the total limit",
      "Asset limits exceeded",
    );
  }

  const stored: StoredWebsiteIntakeAsset[] = [];
  for (const asset of input.submission.assets) {
    const url = new URL(asset.downloadPath, input.config.baseUrl);
    if (
      url.origin !== new URL(input.config.baseUrl).origin ||
      url.pathname !== "/api/internal/v1/intake/asset" ||
      url.searchParams.get("submission_id") !== input.submission.submissionId ||
      url.searchParams.get("asset_id") !== asset.assetId
    ) {
      throw new WebsiteIntakeError(
        "Website returned an invalid asset download path",
        "Asset manifest validation failed",
      );
    }
    const response = await input.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(input.config, input.claimToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) throw new WebsiteHttpError(response.status);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > asset.sizeBytes) {
      throw new WebsiteIntakeError(
        "Asset byte count did not match manifest",
        "Asset integrity verification failed",
      );
    }
    const bytes = await readBoundedBytes(
      response,
      asset.sizeBytes,
      "Asset integrity verification failed",
    );
    const actualSha256 = await sha256Base64Url(bytes);
    if (bytes.byteLength !== asset.sizeBytes || actualSha256 !== asset.sha256) {
      throw new WebsiteIntakeError(
        "Asset integrity check failed",
        "Asset integrity verification failed",
      );
    }
    const objectKey = `website-intake/${input.submission.submissionId}/${asset.assetId}`;
    await input.assetStore.put({
      objectKey,
      bytes,
      contentType: asset.contentType,
      sha256: asset.sha256,
    });
    stored.push({ ...asset, objectKey });
  }
  return stored;
}

async function acknowledgeImport(
  fetchImpl: typeof fetch,
  config: WebsiteIntakeConfig,
  claimToken: string,
  submissionId: string,
  aiOsRecordId: string,
): Promise<void> {
  await requestJson(
    fetchImpl,
    internalUrl(config, "/api/internal/v1/intake/imports"),
    config,
    {
      method: "POST",
      claimToken,
      body: {
        submission_id: submissionId,
        ai_os_record_id: assertOpaqueIdentifier(aiOsRecordId, "aiOsRecordId"),
      },
    },
  );
}

function parseReadyList(payload: unknown): Array<{ submissionId: string }> {
  const object = asObject(payload);
  assertApiVersion(object);
  const rows = Array.isArray(object.submissions)
    ? object.submissions
    : Array.isArray(object.items)
      ? object.items
      : null;
  if (!rows) throw new Error("Website ready list is invalid");
  return rows.map((row) => ({
    submissionId: assertOpaqueIdentifier(
      requiredString(asObject(row), "submission_id", 160),
      "submission_id",
    ),
  }));
}

function parseBrief(payload: unknown, claimedSubmissionId: string): WebsiteIntakeSubmission {
  const envelope = asObject(payload);
  assertApiVersion(envelope);
  const raw = asObject(
    envelope.submission && typeof envelope.submission === "object"
      ? envelope.submission
      : envelope,
  );
  const submissionId = assertOpaqueIdentifier(
    requiredString(raw, "submission_id", 160),
    "submission_id",
  );
  if (submissionId !== claimedSubmissionId) throw new Error("Claimed submission changed");
  const source = requiredString(raw, "source", 32);
  if (source !== "website" && source !== "gmail_outreach") {
    throw new WebsiteIntakeError(
      "Website intake source is unsupported",
      "Unsupported website intake source",
    );
  }
  const normalizedEmail = normalizeEmail(requiredString(raw, "normalized_email", 320));
  const rawCorrelation = raw.correlation ?? envelope.correlation;
  const correlationObject = rawCorrelation == null ? null : asObject(rawCorrelation);
  const correlation = correlationObject
    ? {
        leadRef: assertOpaqueIdentifier(
          requiredString(correlationObject, "lead_ref", 160),
          "lead_ref",
        ),
        gmailThreadRef: assertOpaqueIdentifier(
          requiredString(correlationObject, "gmail_thread_ref", 160),
          "gmail_thread_ref",
        ),
        contactEmail: normalizeEmail(
          requiredString(correlationObject, "contact_email", 320),
        ),
      }
    : null;
  const assetRows = Array.isArray(raw.assets)
    ? raw.assets
    : Array.isArray(envelope.assets)
      ? envelope.assets
      : [];
  const assets = assetRows.map((row): WebsiteIntakeAsset => {
    const asset = asObject(row);
    const sizeBytes = requiredInteger(asset, "size_bytes", 0, MAX_ASSET_BYTES);
    const digest =
      typeof asset.sha256 === "string"
        ? asset.sha256
        : requiredString(asset, "sha256_base64url", 64);
    return {
      assetId: assertOpaqueIdentifier(
        requiredString(asset, "asset_id", 160),
        "asset_id",
      ),
      filename: requiredString(asset, "filename", 512),
      contentType: requiredString(asset, "content_type", 160),
      role: optionalString(asset, "role", 80),
      sizeBytes,
      sha256: validateBase64UrlSha256(digest),
      downloadPath: requiredString(asset, "download_path", 2048),
    };
  });

  return {
    submissionId,
    publicReference: requiredString(raw, "reference", 80),
    schemaVersion: requiredInteger(raw, "schema_version", 1, 1_000),
    source,
    normalizedEmail,
    contactName: requiredString(raw, "contact_name", 240),
    businessName: requiredString(raw, "business_name", 300),
    industry: optionalString(raw, "industry", 240),
    projectType: optionalString(raw, "project_type", 160),
    primaryGoal: optionalString(raw, "primary_goal", 2_000),
    audience: optionalString(raw, "audience", 2_000),
    answers: raw.answers ?? raw.answers_json ?? {},
    correlation,
    assets,
    raw,
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: URL,
  config: WebsiteIntakeConfig,
  options: {
    method?: "GET" | "POST";
    claimToken?: string;
    body?: unknown;
  } = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: {
      ...authHeaders(config, options.claimToken),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new WebsiteHttpError(response.status);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Website intake API returned a non-JSON response");
  }
  const bytes = await readBoundedBytes(response, MAX_JSON_RESPONSE_BYTES);
  try {
    return asObject(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch (error) {
    throw new Error("Website intake API returned invalid JSON", { cause: error });
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  releaseReason = "Website intake response exceeded limit",
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new WebsiteIntakeError(
          "Website response exceeded its declared limit",
          releaseReason,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function authHeaders(
  config: WebsiteIntakeConfig,
  claimToken?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    Accept: "application/json",
    ...(claimToken ? { "X-Evele-Claim-Token": claimToken } : {}),
  };
}

function internalUrl(config: WebsiteIntakeConfig, path: string): URL {
  return new URL(path, config.baseUrl);
}

function assertConfig(config: WebsiteIntakeConfig): WebsiteIntakeConfig {
  const normalized = readWebsiteIntakeConfig({
    EVELE_WEBSITE_BASE_URL: config.baseUrl,
    EVELE_WEBSITE_API_TOKEN: config.apiToken,
    EVELE_WEBSITE_IMPORT_WORKER_ID: config.workerId,
  });
  if (!normalized) throw new Error("Website intake configuration is invalid");
  return normalized;
}

function emptyBatchResult(
  status: WebsiteIntakeBatchResult["status"],
): WebsiteIntakeBatchResult {
  return {
    status,
    listed: 0,
    imported: 0,
    acknowledged: 0,
    released: 0,
    skipped: 0,
  };
}

function safeReleaseReason(error: unknown): string {
  if (error instanceof WebsiteIntakeError) return error.releaseReason.slice(0, 120);
  if (error instanceof WebsiteHttpError && error.status === 409) {
    return "Import acknowledgement conflict";
  }
  return "Temporary AI OS import failure";
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Website intake API returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function assertApiVersion(value: Record<string, unknown>): void {
  if (value.api_version !== WEBSITE_API_VERSION) {
    throw new Error("Website intake API version is unsupported");
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim() || field.length > maxLength) {
    throw new Error(`Website intake field ${key} is invalid`);
  }
  return field.trim();
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const field = value[key];
  if (field == null || field === "") return "";
  if (typeof field !== "string" || field.length > maxLength) {
    throw new Error(`Website intake field ${key} is invalid`);
  }
  return field.trim();
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const field = value[key];
  if (!Number.isInteger(field) || Number(field) < minimum || Number(field) > maximum) {
    throw new Error(`Website intake field ${key} is invalid`);
  }
  return Number(field);
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("Website intake email is invalid");
  }
  return normalized;
}

function isOpaqueIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function assertOpaqueIdentifier(value: string, fieldName: string): string {
  if (!isOpaqueIdentifier(value)) throw new Error(`${fieldName} is invalid`);
  return value;
}

function validateBase64UrlSha256(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Website intake SHA-256 digest is invalid");
  }
  return value;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput.buffer),
  );
  let binary = "";
  for (let index = 0; index < digest.length; index += 0x8000) {
    binary += String.fromCharCode(...digest.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
