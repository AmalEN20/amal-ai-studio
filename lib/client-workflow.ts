export const ORDER_STATES = [
  "quote_draft",
  "quote_sent",
  "awaiting_payment",
  "paid",
  "intake_pending",
  "intake_complete",
  "generation_ready",
  "generating",
  "qa_pending",
  "client_review",
  "approved",
  "deploy_ready",
  "deploying",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "requires_action",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
  "partially_refunded",
  "refunded",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type IntakeStatus = "draft" | "submitted";
export type BuildStatus =
  | "generated"
  | "qa_pending"
  | "qa_failed"
  | "qa_passed"
  | "client_review"
  | "approved"
  | "deploying"
  | "delivered";
export type QaStatus = "pending" | "passed" | "failed";
export type ApprovalStatus = "approved" | "rejected" | "revoked";
export type WorkflowActorType = "owner" | "customer" | "system" | "provider";

export type ClientCustomer = {
  id: string;
  leadId: string;
  name: string;
  companyName: string;
  email: string;
  phone: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type ClientOrder = {
  id: string;
  customerId: string;
  leadId: string;
  state: OrderState;
  currency: string;
  portalTokenHash: string | null;
  currentQuoteVersionId: string;
  activeBuildId: string;
  lastTransitionEventId: string;
  paidAt: string;
  intakeCompletedAt: string;
  deliveredAt: string;
  createdAt: string;
  updatedAt: string;
};

export type QuoteVersion = {
  id: string;
  orderId: string;
  version: number;
  currency: string;
  amountMinor: number;
  scope: unknown;
  terms: unknown;
  contentDigest: string;
  createdBy: string;
  createdAt: string;
};

export type PaymentRecord = {
  id: string;
  orderId: string;
  provider: string;
  providerPaymentId: string;
  providerCustomerId: string;
  providerEventHash: string | null;
  status: PaymentStatus;
  currency: string;
  amountMinor: number;
  paidAt: string;
  refundedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type IntakeSubmission = {
  id: string;
  orderId: string;
  version: number;
  status: IntakeStatus;
  answers: unknown;
  contentDigest: string;
  createdAt: string;
  submittedAt: string;
};

export type ClientBuild = {
  id: string;
  orderId: string;
  revision: number;
  status: BuildStatus;
  artifactRef: string;
  sourceDigest: string;
  buildDigest: string;
  qaStatus: QaStatus;
  qaReport: unknown;
  deploymentRef: string;
  deployedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type BuildApproval = {
  id: string;
  orderId: string;
  buildId: string;
  buildDigest: string;
  status: ApprovalStatus;
  approverCustomerId: string;
  approvalTokenHash: string | null;
  note: string;
  createdAt: string;
};

export type ClientWorkflowEvent = {
  id: string;
  orderId: string;
  eventType: string;
  fromState: string;
  toState: string;
  actorType: WorkflowActorType;
  actorId: string;
  details: unknown;
  createdAt: string;
};

export type OrderTransitionEvidence = {
  hasCurrentQuote: boolean;
  hasSucceededPayment: boolean;
  hasSubmittedIntake: boolean;
  activeBuildDigest: string | null;
  qaPassedBuildDigest: string | null;
  approvedBuildDigest: string | null;
  deploymentReference: string | null;
};

const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  quote_draft: ["quote_sent", "cancelled"],
  quote_sent: ["awaiting_payment", "cancelled"],
  awaiting_payment: ["paid", "cancelled"],
  paid: ["intake_pending", "refunded"],
  intake_pending: ["intake_complete", "refunded"],
  intake_complete: ["generation_ready", "refunded"],
  generation_ready: ["generating", "refunded"],
  generating: ["qa_pending", "generation_ready", "refunded"],
  qa_pending: ["client_review", "generating", "refunded"],
  client_review: ["approved", "generating", "refunded"],
  approved: ["deploy_ready", "generating", "refunded"],
  deploy_ready: ["deploying", "generating", "refunded"],
  deploying: ["delivered", "deploy_ready"],
  delivered: [],
  cancelled: [],
  refunded: [],
};

export class ClientWorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClientWorkflowError";
    this.code = code;
  }
}

export function isOrderState(value: string): value is OrderState {
  return (ORDER_STATES as readonly string[]).includes(value);
}

export function assertProductionGenerationReady(
  evidence: Pick<
    OrderTransitionEvidence,
    "hasSucceededPayment" | "hasSubmittedIntake"
  >,
): void {
  if (!evidence.hasSucceededPayment) {
    throw new ClientWorkflowError(
      "PAYMENT_REQUIRED",
      "A settled payment covering the current quote is required before production generation.",
    );
  }
  if (!evidence.hasSubmittedIntake) {
    throw new ClientWorkflowError(
      "INTAKE_REQUIRED",
      "A submitted client intake is required before production generation.",
    );
  }
}

export function assertExactBuildApproval(
  evidence: Pick<
    OrderTransitionEvidence,
    "activeBuildDigest" | "qaPassedBuildDigest" | "approvedBuildDigest"
  >,
): void {
  const digest = evidence.activeBuildDigest;
  if (!digest || evidence.qaPassedBuildDigest !== digest) {
    throw new ClientWorkflowError(
      "QA_REQUIRED",
      "The active build must pass QA before approval or deployment.",
    );
  }
  if (evidence.approvedBuildDigest !== digest) {
    throw new ClientWorkflowError(
      "EXACT_BUILD_APPROVAL_REQUIRED",
      "Client approval must reference the exact digest of the active QA-passed build.",
    );
  }
}

export function assertOrderTransition(
  from: OrderState,
  to: OrderState,
  evidence: OrderTransitionEvidence,
): void {
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    throw new ClientWorkflowError(
      "INVALID_ORDER_TRANSITION",
      `Order cannot move from ${from} to ${to}.`,
    );
  }

  if ((to === "quote_sent" || to === "awaiting_payment") && !evidence.hasCurrentQuote) {
    throw new ClientWorkflowError(
      "QUOTE_REQUIRED",
      "An immutable quote version is required before the quote can be sent or paid.",
    );
  }

  if (to === "paid" && !evidence.hasSucceededPayment) {
    throw new ClientWorkflowError(
      "PAYMENT_REQUIRED",
      "A settled payment covering the current quote is required.",
    );
  }

  if (to === "intake_complete" && !evidence.hasSubmittedIntake) {
    throw new ClientWorkflowError(
      "INTAKE_REQUIRED",
      "A submitted intake is required before intake can be marked complete.",
    );
  }

  if (to === "generation_ready" || to === "generating") {
    assertProductionGenerationReady(evidence);
  }

  if (to === "client_review") {
    const digest = evidence.activeBuildDigest;
    if (!digest || evidence.qaPassedBuildDigest !== digest) {
      throw new ClientWorkflowError(
        "QA_REQUIRED",
        "Only the active QA-passed build can enter client review.",
      );
    }
  }

  if (to === "approved" || to === "deploy_ready" || to === "deploying" || to === "delivered") {
    assertExactBuildApproval(evidence);
  }

  if (to === "delivered" && !evidence.deploymentReference) {
    throw new ClientWorkflowError(
      "DEPLOYMENT_REFERENCE_REQUIRED",
      "A provider-neutral deployment reference is required before delivery.",
    );
  }
}

