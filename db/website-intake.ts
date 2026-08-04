import { env } from "cloudflare:workers";
import type {
  StoredWebsiteIntakeAsset,
  WebsiteIntakeAssetStore,
  WebsiteIntakeImportRecord,
  WebsiteIntakeRepository,
  WebsiteIntakeSubmission,
  WebsiteLinkedLead,
} from "@/lib/website-intake-adapter";
import { sha256Base64Url } from "@/lib/website-intake-adapter";

type ImportRow = {
  submission_id: string;
  lead_id: string;
  status: "saved" | "acknowledged";
};

type LinkedLeadRow = {
  id: string;
  email: string;
  gmail_thread_id: string;
};

function d1(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

export const websiteIntakeRepository: WebsiteIntakeRepository = {
  async findImport(submissionId) {
    const row = await d1()
      .prepare(
        `SELECT submission_id, lead_id, status
         FROM website_intake_imports
         WHERE submission_id = ?
         LIMIT 1`,
      )
      .bind(submissionId)
      .first<ImportRow>();
    return row ? toImportRecord(row) : null;
  },

  async findLinkedLead(leadRef) {
    const row = await d1()
      .prepare(
        `SELECT id, email, gmail_thread_id
         FROM leads
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(leadRef)
      .first<LinkedLeadRow>();
    return row ? toLinkedLead(row) : null;
  },

  async commitImport(input) {
    return commitWebsiteIntakeImport(input);
  },

  async markAcknowledged(submissionId) {
    const result = await d1()
      .prepare(
        `UPDATE website_intake_imports
         SET status = 'acknowledged', acknowledged_at = ?
         WHERE submission_id = ? AND status IN ('saved', 'acknowledged')`,
      )
      .bind(new Date().toISOString(), submissionId)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("Website intake import was not found for acknowledgement");
    }
  },
};

export class WebsiteIntakeR2Store implements WebsiteIntakeAssetStore {
  constructor(private readonly bucket: R2Bucket | undefined) {}

  async put(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<string> {
    if (!this.bucket) throw new Error("Website intake asset storage is unavailable");
    await this.bucket.put(input.objectKey, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { sha256: input.sha256 },
    });
    return input.objectKey;
  }
}

async function commitWebsiteIntakeImport(input: {
  submission: WebsiteIntakeSubmission;
  linkedLeadId: string | null;
  assets: StoredWebsiteIntakeAsset[];
}): Promise<WebsiteIntakeImportRecord> {
  const database = d1();
  const existing = await websiteIntakeRepository.findImport(
    input.submission.submissionId,
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const briefJson = JSON.stringify(input.submission.raw);
  if (new TextEncoder().encode(briefJson).byteLength > 262_144) {
    throw new Error("Website intake brief exceeds the durable record limit");
  }

  const statements: D1PreparedStatement[] = [];
  let leadId = input.linkedLeadId;
  if (input.submission.source === "website") {
    const sourceKey = `website-intake:${input.submission.submissionId}`;
    const prior = await database
      .prepare("SELECT id FROM leads WHERE source_key = ? LIMIT 1")
      .bind(sourceKey)
      .first<{ id: string }>();
    const submissionDigest = await sha256Base64Url(
      new TextEncoder().encode(input.submission.submissionId),
    );
    leadId = prior?.id ?? `website_${submissionDigest}`;
    statements.push(
      database
        .prepare(
          `INSERT INTO leads (
            id, source_key, search_batch_id, name, industry, location, website,
            email, phone, rating, review_count, source, stage, saved_for_launch,
            saved_for_launch_at, audit_json, outreach_json, site_json,
            analysis_provider, send_provider, gmail_message_id, gmail_thread_id,
            last_error, created_at, updated_at
          ) VALUES (?, ?, '', ?, ?, ?, ?, ?, '', NULL, NULL, 'website',
            'discovered', 0, '', NULL, NULL, NULL, 'pending', 'pending', '', '',
            '', ?, ?)
          ON CONFLICT (source_key) DO NOTHING`,
        )
        .bind(
          leadId,
          sourceKey,
          input.submission.businessName,
          input.submission.industry || "Unspecified",
          rawText(input.submission.raw, "location", 240),
          rawText(input.submission.raw, "website", 2048),
          input.submission.normalizedEmail,
          now,
          now,
        ),
    );
  }
  if (!leadId) throw new Error("Website intake has no exact lead attachment");

  const importValues = [
    input.submission.submissionId,
    input.submission.publicReference,
    input.submission.schemaVersion,
    input.submission.source,
    input.submission.normalizedEmail,
    leadId,
    input.submission.correlation?.gmailThreadRef ?? "",
    briefJson,
    now,
  ] as const;
  if (input.submission.source === "gmail_outreach") {
    statements.push(
      database
        .prepare(
          `INSERT INTO website_intake_imports (
            submission_id, public_reference, schema_version, source,
            normalized_email, lead_id, gmail_thread_id, brief_json, status,
            imported_at, acknowledged_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, ''
          FROM leads
          WHERE id = ? AND lower(trim(email)) = ? AND gmail_thread_id = ?
          LIMIT 1`,
        )
        .bind(
          ...importValues,
          leadId,
          input.submission.normalizedEmail,
          input.submission.correlation?.gmailThreadRef ?? "",
        ),
    );
  } else {
    statements.push(
      database
        .prepare(
          `INSERT INTO website_intake_imports (
            submission_id, public_reference, schema_version, source,
            normalized_email, lead_id, gmail_thread_id, brief_json, status,
            imported_at, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, '')`,
        )
        .bind(...importValues),
    );
  }

  for (const asset of input.assets) {
    statements.push(
      database
        .prepare(
          `INSERT INTO website_intake_assets (
            submission_id, asset_id, filename, content_type, role, size_bytes,
            sha256, object_key, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.submission.submissionId,
          asset.assetId,
          asset.filename,
          asset.contentType,
          asset.role,
          asset.sizeBytes,
          asset.sha256,
          asset.objectKey,
          now,
        ),
    );
  }

  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await websiteIntakeRepository.findImport(
      input.submission.submissionId,
    );
    if (raced) return raced;
    throw error;
  }
  const imported = await websiteIntakeRepository.findImport(
    input.submission.submissionId,
  );
  if (!imported || imported.leadId !== leadId) {
    throw new Error("Website intake correlation changed before durable commit");
  }
  return imported;
}

function toImportRecord(row: ImportRow): WebsiteIntakeImportRecord {
  return {
    aiOsRecordId: row.lead_id,
    leadId: row.lead_id,
    acknowledged: row.status === "acknowledged",
  };
}

function toLinkedLead(row: LinkedLeadRow): WebsiteLinkedLead {
  return {
    id: row.id,
    normalizedEmail: row.email.trim().toLowerCase(),
    gmailThreadId: row.gmail_thread_id,
  };
}

function rawText(value: unknown, key: string, maxLength: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field.trim().slice(0, maxLength) : "";
}
