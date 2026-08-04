type SchemaGuardDatabase = Pick<D1Database, "prepare">;

export const DEFAULT_MONTHLY_BUDGET_USD = 10;
export const HARD_AI_MONTHLY_CAP_USD = 30;

export const AI_BUDGET_SCHEMA_GUARDS = [
  `CREATE TRIGGER IF NOT EXISTS ai_budget_reservation_insert_guard
BEFORE INSERT ON ai_budget_reservations
BEGIN
  SELECT CASE
    WHEN NEW.status != 'reserved'
      OR NEW.reserved_cost_micros <= 0
      OR NEW.actual_cost_micros != 0
    THEN RAISE(ABORT, 'AI_INVALID_BUDGET_RESERVATION')
  END;
END`,
  `CREATE TRIGGER IF NOT EXISTS ai_budget_reservation_insert
BEFORE INSERT ON ai_budget_reservations
WHEN NEW.status = 'reserved'
BEGIN
  UPDATE ai_budget_ledger
  SET reserved_cost_micros = reserved_cost_micros + NEW.reserved_cost_micros,
      updated_at = NEW.updated_at
  WHERE month_start = NEW.month_start
    AND spent_cost_micros + reserved_cost_micros + NEW.reserved_cost_micros <=
      MIN(
        ${HARD_AI_MONTHLY_CAP_USD * 1_000_000},
        CAST(COALESCE(
          (SELECT CASE
            WHEN CAST(value AS REAL) > 0 THEN CAST(value AS REAL)
            ELSE NULL
          END FROM ai_settings WHERE key = 'monthly_budget_usd'),
          ${DEFAULT_MONTHLY_BUDGET_USD}
        ) * 1000000 AS INTEGER)
      );
  SELECT CASE
    WHEN changes() = 0 THEN RAISE(ABORT, 'AI_MONTHLY_BUDGET_EXCEEDED')
  END;
END`,
  `CREATE TRIGGER IF NOT EXISTS ai_budget_reservation_update_guard
BEFORE UPDATE ON ai_budget_reservations
BEGIN
  SELECT CASE
    WHEN OLD.status != 'reserved'
      OR NEW.id != OLD.id
      OR NEW.month_start != OLD.month_start
      OR NEW.feature != OLD.feature
      OR NEW.model != OLD.model
      OR NEW.project_id != OLD.project_id
      OR NEW.reserved_cost_micros != OLD.reserved_cost_micros
      OR NEW.created_at != OLD.created_at
      OR NEW.status NOT IN ('settled', 'released')
      OR (NEW.status = 'settled' AND (
        NEW.actual_cost_micros < 0
        OR NEW.actual_cost_micros > OLD.reserved_cost_micros
      ))
      OR (NEW.status = 'released' AND NEW.actual_cost_micros != 0)
    THEN RAISE(ABORT, 'AI_INVALID_BUDGET_RESERVATION_UPDATE')
  END;
END`,
  `CREATE TRIGGER IF NOT EXISTS ai_budget_reservation_settle
AFTER UPDATE OF status ON ai_budget_reservations
WHEN OLD.status = 'reserved' AND NEW.status IN ('settled', 'released')
BEGIN
  UPDATE ai_budget_ledger
  SET reserved_cost_micros = MAX(0, reserved_cost_micros - OLD.reserved_cost_micros),
      spent_cost_micros = spent_cost_micros + CASE
        WHEN NEW.status = 'settled' THEN NEW.actual_cost_micros
        ELSE 0
      END,
      updated_at = NEW.updated_at
  WHERE month_start = OLD.month_start;
END`,
] as const;

