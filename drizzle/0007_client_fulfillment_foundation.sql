CREATE TABLE IF NOT EXISTS `client_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`company_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active', 'archived')),
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_customers_email_idx` ON `client_customers` (`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_customers_lead_idx` ON `client_customers` (`lead_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `client_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`lead_id` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'quote_draft' NOT NULL CHECK (`state` IN (
		'quote_draft', 'quote_sent', 'awaiting_payment', 'paid',
		'intake_pending', 'intake_complete', 'generation_ready', 'generating',
		'qa_pending', 'client_review', 'approved', 'deploy_ready', 'deploying',
		'delivered', 'cancelled', 'refunded'
	)),
	`currency` text DEFAULT 'USD' NOT NULL CHECK (length(`currency`) = 3),
	`portal_token_hash` text CHECK (`portal_token_hash` IS NULL OR (
		length(`portal_token_hash`) = 71 AND substr(`portal_token_hash`, 1, 7) = 'sha256:'
		AND lower(substr(`portal_token_hash`, 8)) NOT GLOB '*[^0-9a-f]*'
	)),
	`current_quote_version_id` text DEFAULT '' NOT NULL,
	`active_build_id` text DEFAULT '' NOT NULL,
	`last_transition_event_id` text DEFAULT '' NOT NULL,
	`paid_at` text DEFAULT '' NOT NULL,
	`intake_completed_at` text DEFAULT '' NOT NULL,
	`delivered_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `client_customers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_orders_customer_state_idx` ON `client_orders` (`customer_id`, `state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_orders_updated_idx` ON `client_orders` (`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `client_orders_portal_token_hash_unique` ON `client_orders` (`portal_token_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quote_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`version` integer NOT NULL CHECK (`version` > 0),
	`currency` text NOT NULL CHECK (length(`currency`) = 3),
	`amount_minor` integer NOT NULL CHECK (`amount_minor` >= 0),
	`scope_json` text NOT NULL CHECK (json_valid(`scope_json`)),
	`terms_json` text NOT NULL CHECK (json_valid(`terms_json`)),
	`content_digest` text NOT NULL CHECK (
		length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:'
		AND lower(substr(`content_digest`, 8)) NOT GLOB '*[^0-9a-f]*'
	),
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `quote_versions_order_version_unique` ON `quote_versions` (`order_id`, `version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quote_versions_order_created_idx` ON `quote_versions` (`order_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_records` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_payment_id` text NOT NULL,
	`provider_customer_id` text DEFAULT '' NOT NULL,
	`provider_event_hash` text CHECK (`provider_event_hash` IS NULL OR (
		length(`provider_event_hash`) = 71 AND substr(`provider_event_hash`, 1, 7) = 'sha256:'
		AND lower(substr(`provider_event_hash`, 8)) NOT GLOB '*[^0-9a-f]*'
	)),
	`status` text NOT NULL CHECK (`status` IN (
		'pending', 'requires_action', 'processing', 'succeeded', 'failed',
		'cancelled', 'partially_refunded', 'refunded'
	)),
	`currency` text NOT NULL CHECK (length(`currency`) = 3),
	`amount_minor` integer NOT NULL CHECK (`amount_minor` >= 0),
	`paid_at` text DEFAULT '' NOT NULL,
	`refunded_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_records_provider_payment_unique` ON `payment_records` (`provider`, `provider_payment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `payment_records_provider_event_hash_unique` ON `payment_records` (`provider_event_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `payment_records_order_status_idx` ON `payment_records` (`order_id`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `intake_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`version` integer NOT NULL CHECK (`version` > 0),
	`status` text DEFAULT 'draft' NOT NULL CHECK (`status` IN ('draft', 'submitted')),
	`answers_json` text NOT NULL CHECK (json_valid(`answers_json`)),
	`content_digest` text NOT NULL CHECK (
		length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:'
		AND lower(substr(`content_digest`, 8)) NOT GLOB '*[^0-9a-f]*'
	),
	`created_at` text NOT NULL,
	`submitted_at` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `intake_submissions_order_version_unique` ON `intake_submissions` (`order_id`, `version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `intake_submissions_order_status_idx` ON `intake_submissions` (`order_id`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `client_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`revision` integer NOT NULL CHECK (`revision` > 0),
	`status` text DEFAULT 'generated' NOT NULL CHECK (`status` IN (
		'generated', 'qa_pending', 'qa_failed', 'qa_passed', 'client_review',
		'approved', 'deploying', 'delivered'
	)),
	`artifact_ref` text NOT NULL,
	`source_digest` text NOT NULL CHECK (
		length(`source_digest`) = 71 AND substr(`source_digest`, 1, 7) = 'sha256:'
		AND lower(substr(`source_digest`, 8)) NOT GLOB '*[^0-9a-f]*'
	),
	`build_digest` text NOT NULL CHECK (
		length(`build_digest`) = 71 AND substr(`build_digest`, 1, 7) = 'sha256:'
		AND lower(substr(`build_digest`, 8)) NOT GLOB '*[^0-9a-f]*'
	),
	`qa_status` text DEFAULT 'pending' NOT NULL CHECK (`qa_status` IN ('pending', 'passed', 'failed')),
	`qa_report_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`qa_report_json`)),
	`deployment_ref` text DEFAULT '' NOT NULL,
	`deployed_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `client_builds_order_revision_unique` ON `client_builds` (`order_id`, `revision`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_builds_order_status_idx` ON `client_builds` (`order_id`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `build_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`build_id` text NOT NULL,
	`build_digest` text NOT NULL CHECK (
		length(`build_digest`) = 71 AND substr(`build_digest`, 1, 7) = 'sha256:'
		AND lower(substr(`build_digest`, 8)) NOT GLOB '*[^0-9a-f]*'
	),
	`status` text NOT NULL CHECK (`status` IN ('approved', 'rejected', 'revoked')),
	`approver_customer_id` text NOT NULL,
	`approval_token_hash` text CHECK (`approval_token_hash` IS NULL OR (
		length(`approval_token_hash`) = 71 AND substr(`approval_token_hash`, 1, 7) = 'sha256:'
		AND lower(substr(`approval_token_hash`, 8)) NOT GLOB '*[^0-9a-f]*'
	)),
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`build_id`) REFERENCES `client_builds`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver_customer_id`) REFERENCES `client_customers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `build_approvals_build_created_idx` ON `build_approvals` (`build_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `build_approvals_token_hash_unique` ON `build_approvals` (`approval_token_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `client_workflow_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_state` text DEFAULT '' NOT NULL,
	`to_state` text DEFAULT '' NOT NULL,
	`actor_type` text NOT NULL CHECK (`actor_type` IN ('owner', 'customer', 'system', 'provider')),
	`actor_id` text DEFAULT '' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`details_json`)),
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `client_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `client_workflow_events_order_created_idx` ON `client_workflow_events` (`order_id`, `created_at`);