export function assertSha256Hash(value: string, fieldName: string): void {
  // Keep one canonical representation across TypeScript and D1. Accepting an
  // uppercase prefix here would pass application validation but fail the
  // database CHECK constraint, so required digests are deliberately strict.
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ClientWorkflowError(
      "INVALID_SHA256_HASH",
      `${fieldName} must be a required SHA-256 digest in sha256:<hex> form.`,
    );
  }
}

export function assertOptionalSha256Hash(
  value: string | null | undefined,
  fieldName: string,
): void {
  if (value == null || value === "") return;
  try {
    assertSha256Hash(value, fieldName);
  } catch {
    throw new ClientWorkflowError(
      "INVALID_TOKEN_HASH",
      `${fieldName} must be a SHA-256 digest in sha256:<hex> form; raw tokens must never be stored.`,
    );
  }
}

export async function hashPublicToken(rawToken: string): Promise<string> {
  if (rawToken.length < 32) {
    throw new ClientWorkflowError(
      "WEAK_PUBLIC_TOKEN",
      "Public tokens must contain at least 32 characters of entropy.",
    );
  }
  const bytes = new TextEncoder().encode(rawToken);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ClientWorkflowError(
      "INVALID_CURRENCY",
      "Currency must be a three-letter ISO 4217 code.",
    );
  }
  return currency;
}

export function assertMinorAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClientWorkflowError(
      "INVALID_AMOUNT",
      "Money must be stored as a non-negative safe integer in minor currency units.",
    );
  }
}
