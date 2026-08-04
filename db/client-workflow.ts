import { and, asc, desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { ensureClientWorkflowSchemaGuards } from "@/db/schema-guards";
import {
  buildApprovals,
  clientBuilds,
  clientCustomers,
  clientOrders,
  clientWorkflowEvents,
  intakeSubmissions,
  paymentRecords,
  quoteVersions,
} from "@/db/schema";
import {
  PAYMENT_STATUSES,
  assertExactBuildApproval,
  assertMinorAmount,
  assertOptionalSha256Hash,
  assertOrderTransition,
  assertProductionGenerationReady,
  assertSha256Hash,
  normalizeCurrency,
  type ApprovalStatus,
  type BuildApproval,
  type ClientBuild,
  type ClientCustomer,
  type ClientOrder,
  type ClientWorkflowEvent,
  type IntakeStatus,
  type IntakeSubmission,
  type OrderState,
  type OrderTransitionEvidence,
  type PaymentRecord,
  type PaymentStatus,
  type QaStatus,
  type QuoteVersion,
  type WorkflowActorType,
} from "@/lib/client-workflow";

type WorkflowActor = {
  type: WorkflowActorType;
  id?: string;
};

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["requires_action", "processing", "succeeded", "failed", "cancelled"],
  requires_action: ["processing", "succeeded", "failed", "cancelled"],
  processing: ["succeeded", "failed", "cancelled"],
  succeeded: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  failed: [],
  cancelled: [],
  refunded: [],
};

async function ensureMutationGuards(): Promise<void> {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  await ensureClientWorkflowSchemaGuards(env.DB);
}

function requiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} is required`);
  return normalized;
}

function serializeJson(value: unknown, fieldName: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined is not JSON");
    return serialized;
  } catch (error) {
    throw new Error(`${fieldName} must be JSON-serializable`, { cause: error });
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function assertSafeEventDetails(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    const hashed = normalized.endsWith("hash") || normalized.endsWith("digest");
    if (
      (!hashed && normalized.includes("token")) ||
      normalized.includes("secret") ||
      normalized.includes("password") ||
      normalized.includes("cardnumber") ||
      normalized === "pan" ||
      normalized.includes("cvv") ||
      normalized.includes("cvc")
    ) {
      throw new Error(`Sensitive field ${key} must not be written to workflow events`);
    }
    assertSafeEventDetails(child);
  }
}

export async function createClientCustomer(input: {
  leadId?: string;
  name: string;
  companyName: string;
  email: string;
  phone?: string;
}): Promise<ClientCustomer> {
  await ensureMutationGuards();
  const now = new Date().toISOString();
  const row: typeof clientCustomers.$inferInsert = {
    id: crypto.randomUUID(),
    leadId: input.leadId?.trim() ?? "",
    name: requiredText(input.name, "Customer name"),
    companyName: requiredText(input.companyName, "Company name"),
    email: requiredText(input.email, "Customer email").toLowerCase(),
    phone: input.phone?.trim() ?? "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(clientCustomers).values(row);
  return toCustomer(row as typeof clientCustomers.$inferSelect);
}

export async function getClientCustomer(id: string): Promise<ClientCustomer | null> {
  const [row] = await getDb()
    .select()
    .from(clientCustomers)
    .where(eq(clientCustomers.id, id))
    .limit(1);
  return row ? toCustomer(row) : null;
}

export async function createClientOrder(input: {
  customerId: string;
  leadId?: string;
  currency?: string;
  portalTokenHash?: string | null;
  actor: WorkflowActor;
}): Promise<ClientOrder> {
  await ensureMutationGuards();
  const customer = await getClientCustomer(input.customerId);
  if (!customer) throw new Error("Customer not found");
  assertOptionalSha256Hash(input.portalTokenHash, "portalTokenHash");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const currency = normalizeCurrency(input.currency ?? "USD");
  const eventId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO client_orders (
        id, customer_id, lead_id, state, currency, portal_token_hash,
        current_quote_version_id, active_build_id, last_transition_event_id, paid_at,
        intake_completed_at, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'quote_draft', ?, ?, '', '', ?, '', '', '', ?, ?)`,
    ).bind(
      id,
      customer.id,
      input.leadId?.trim() || customer.leadId,
      currency,
      input.portalTokenHash || null,
      eventId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO client_workflow_events (
        id, order_id, event_type, from_state, to_state, actor_type,
        actor_id, details_json, created_at
      ) VALUES (?, ?, 'order.created', '', 'quote_draft', ?, ?, '{}', ?)`,
    ).bind(eventId, id, input.actor.type, input.actor.id ?? "", now),
  ]);

  const order = await getClientOrder(id);
  if (!order) throw new Error("Order was not readable after creation");
  return order;
}

export async function getClientOrder(id: string): Promise<ClientOrder | null> {
  const [row] = await getDb()
    .select()
    .from(clientOrders)
    .where(eq(clientOrders.id, id))
    .limit(1);
  return row ? toOrder(row) : null;
}

export async function listClientOrders(limit = 100): Promise<ClientOrder[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await getDb()
    .select()
    .from(clientOrders)
    .orderBy(desc(clientOrders.updatedAt))
    .limit(safeLimit);
  return rows.map(toOrder);
}

export async function createQuoteVersion(input: {
  orderId: string;
  amountMinor: number;
  currency: string;
  scope: unknown;
  terms: unknown;
  contentDigest: string;
  createdBy: string;
}): Promise<QuoteVersion> {
  await ensureMutationGuards();
  const order = await getClientOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  if (order.state !== "quote_draft") {
    throw new Error("Quote versions can only be added while the order is quote_draft");
  }
  assertMinorAmount(input.amountMinor);
  assertSha256Hash(input.contentDigest, "contentDigest");
  const currency = normalizeCurrency(input.currency);
  if (currency !== order.currency) throw new Error("Quote currency must match the order");
  const [latest] = await getDb()
    .select()
    .from(quoteVersions)
    .where(eq(quoteVersions.orderId, order.id))
    .orderBy(desc(quoteVersions.version))
    .limit(1);
  const now = new Date().toISOString();
  const row: typeof quoteVersions.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: order.id,
    version: (latest?.version ?? 0) + 1,
    currency,
    amountMinor: input.amountMinor,
    scopeJson: serializeJson(input.scope, "Quote scope"),
    termsJson: serializeJson(input.terms, "Quote terms"),
    contentDigest: input.contentDigest,
    createdBy: requiredText(input.createdBy, "Quote creator"),
    createdAt: now,
  };
  await getDb().insert(quoteVersions).values(row);
  await getDb()
    .update(clientOrders)
    .set({ currentQuoteVersionId: row.id, updatedAt: now })
    .where(and(eq(clientOrders.id, order.id), eq(clientOrders.state, "quote_draft")));
  return toQuoteVersion(row as typeof quoteVersions.$inferSelect);
}

export async function listQuoteVersions(orderId: string): Promise<QuoteVersion[]> {
  const rows = await getDb()
    .select()
    .from(quoteVersions)
    .where(eq(quoteVersions.orderId, orderId))
    .orderBy(asc(quoteVersions.version));
  return rows.map(toQuoteVersion);
}

export async function recordPayment(input: {
  orderId: string;
  provider: string;
  providerPaymentId: string;
  providerCustomerId?: string;
  providerEventHash?: string | null;
  status: PaymentStatus;
  currency: string;
  amountMinor: number;
}): Promise<PaymentRecord> {
  await ensureMutationGuards();
  const order = await getClientOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  if (!(PAYMENT_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error("Unsupported payment status");
  }
  assertMinorAmount(input.amountMinor);
  assertOptionalSha256Hash(input.providerEventHash, "providerEventHash");
  const currency = normalizeCurrency(input.currency);
  if (currency !== order.currency) throw new Error("Payment currency must match the order");
  const now = new Date().toISOString();
  const row: typeof paymentRecords.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: order.id,
    provider: requiredText(input.provider, "Payment provider"),
    providerPaymentId: requiredText(input.providerPaymentId, "Provider payment ID"),
    providerCustomerId: input.providerCustomerId?.trim() ?? "",
    providerEventHash: input.providerEventHash || null,
    status: input.status,
    currency,
    amountMinor: input.amountMinor,
    paidAt: input.status === "succeeded" ? now : "",
    refundedAt: input.status === "refunded" ? now : "",
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(paymentRecords).values(row);
  return toPaymentRecord(row as typeof paymentRecords.$inferSelect);
}

export async function updatePaymentStatus(
  id: string,
  status: PaymentStatus,
): Promise<PaymentRecord> {
  await ensureMutationGuards();
  const [current] = await getDb()
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.id, id))
    .limit(1);
  if (!current) throw new Error("Payment record not found");
  const from = current.status as PaymentStatus;
  if (!PAYMENT_TRANSITIONS[from]?.includes(status)) {
    throw new Error(`Payment cannot move from ${from} to ${status}`);
  }
  const now = new Date().toISOString();
  const [updated] = await getDb()
    .update(paymentRecords)
    .set({
      status,
      ...(status === "succeeded" ? { paidAt: now } : {}),
      ...(status === "refunded" ? { refundedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(paymentRecords.id, id), eq(paymentRecords.status, from)))
    .returning();
  if (!updated) throw new Error("Payment status changed concurrently");
  return toPaymentRecord(updated);
}

export async function listPaymentRecords(orderId: string): Promise<PaymentRecord[]> {
  const rows = await getDb()
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.orderId, orderId))
    .orderBy(asc(paymentRecords.createdAt));
  return rows.map(toPaymentRecord);
}

export async function createIntakeSubmission(input: {
  orderId: string;
  status: IntakeStatus;
  answers: unknown;
  contentDigest: string;
}): Promise<IntakeSubmission> {
  await ensureMutationGuards();
  const order = await getClientOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  if (!["paid", "intake_pending", "intake_complete"].includes(order.state)) {
    throw new Error("Client intake is only accepted after payment");
  }
  assertSha256Hash(input.contentDigest, "contentDigest");
  const [latest] = await getDb()
    .select()
    .from(intakeSubmissions)
    .where(eq(intakeSubmissions.orderId, order.id))
    .orderBy(desc(intakeSubmissions.version))
    .limit(1);
  const now = new Date().toISOString();
  const row: typeof intakeSubmissions.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: order.id,
    version: (latest?.version ?? 0) + 1,
    status: input.status,
    answersJson: serializeJson(input.answers, "Intake answers"),
    contentDigest: input.contentDigest,
    createdAt: now,
    submittedAt: input.status === "submitted" ? now : "",
  };
  await getDb().insert(intakeSubmissions).values(row);
  return toIntakeSubmission(row as typeof intakeSubmissions.$inferSelect);
}

export async function listIntakeSubmissions(orderId: string): Promise<IntakeSubmission[]> {
  const rows = await getDb()
    .select()
    .from(intakeSubmissions)
    .where(eq(intakeSubmissions.orderId, orderId))
    .orderBy(asc(intakeSubmissions.version));
  return rows.map(toIntakeSubmission);
}

export async function createClientBuild(input: {
  orderId: string;
  artifactRef: string;
  sourceDigest: string;
  buildDigest: string;
  actor: WorkflowActor;
}): Promise<ClientBuild> {
  await ensureMutationGuards();
  const order = await getClientOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  if (order.state !== "generating") {
    throw new Error("Production builds can only be created while the order is generating");
  }
  const evidence = await loadOrderTransitionEvidence(order);
  assertProductionGenerationReady(evidence);
  assertSha256Hash(input.sourceDigest, "sourceDigest");
  assertSha256Hash(input.buildDigest, "buildDigest");
  const [latest] = await getDb()
    .select()
    .from(clientBuilds)
    .where(eq(clientBuilds.orderId, order.id))
    .orderBy(desc(clientBuilds.revision))
    .limit(1);
  const now = new Date().toISOString();
  const row: typeof clientBuilds.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: order.id,
    revision: (latest?.revision ?? 0) + 1,
    status: "generated",
    artifactRef: requiredText(input.artifactRef, "Build artifact reference"),
    sourceDigest: input.sourceDigest,
    buildDigest: input.buildDigest,
    qaStatus: "pending",
    qaReportJson: "{}",
    deploymentRef: "",
    deployedAt: "",
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(clientBuilds).values(row);
  await getDb()
    .update(clientOrders)
    .set({ activeBuildId: row.id, updatedAt: now })
    .where(and(eq(clientOrders.id, order.id), eq(clientOrders.state, "generating")));
  await appendClientWorkflowEvent({
    orderId: order.id,
    eventType: "build.generated",
    actor: input.actor,
    details: { buildId: row.id, buildDigest: row.buildDigest, revision: row.revision },
  });
  return toClientBuild(row as typeof clientBuilds.$inferSelect);
}

export async function getClientBuild(id: string): Promise<ClientBuild | null> {
  const [row] = await getDb()
    .select()
    .from(clientBuilds)
    .where(eq(clientBuilds.id, id))
    .limit(1);
  return row ? toClientBuild(row) : null;
}

export async function listClientBuilds(orderId: string): Promise<ClientBuild[]> {
  const rows = await getDb()
    .select()
    .from(clientBuilds)
    .where(eq(clientBuilds.orderId, orderId))
    .orderBy(asc(clientBuilds.revision));
  return rows.map(toClientBuild);
}

export async function recordBuildQa(input: {
  buildId: string;
  status: Exclude<QaStatus, "pending">;
  report: unknown;
  actor: WorkflowActor;
}): Promise<ClientBuild> {
  await ensureMutationGuards();
  const build = await getClientBuild(input.buildId);
  if (!build) throw new Error("Build not found");
  const now = new Date().toISOString();
  const [updated] = await getDb()
    .update(clientBuilds)
    .set({
      qaStatus: input.status,
      status: input.status === "passed" ? "qa_passed" : "qa_failed",
      qaReportJson: serializeJson(input.report, "QA report"),
      updatedAt: now,
    })
    .where(and(eq(clientBuilds.id, build.id), eq(clientBuilds.buildDigest, build.buildDigest)))
    .returning();
  if (!updated) throw new Error("Build changed concurrently");
  await appendClientWorkflowEvent({
    orderId: build.orderId,
    eventType: input.status === "passed" ? "build.qa_passed" : "build.qa_failed",
    actor: input.actor,
    details: { buildId: build.id, buildDigest: build.buildDigest },
  });
  return toClientBuild(updated);
}

export async function recordBuildApproval(input: {
  orderId: string;
  buildId: string;
  buildDigest: string;
  status: ApprovalStatus;
  approverCustomerId: string;
  approvalTokenHash?: string | null;
  note?: string;
}): Promise<BuildApproval> {
  await ensureMutationGuards();
  const [order, build, customer] = await Promise.all([
    getClientOrder(input.orderId),
    getClientBuild(input.buildId),
    getClientCustomer(input.approverCustomerId),
  ]);
  if (!order || !build || !customer) throw new Error("Order, build, or customer not found");
  if (order.customerId !== customer.id || build.orderId !== order.id) {
    throw new Error("Approval entities do not belong to the same order");
  }
  if (build.qaStatus !== "passed") throw new Error("Only a QA-passed build can be approved");
  if (input.buildDigest !== build.buildDigest) {
    throw new Error("Approval digest must match the exact active build digest");
  }
  if (order.activeBuildId !== build.id) throw new Error("Only the active build can be approved");
  assertOptionalSha256Hash(input.approvalTokenHash, "approvalTokenHash");
  const now = new Date().toISOString();
  const row: typeof buildApprovals.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: order.id,
    buildId: build.id,
    buildDigest: build.buildDigest,
    status: input.status,
    approverCustomerId: customer.id,
    approvalTokenHash: input.approvalTokenHash || null,
    note: input.note?.trim() ?? "",
    createdAt: now,
  };
  await getDb().insert(buildApprovals).values(row);
  await appendClientWorkflowEvent({
    orderId: order.id,
    eventType: `build.${input.status}`,
    actor: { type: "customer", id: customer.id },
    details: { buildId: build.id, buildDigest: build.buildDigest },
  });
  return toBuildApproval(row as typeof buildApprovals.$inferSelect);
}

export async function listBuildApprovals(buildId: string): Promise<BuildApproval[]> {
  const rows = await getDb()
    .select()
    .from(buildApprovals)
    .where(eq(buildApprovals.buildId, buildId))
    .orderBy(asc(buildApprovals.createdAt), asc(buildApprovals.id));
  return rows.map(toBuildApproval);
}

export async function recordBuildDeployment(input: {
  buildId: string;
  deploymentRef: string;
  completed: boolean;
  actor: WorkflowActor;
}): Promise<ClientBuild> {
  await ensureMutationGuards();
  const build = await getClientBuild(input.buildId);
  if (!build) throw new Error("Build not found");
  const order = await getClientOrder(build.orderId);
  if (!order || order.activeBuildId !== build.id) throw new Error("Build is not active");
  const evidence = await loadOrderTransitionEvidence(order);
  assertExactBuildApproval(evidence);
  const now = new Date().toISOString();
  const [updated] = await getDb()
    .update(clientBuilds)
    .set({
      deploymentRef: requiredText(input.deploymentRef, "Deployment reference"),
      deployedAt: input.completed ? now : "",
      status: input.completed ? "delivered" : "deploying",
      updatedAt: now,
    })
    .where(and(eq(clientBuilds.id, build.id), eq(clientBuilds.buildDigest, build.buildDigest)))
    .returning();
  if (!updated) throw new Error("Build changed concurrently");
  await appendClientWorkflowEvent({
    orderId: order.id,
    eventType: input.completed ? "build.deployed" : "build.deploying",
    actor: input.actor,
    details: { buildId: build.id, buildDigest: build.buildDigest },
  });
  return toClientBuild(updated);
}

export async function appendClientWorkflowEvent(input: {
  orderId: string;
  eventType: string;
  fromState?: string;
  toState?: string;
  actor: WorkflowActor;
  details?: unknown;
}): Promise<ClientWorkflowEvent> {
  await ensureMutationGuards();
  assertSafeEventDetails(input.details);
  const row: typeof clientWorkflowEvents.$inferInsert = {
    id: crypto.randomUUID(),
    orderId: input.orderId,
    eventType: requiredText(input.eventType, "Event type"),
    fromState: input.fromState ?? "",
    toState: input.toState ?? "",
    actorType: input.actor.type,
    actorId: input.actor.id?.trim() ?? "",
    detailsJson: serializeJson(input.details ?? {}, "Event details"),
    createdAt: new Date().toISOString(),
  };
  await getDb().insert(clientWorkflowEvents).values(row);
  return toWorkflowEvent(row as typeof clientWorkflowEvents.$inferSelect);
}

export async function listClientWorkflowEvents(orderId: string): Promise<ClientWorkflowEvent[]> {
  const rows = await getDb()
    .select()
    .from(clientWorkflowEvents)
    .where(eq(clientWorkflowEvents.orderId, orderId))
    .orderBy(asc(clientWorkflowEvents.createdAt), asc(clientWorkflowEvents.id));
  return rows.map(toWorkflowEvent);
}

export async function transitionClientOrder(input: {
  orderId: string;
  to: OrderState;
  actor: WorkflowActor;
  details?: unknown;
}): Promise<ClientOrder> {
  await ensureMutationGuards();
  const order = await getClientOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  const evidence = await loadOrderTransitionEvidence(order);
  assertOrderTransition(order.state, input.to, evidence);
  assertSafeEventDetails(input.details);
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const detailsJson = serializeJson(input.details ?? {}, "Transition details");
  const paidAt = input.to === "paid" ? now : order.paidAt;
  const intakeCompletedAt = input.to === "intake_complete" ? now : order.intakeCompletedAt;
  const deliveredAt = input.to === "delivered" ? now : order.deliveredAt;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE client_orders
       SET state = ?, last_transition_event_id = ?, paid_at = ?,
           intake_completed_at = ?, delivered_at = ?, updated_at = ?
       WHERE id = ? AND state = ?`,
    ).bind(
      input.to,
      eventId,
      paidAt,
      intakeCompletedAt,
      deliveredAt,
      now,
      order.id,
      order.state,
    ),
    env.DB.prepare(
      `INSERT INTO client_workflow_events (
        id, order_id, event_type, from_state, to_state, actor_type,
        actor_id, details_json, created_at
      ) SELECT ?, ?, 'order.transitioned', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM client_orders
          WHERE id = ? AND state = ? AND last_transition_event_id = ?
        )`,
    ).bind(
      eventId,
      order.id,
      order.state,
      input.to,
      input.actor.type,
      input.actor.id ?? "",
      detailsJson,
      now,
      order.id,
      input.to,
      eventId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error("Order state changed concurrently");
  }
  const updated = await getClientOrder(order.id);
  if (!updated) throw new Error("Order was not readable after transition");
  return updated;
}

