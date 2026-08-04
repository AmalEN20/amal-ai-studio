import {
  index,
  integer,
  primaryKey,
  text,
  sqliteTable,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  industry: text("industry").notNull(),
  description: text("description").notNull(),
  audience: text("audience").notNull(),
  offer: text("offer").notNull(),
  location: text("location").notNull(),
  website: text("website").notNull().default(""),
  tone: text("tone").notNull().default("premium"),
  status: text("status").notNull().default("intake"),
  stagesJson: text("stages_json").notNull(),
  siteJson: text("site_json"),
  provider: text("provider").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  sourceKey: text("source_key").notNull().unique(),
  searchBatchId: text("search_batch_id").notNull().default(""),
  name: text("name").notNull(),
  industry: text("industry").notNull(),
  location: text("location").notNull(),
  website: text("website").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  rating: text("rating"),
  reviewCount: text("review_count"),
  source: text("source").notNull().default("demo"),
  stage: text("stage").notNull().default("discovered"),
  savedForLaunch: integer("saved_for_launch", { mode: "boolean" })
    .notNull()
    .default(false),
  savedForLaunchAt: text("saved_for_launch_at").notNull().default(""),
  auditJson: text("audit_json"),
  outreachJson: text("outreach_json"),
  siteJson: text("site_json"),
  analysisProvider: text("analysis_provider").notNull().default("pending"),
  sendProvider: text("send_provider").notNull().default("pending"),
  gmailMessageId: text("gmail_message_id").notNull().default(""),
  gmailThreadId: text("gmail_thread_id").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const researchJobs = sqliteTable(
  "research_jobs",
  {
    id: text("id").primaryKey(),
    targetCount: integer("target_count").notNull(),
    status: text("status").notNull().default("running"),
    planJson: text("plan_json").notNull(),
    searchIndex: integer("search_index").notNull().default(0),
    pageToken: text("page_token").notNull().default(""),
    pageNumber: integer("page_number").notNull().default(0),
    placesRequests: integer("places_requests").notNull().default(0),
    searchesCompleted: integer("searches_completed").notNull().default(0),
    rawCount: integer("raw_count").notNull().default(0),
    uniqueCount: integer("unique_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    checkedCount: integer("checked_count").notNull().default(0),
    qualifiedCount: integer("qualified_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    stopReason: text("stop_reason").notNull().default(""),
    lastError: text("last_error").notNull().default(""),
    lockedUntil: text("locked_until").notNull().default(""),
    heartbeatAt: text("heartbeat_at").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("research_jobs_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
  ],
);

export const researchJobLeads = sqliteTable(
  "research_job_leads",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => researchJobs.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.leadId] }),
    index("research_job_leads_job_status_idx").on(
      table.jobId,
      table.status,
      table.createdAt,
    ),
    index("research_job_leads_lead_idx").on(table.leadId),
  ],
);

export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    projectId: text("project_id").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    estimatedCostMicros: integer("estimated_cost_micros").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("ai_usage_created_at_idx").on(table.createdAt)],
);

export const aiSettings = sqliteTable("ai_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const aiBudgetLedger = sqliteTable("ai_budget_ledger", {
  monthStart: text("month_start").primaryKey(),
  spentCostMicros: integer("spent_cost_micros").notNull().default(0),
  reservedCostMicros: integer("reserved_cost_micros").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const aiBudgetReservations = sqliteTable(
  "ai_budget_reservations",
  {
    id: text("id").primaryKey(),
    monthStart: text("month_start").notNull(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    projectId: text("project_id").notNull().default(""),
    reservedCostMicros: integer("reserved_cost_micros").notNull(),
    actualCostMicros: integer("actual_cost_micros").notNull().default(0),
    status: text("status").notNull().default("reserved"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("ai_budget_reservations_month_status_idx").on(
      table.monthStart,
      table.status,
    ),
  ],
);

export const clientCustomers = sqliteTable(
  "client_customers",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id").notNull().default(""),
    name: text("name").notNull(),
    companyName: text("company_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("client_customers_email_idx").on(table.email),
    index("client_customers_lead_idx").on(table.leadId),
  ],
);

export const clientOrders = sqliteTable(
  "client_orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => clientCustomers.id, { onDelete: "restrict" }),
    leadId: text("lead_id").notNull().default(""),
    state: text("state").notNull().default("quote_draft"),
    currency: text("currency").notNull().default("USD"),
    portalTokenHash: text("portal_token_hash"),
    currentQuoteVersionId: text("current_quote_version_id")
      .notNull()
      .default(""),
    activeBuildId: text("active_build_id").notNull().default(""),
    lastTransitionEventId: text("last_transition_event_id")
      .notNull()
      .default(""),
    paidAt: text("paid_at").notNull().default(""),
    intakeCompletedAt: text("intake_completed_at").notNull().default(""),
    deliveredAt: text("delivered_at").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("client_orders_customer_state_idx").on(
      table.customerId,
      table.state,
    ),
    index("client_orders_updated_idx").on(table.updatedAt),
    uniqueIndex("client_orders_portal_token_hash_unique").on(
      table.portalTokenHash,
    ),
  ],
);

export const quoteVersions = sqliteTable(
  "quote_versions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    scopeJson: text("scope_json").notNull(),
    termsJson: text("terms_json").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("quote_versions_order_version_unique").on(
      table.orderId,
      table.version,
    ),
    index("quote_versions_order_created_idx").on(
      table.orderId,
      table.createdAt,
    ),
  ],
);

export const paymentRecords = sqliteTable(
  "payment_records",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    providerCustomerId: text("provider_customer_id").notNull().default(""),
    providerEventHash: text("provider_event_hash"),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    paidAt: text("paid_at").notNull().default(""),
    refundedAt: text("refunded_at").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("payment_records_provider_payment_unique").on(
      table.provider,
      table.providerPaymentId,
    ),
    uniqueIndex("payment_records_provider_event_hash_unique").on(
      table.providerEventHash,
    ),
    index("payment_records_order_status_idx").on(
      table.orderId,
      table.status,
    ),
  ],
);

