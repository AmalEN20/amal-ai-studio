CREATE TABLE IF NOT EXISTS `ai_budget_ledger` (
	`month_start` text PRIMARY KEY NOT NULL,
	`spent_cost_micros` integer DEFAULT 0 NOT NULL,
	`reserved_cost_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`month_start` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`reserved_cost_micros` integer NOT NULL,
	`actual_cost_micros` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_budget_reservations_month_status_idx` ON `ai_budget_reservations` (`month_start`,`status`);
