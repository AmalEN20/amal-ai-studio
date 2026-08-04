import { env } from "cloudflare:workers";
import {
  createWebsiteIntakeLink,
  readWebsiteIntakeConfig,
  runWebsiteIntakeBatch,
} from "@/lib/website-intake-adapter";
import {
  WebsiteIntakeR2Store,
  websiteIntakeRepository,
} from "@/db/website-intake";

export function websiteIntakeStatus(): {
  configured: boolean;
  assetStorageConfigured: boolean;
  enabled: boolean;
} {
  const configured = Boolean(readWebsiteIntakeConfig());
  const assetStorageConfigured = Boolean(env.INTAKE_ASSETS);
  return {
    configured,
    assetStorageConfigured,
    enabled: configured && assetStorageConfigured,
  };
}

export async function runConfiguredWebsiteIntakeBatch(limit?: number) {
  const config = readWebsiteIntakeConfig();
  if (!config || !env.INTAKE_ASSETS) {
    return runWebsiteIntakeBatch({
      config: null,
      repository: websiteIntakeRepository,
      assetStore: new WebsiteIntakeR2Store(undefined),
    });
  }
  return runWebsiteIntakeBatch({
    config,
    repository: websiteIntakeRepository,
    assetStore: new WebsiteIntakeR2Store(env.INTAKE_ASSETS),
    listLimit: limit,
  });
}

export async function createLinkedWebsiteIntakeUrl(input: {
  leadId: string;
  expiresInSeconds?: number;
}): Promise<{ intakeUrl: string; expiresAt: string }> {
  const config = readWebsiteIntakeConfig();
  if (!config) throw new Error("Website intake connection is disabled");
  const lead = await websiteIntakeRepository.findLinkedLead(input.leadId);
  if (!lead || !lead.gmailThreadId || !lead.normalizedEmail) {
    throw new Error("Lead has no exact Gmail thread correlation for intake");
  }
  return createWebsiteIntakeLink({
    config,
    correlation: {
      leadRef: lead.id,
      gmailThreadRef: lead.gmailThreadId,
      contactEmail: lead.normalizedEmail,
      expiresInSeconds: input.expiresInSeconds,
    },
  });
}
