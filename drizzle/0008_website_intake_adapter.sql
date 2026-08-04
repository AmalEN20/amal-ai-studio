ALTER TABLE `leads` ADD COLUMN `gmail_thread_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `website_intake_imports` (
	`submission_id` text PRIMARY KEY NOT NULL CHECK (
		length(`submission_id`) BETWEEN 1 AND 160
		AND `submission_id` NOT GLOB '*[^A-Za-z0-9_-]*'
	),
	`public_reference` text NOT NULL,
	`schema_version` integer NOT NULL CHECK (`schema_version` = 3),
	`source` text NOT NULL CHECK (`source` IN ('website', 'gmail_outreach')),
	`normalized_email` text NOT NULL CHECK (
		length(`normalized_email`) BETWEEN 3 AND 320
		AND `normalized_email` = lower(trim(`normalized_email`))
	),
	`lead_id` text NOT NULL,
	`gmail_thread_id` text DEFAULT '' NOT NULL,
	`brief_json` text NOT NULL CHECK (json_valid(`brief_json`)),
	`status` text DEFAULT 'saved' NOT NULL CHECK (`status` IN ('saved', 'acknowledged')),
	`imported_at` text NOT NULL,
	`acknowledged_at` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `website_intake_imports_lead_idx` ON `website_intake_imports` (`lead_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `website_intake_imports_status_idx` ON `website_intake_imports` (`status`, `imported_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `website_intake_assets` (
	`submission_id` text NOT NULL,
	`asset_id` text NOT NULL CHECK (
		length(`asset_id`) BETWEEN 1 AND 160
		AND `asset_id` NOT GLOB '*[^A-Za-z0-9_-]*'
	),
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`size_bytes` integer NOT NULL CHECK (`size_bytes` BETWEEN 0 AND 20971520),
	`sha256` text NOT NULL CHECK (
		length(`sha256`) = 43
		AND `sha256` NOT GLOB '*[^A-Za-z0-9_-]*'
	),
	`object_key` text NOT NULL,
	`imported_at` text NOT NULL,
	PRIMARY KEY (`submission_id`, `asset_id`),
	FOREIGN KEY (`submission_id`) REFERENCES `website_intake_imports`(`submission_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `website_intake_assets_object_key_unique` ON `website_intake_assets` (`object_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `website_intake_assets_submission_idx` ON `website_intake_assets` (`submission_id`);