export const CLIENT_WORKFLOW_SCHEMA_GUARDS = [
  `CREATE TRIGGER IF NOT EXISTS quote_versions_immutable_update
BEFORE UPDATE ON quote_versions
BEGIN
  SELECT RAISE(ABORT, 'QUOTE_VERSION_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS quote_versions_immutable_delete
BEFORE DELETE ON quote_versions
BEGIN
  SELECT RAISE(ABORT, 'QUOTE_VERSION_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS client_workflow_events_append_only_update
BEFORE UPDATE ON client_workflow_events
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_EVENT_APPEND_ONLY');
END`,
  `CREATE TRIGGER IF NOT EXISTS client_workflow_events_append_only_delete
BEFORE DELETE ON client_workflow_events
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_EVENT_APPEND_ONLY');
END`,
  `CREATE TRIGGER IF NOT EXISTS build_approvals_immutable_update
BEFORE UPDATE ON build_approvals
BEGIN
  SELECT RAISE(ABORT, 'BUILD_APPROVAL_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS build_approvals_immutable_delete
BEFORE DELETE ON build_approvals
BEGIN
  SELECT RAISE(ABORT, 'BUILD_APPROVAL_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS payment_records_identity_immutable
BEFORE UPDATE ON payment_records
WHEN NEW.order_id != OLD.order_id
  OR NEW.provider != OLD.provider
  OR NEW.provider_payment_id != OLD.provider_payment_id
  OR NEW.provider_customer_id != OLD.provider_customer_id
  OR NEW.currency != OLD.currency
  OR NEW.amount_minor != OLD.amount_minor
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IDENTITY_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS client_build_digest_immutable
BEFORE UPDATE ON client_builds
WHEN NEW.order_id != OLD.order_id
  OR NEW.revision != OLD.revision
  OR NEW.artifact_ref != OLD.artifact_ref
  OR NEW.source_digest != OLD.source_digest
  OR NEW.build_digest != OLD.build_digest
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'BUILD_DIGEST_IMMUTABLE');
END`,
  `CREATE TRIGGER IF NOT EXISTS client_order_state_transition_guard
BEFORE UPDATE OF state ON client_orders
WHEN NEW.state != OLD.state
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.state = 'quote_draft' AND NEW.state IN ('quote_sent', 'cancelled')) OR
    (OLD.state = 'quote_sent' AND NEW.state IN ('awaiting_payment', 'cancelled')) OR
    (OLD.state = 'awaiting_payment' AND NEW.state IN ('paid', 'cancelled')) OR
    (OLD.state = 'paid' AND NEW.state IN ('intake_pending', 'refunded')) OR
    (OLD.state = 'intake_pending' AND NEW.state IN ('intake_complete', 'refunded')) OR
    (OLD.state = 'intake_complete' AND NEW.state IN ('generation_ready', 'refunded')) OR
    (OLD.state = 'generation_ready' AND NEW.state IN ('generating', 'refunded')) OR
    (OLD.state = 'generating' AND NEW.state IN ('qa_pending', 'generation_ready', 'refunded')) OR
    (OLD.state = 'qa_pending' AND NEW.state IN ('client_review', 'generating', 'refunded')) OR
    (OLD.state = 'client_review' AND NEW.state IN ('approved', 'generating', 'refunded')) OR
    (OLD.state = 'approved' AND NEW.state IN ('deploy_ready', 'generating', 'refunded')) OR
    (OLD.state = 'deploy_ready' AND NEW.state IN ('deploying', 'generating', 'refunded')) OR
    (OLD.state = 'deploying' AND NEW.state IN ('delivered', 'deploy_ready'))
  ) THEN RAISE(ABORT, 'INVALID_ORDER_TRANSITION') END;

  SELECT CASE WHEN NEW.state IN ('quote_sent', 'awaiting_payment')
    AND NEW.current_quote_version_id = ''
    THEN RAISE(ABORT, 'QUOTE_REQUIRED') END;

  SELECT CASE WHEN NEW.state IN ('paid', 'generation_ready', 'generating')
    AND NOT EXISTS (
      SELECT 1 FROM quote_versions q
      WHERE q.id = NEW.current_quote_version_id
        AND q.order_id = NEW.id
        AND COALESCE((
          SELECT SUM(p.amount_minor) FROM payment_records p
          WHERE p.order_id = NEW.id
            AND p.status = 'succeeded'
            AND p.currency = q.currency
        ), 0) >= q.amount_minor
    )
    THEN RAISE(ABORT, 'PAYMENT_REQUIRED') END;

  SELECT CASE WHEN NEW.state IN ('intake_complete', 'generation_ready', 'generating')
    AND NOT EXISTS (
      SELECT 1 FROM intake_submissions i
      WHERE i.order_id = NEW.id AND i.status = 'submitted'
    )
    THEN RAISE(ABORT, 'INTAKE_REQUIRED') END;

  SELECT CASE WHEN NEW.state = 'client_review'
    AND NOT EXISTS (
      SELECT 1 FROM client_builds b
      WHERE b.id = NEW.active_build_id
        AND b.order_id = NEW.id
        AND b.qa_status = 'passed'
    )
    THEN RAISE(ABORT, 'QA_REQUIRED') END;

  SELECT CASE WHEN NEW.state IN ('approved', 'deploy_ready', 'deploying', 'delivered')
    AND NOT EXISTS (
      SELECT 1 FROM client_builds b
      WHERE b.id = NEW.active_build_id
        AND b.order_id = NEW.id
        AND b.qa_status = 'passed'
        AND (
          SELECT a.status FROM build_approvals a
          WHERE a.build_id = b.id AND a.build_digest = b.build_digest
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1
        ) = 'approved'
    )
    THEN RAISE(ABORT, 'EXACT_BUILD_APPROVAL_REQUIRED') END;

  SELECT CASE WHEN NEW.state = 'delivered'
    AND NOT EXISTS (
      SELECT 1 FROM client_builds b
      WHERE b.id = NEW.active_build_id
        AND b.deployment_ref != ''
    )
    THEN RAISE(ABORT, 'DEPLOYMENT_REFERENCE_REQUIRED') END;
END`,
] as const;

const aiBudgetInstalls = new WeakMap<object, Promise<void>>();
const clientWorkflowInstalls = new WeakMap<object, Promise<void>>();

async function installSchemaGuards(
  database: SchemaGuardDatabase,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await database.prepare(statement).run();
  }
}

function ensureSchemaGuards(
  database: SchemaGuardDatabase,
  statements: readonly string[],
  installs: WeakMap<object, Promise<void>>,
): Promise<void> {
  const key = database as object;
  const current = installs.get(key);
  if (current) return current;

  const pending = installSchemaGuards(database, statements).catch((error: unknown) => {
    installs.delete(key);
    throw error;
  });
  installs.set(key, pending);
  return pending;
}

export function ensureAiBudgetSchemaGuards(database: SchemaGuardDatabase): Promise<void> {
  return ensureSchemaGuards(database, AI_BUDGET_SCHEMA_GUARDS, aiBudgetInstalls);
}

export function ensureClientWorkflowSchemaGuards(
  database: SchemaGuardDatabase,
): Promise<void> {
  return ensureSchemaGuards(
    database,
    CLIENT_WORKFLOW_SCHEMA_GUARDS,
    clientWorkflowInstalls,
  );
}