export const intakeSubmissions = sqliteTable(
  "intake_submissions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    answersJson: text("answers_json").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: text("created_at").notNull(),
    submittedAt: text("submitted_at").notNull().default(""),
  },
  (table) => [
    uniqueIndex("intake_submissions_order_version_unique").on(
      table.orderId,
      table.version,
    ),
    index("intake_submissions_order_status_idx").on(
      table.orderId,
      table.status,
    ),
  ],
);

export const clientBuilds = sqliteTable(
  "client_builds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    status: text("status").notNull().default("generated"),
    artifactRef: text("artifact_ref").notNull(),
    sourceDigest: text("source_digest").notNull(),
    buildDigest: text("build_digest").notNull(),
    qaStatus: text("qa_status").notNull().default("pending"),
    qaReportJson: text("qa_report_json").notNull().default("{}"),
    deploymentRef: text("deployment_ref").notNull().default(""),
    deployedAt: text("deployed_at").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("client_builds_order_revision_unique").on(
      table.orderId,
      table.revision,
    ),
    index("client_builds_order_status_idx").on(
      table.orderId,
      table.status,
    ),
  ],
);

export const buildApprovals = sqliteTable(
  "build_approvals",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "restrict" }),
    buildId: text("build_id")
      .notNull()
      .references(() => clientBuilds.id, { onDelete: "restrict" }),
    buildDigest: text("build_digest").notNull(),
    status: text("status").notNull(),
    approverCustomerId: text("approver_customer_id")
      .notNull()
      .references(() => clientCustomers.id, { onDelete: "restrict" }),
    approvalTokenHash: text("approval_token_hash"),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("build_approvals_build_created_idx").on(
      table.buildId,
      table.createdAt,
    ),
    uniqueIndex("build_approvals_token_hash_unique").on(
      table.approvalTokenHash,
    ),
  ],
);

export const clientWorkflowEvents = sqliteTable(
  "client_workflow_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => clientOrders.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    fromState: text("from_state").notNull().default(""),
    toState: text("to_state").notNull().default(""),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull().default(""),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("client_workflow_events_order_created_idx").on(
      table.orderId,
      table.createdAt,
    ),
  ],
);

export const websiteIntakeImports = sqliteTable(
  "website_intake_imports",
  {
    submissionId: text("submission_id").primaryKey(),
    publicReference: text("public_reference").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    source: text("source").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "restrict" }),
    gmailThreadId: text("gmail_thread_id").notNull().default(""),
    briefJson: text("brief_json").notNull(),
    status: text("status").notNull().default("saved"),
    importedAt: text("imported_at").notNull(),
    acknowledgedAt: text("acknowledged_at").notNull().default(""),
  },
  (table) => [
    index("website_intake_imports_lead_idx").on(table.leadId),
    index("website_intake_imports_status_idx").on(
      table.status,
      table.importedAt,
    ),
  ],
);

export const websiteIntakeAssets = sqliteTable(
  "website_intake_assets",
  {
    submissionId: text("submission_id")
      .notNull()
      .references(() => websiteIntakeImports.submissionId, {
        onDelete: "restrict",
      }),
    assetId: text("asset_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    role: text("role").notNull().default(""),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    importedAt: text("imported_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.assetId] }),
    uniqueIndex("website_intake_assets_object_key_unique").on(table.objectKey),
    index("website_intake_assets_submission_idx").on(table.submissionId),
  ],
);