export async function loadOrderTransitionEvidence(
  order: ClientOrder,
): Promise<OrderTransitionEvidence> {
  const [quote] = order.currentQuoteVersionId
    ? await getDb()
        .select()
        .from(quoteVersions)
        .where(
          and(
            eq(quoteVersions.id, order.currentQuoteVersionId),
            eq(quoteVersions.orderId, order.id),
          ),
        )
        .limit(1)
    : [];
  const [payments, submittedIntakes, build] = await Promise.all([
    getDb()
      .select()
      .from(paymentRecords)
      .where(
        and(
          eq(paymentRecords.orderId, order.id),
          eq(paymentRecords.status, "succeeded"),
        ),
      ),
    getDb()
      .select()
      .from(intakeSubmissions)
      .where(
        and(
          eq(intakeSubmissions.orderId, order.id),
          eq(intakeSubmissions.status, "submitted"),
        ),
      )
      .limit(1),
    order.activeBuildId
      ? getDb()
          .select()
          .from(clientBuilds)
          .where(
            and(
              eq(clientBuilds.id, order.activeBuildId),
              eq(clientBuilds.orderId, order.id),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  const paidAmount = quote
    ? payments
        .filter((payment) => payment.currency === quote.currency)
        .reduce((sum, payment) => sum + payment.amountMinor, 0)
    : 0;
  const [latestApproval] = build
    ? await getDb()
        .select()
        .from(buildApprovals)
        .where(eq(buildApprovals.buildId, build.id))
        .orderBy(desc(buildApprovals.createdAt), desc(buildApprovals.id))
        .limit(1)
    : [];
  return {
    hasCurrentQuote: Boolean(quote),
    hasSucceededPayment: Boolean(quote && paidAmount >= quote.amountMinor),
    hasSubmittedIntake: submittedIntakes.length > 0,
    activeBuildDigest: build?.buildDigest ?? null,
    qaPassedBuildDigest: build?.qaStatus === "passed" ? build.buildDigest : null,
    approvedBuildDigest:
      latestApproval?.status === "approved" &&
      latestApproval.buildDigest === build?.buildDigest
        ? latestApproval.buildDigest
        : null,
    deploymentReference: build?.deploymentRef || null,
  };
}

function toCustomer(row: typeof clientCustomers.$inferSelect): ClientCustomer {
  return { ...row, status: row.status as ClientCustomer["status"] };
}

function toOrder(row: typeof clientOrders.$inferSelect): ClientOrder {
  return { ...row, state: row.state as OrderState };
}

function toQuoteVersion(row: typeof quoteVersions.$inferSelect): QuoteVersion {
  return {
    id: row.id,
    orderId: row.orderId,
    version: row.version,
    currency: row.currency,
    amountMinor: row.amountMinor,
    scope: parseJson(row.scopeJson),
    terms: parseJson(row.termsJson),
    contentDigest: row.contentDigest,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function toPaymentRecord(row: typeof paymentRecords.$inferSelect): PaymentRecord {
  return { ...row, status: row.status as PaymentStatus };
}

function toIntakeSubmission(row: typeof intakeSubmissions.$inferSelect): IntakeSubmission {
  return {
    id: row.id,
    orderId: row.orderId,
    version: row.version,
    status: row.status as IntakeStatus,
    answers: parseJson(row.answersJson),
    contentDigest: row.contentDigest,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
  };
}

function toClientBuild(row: typeof clientBuilds.$inferSelect): ClientBuild {
  return {
    ...row,
    status: row.status as ClientBuild["status"],
    qaStatus: row.qaStatus as QaStatus,
    qaReport: parseJson(row.qaReportJson),
  };
}

function toBuildApproval(row: typeof buildApprovals.$inferSelect): BuildApproval {
  return { ...row, status: row.status as ApprovalStatus };
}

function toWorkflowEvent(row: typeof clientWorkflowEvents.$inferSelect): ClientWorkflowEvent {
  return {
    id: row.id,
    orderId: row.orderId,
    eventType: row.eventType,
    fromState: row.fromState,
    toState: row.toState,
    actorType: row.actorType as WorkflowActorType,
    actorId: row.actorId,
    details: parseJson(row.detailsJson),
    createdAt: row.createdAt,
  };
}
