import {
  claimApprovedLeadForSending,
  findLead,
  releaseLeadSendClaim,
  updateLead,
} from "@/db/leads";
import { generateSite } from "@/lib/generator";
import { GmailSendError, sendLeadEmail } from "@/lib/gmail";
import {
  analyzeLead,
  createOutreachDraft,
  findPublicBusinessEmail,
  isQualifiedOpportunity,
} from "@/lib/lead-engine";
import { guardOwnerApi } from "@/lib/owner-auth";
import type { BusinessInput } from "@/lib/types";

export const dynamic = "force-dynamic";

type Action =
  | "analyze"
  | "draft"
  | "find_email"
  | "set_email"
  | "approve"
  | "save_for_launch"
  | "remove_from_launch"
  | "send"
  | "reply"
  | "build"
  | "unsubscribe"
  | "reject";

export async function POST(request: Request) {
  const denied = await guardOwnerApi(request);
  if (denied) return denied;

  try {
    const payload = (await request.json()) as {
      id?: string;
      action?: Action;
      email?: string;
    };
    if (!payload.id || !payload.action) {
      return Response.json({ error: "id and action are required" }, { status: 400 });
    }
    const lead = await findLead(payload.id);
    if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });

    if (payload.action === "set_email") {
      const email = validBusinessEmail(payload.email);
      return Response.json({
        lead: await updateLead(lead.id, { email, lastError: "" }),
      });
    }

    if (payload.action === "find_email") {
      const result = await findPublicBusinessEmail(lead);
      if (!result.email) {
        return Response.json({
          lead,
          found: false,
          warning: result.pagesChecked
            ? `No public business email was found after checking ${result.pagesChecked} official website pages.`
            : "The official website was unavailable, so no public email was found.",
        });
      }
      return Response.json({
        lead: await updateLead(lead.id, { email: result.email, lastError: "" }),
        found: true,
        warning: `A public business email was found on the official website: ${result.email}`,
      });
    }

    if (payload.action === "analyze") {
      const result = await analyzeLead(lead);
      const qualified = isQualifiedOpportunity(result.audit);
      const updated = await updateLead(lead.id, {
        stage: qualified ? "qualified" : "rejected",
        savedForLaunch: qualified,
        savedForLaunchAt: qualified
          ? lead.savedForLaunchAt || new Date().toISOString()
          : "",
        audit: result.audit,
        outreach: null,
        analysisProvider: result.provider,
        lastError: "",
      });
      return Response.json({ lead: updated });
    }

    if (payload.action === "draft") {
      if (!lead.audit) throw new Error("Analyze the business first");
      const result = await createOutreachDraft(lead);
      const updated = await updateLead(lead.id, {
        stage: "drafted",
        outreach: result.draft,
        analysisProvider: result.provider,
        lastError: "",
      });
      return Response.json({ lead: updated });
    }

    if (payload.action === "approve") {
      if (lead.stage !== "drafted") throw new Error("Only a reviewed draft can be approved");
      if (!lead.outreach) throw new Error("Create a draft first");
      return Response.json({
        lead: await updateLead(lead.id, { stage: "approved", lastError: "" }),
      });
    }

    if (payload.action === "save_for_launch") {
      if (!isQualifiedOpportunity(lead.audit)) {
        throw new Error(
          "Only a business that passed Studio V1's objective scope and contactability checks can be saved for launch",
        );
      }
      return Response.json({
        lead: await updateLead(lead.id, {
          savedForLaunch: true,
          savedForLaunchAt: lead.savedForLaunchAt || new Date().toISOString(),
          lastError: "",
        }),
      });
    }

    if (payload.action === "remove_from_launch") {
      return Response.json({
        lead: await updateLead(lead.id, {
          savedForLaunch: false,
          savedForLaunchAt: "",
          lastError: "",
        }),
      });
    }

    if (payload.action === "send") {
      if (process.env.OUTREACH_LAUNCH_ENABLED !== "true") {
        throw new Error("Outreach is paused until launch. This lead stays safely saved in the launch list.");
      }
      if (lead.stage !== "approved") {
        throw new Error("Approve this exact draft before sending");
      }
      if (!lead.outreach) throw new Error("Create a draft first");
      if (lead.source === "demo") {
        return Response.json({
          lead: await updateLead(lead.id, {
            stage: "sent",
            sendProvider: "demo",
            gmailMessageId: `demo-${crypto.randomUUID()}`,
            gmailThreadId: "",
            lastError: "",
          }),
          warning: "Demo send completed. No real email left the system.",
        });
      }
      const claimedLead = await claimApprovedLeadForSending(lead.id);
      if (!claimedLead) {
        return Response.json(
          { error: "This email is already being sent or is no longer approved" },
          { status: 409 },
        );
      }

      let result: Awaited<ReturnType<typeof sendLeadEmail>>;
      try {
        result = await sendLeadEmail(claimedLead);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Email send failed";
        if (error instanceof GmailSendError && error.mayHaveSent) {
          // Keep the atomic `sending` claim locked. Retrying an ambiguous
          // request could deliver a duplicate; the owner must check Sent mail.
          await updateLead(claimedLead.id, {
            lastError: `${message} Automatic retry is locked to prevent a duplicate.`,
          }).catch(() => null);
        } else {
          await releaseLeadSendClaim(claimedLead.id, message).catch(() => null);
        }
        throw error;
      }
      return Response.json({
        lead: await updateLead(claimedLead.id, {
          stage: "sent",
          sendProvider: "gmail",
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          lastError: "",
        }),
      });
    }

    if (payload.action === "reply") {
      if (lead.stage !== "sent") throw new Error("Only a sent email can receive a reply");
      return Response.json({
        lead: await updateLead(lead.id, { stage: "replied", lastError: "" }),
      });
    }

    if (payload.action === "unsubscribe") {
      if (!lead.email) throw new Error("No contact email is saved for this lead");
      return Response.json({
        lead: await updateLead(lead.id, {
          stage: "unsubscribed",
          savedForLaunch: false,
          savedForLaunchAt: "",
          lastError: "",
        }),
      });
    }

    if (payload.action === "build") {
      if (lead.stage !== "replied" && lead.source !== "demo") {
        throw new Error("Wait for a positive reply before building");
      }
      await updateLead(lead.id, { stage: "building", lastError: "" });
      const input: BusinessInput = {
        name: lead.name,
        industry: lead.industry,
        description:
          lead.audit?.summary ||
          `${lead.name} is a ${lead.industry} business in ${lead.location}.`,
        audience: `Local customers looking for ${lead.industry.toLowerCase()} services`,
        offer: `A clear path to enquire, call, or book with ${lead.name}`,
        location: lead.location,
        website: lead.website,
        tone: "premium",
      };
      const result = await generateSite(input);
      return Response.json({
        lead: await updateLead(lead.id, {
          stage: "concept_ready",
          site: result.site,
          analysisProvider: result.provider,
          lastError: "",
        }),
        warning: result.warning ?? null,
      });
    }

    return Response.json({
      lead: await updateLead(lead.id, {
        stage: "rejected",
        savedForLaunch: false,
        savedForLaunchAt: "",
        lastError: "",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 400 });
  }
}

function validBusinessEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Business email is required");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid public business email");
  }
  if (email.endsWith(".example")) throw new Error("Demo email addresses cannot be used");
  return email;
}
