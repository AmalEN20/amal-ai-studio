"use client";

import type { Lead, LeadStage } from "@/lib/types";

export type LeadAction =
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

export type LeadActionInput = { email?: string };

export const STAGE_LABELS: Record<LeadStage, string> = {
  discovered: "Found",
  qualified: "Qualified",
  drafted: "Draft ready",
  approved: "Approved",
  sending: "Sending",
  sent: "Sent",
  replied: "Replied",
  building: "Generating concept",
  concept_ready: "Concept ready",
  unsubscribed: "Do not contact",
  rejected: "Archived",
};

export const PIPELINE: LeadStage[] = [
  "discovered",
  "qualified",
  "drafted",
  "sent",
  "replied",
  "concept_ready",
];

export function isLaunchReadyLead(lead: Lead): boolean {
  return lead.savedForLaunch;
}

export function StagePill({ stage, demo }: { stage: LeadStage; demo: boolean }) {
  return <span className={`stage-pill stage-${stage}`}>{demo && stage === "discovered" ? "Demo" : STAGE_LABELS[stage]}</span>;
}
