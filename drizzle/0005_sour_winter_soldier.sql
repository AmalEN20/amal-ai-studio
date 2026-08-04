CREATE TABLE IF NOT EXISTS `research_job_leads` (
	`job_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `lead_id`),
	FOREIGN KEY (`job_id`) REFERENCES `research_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `research_job_leads_job_status_idx` ON `research_job_leads` (`job_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `research_job_leads_lead_idx` ON `research_job_leads` (`lead_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `research_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_count` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`plan_json` text NOT NULL,
	`search_index` integer DEFAULT 0 NOT NULL,
	`page_token` text DEFAULT '' NOT NULL,
	`page_number` integer DEFAULT 0 NOT NULL,
	`places_requests` integer DEFAULT 0 NOT NULL,
	`searches_completed` integer DEFAULT 0 NOT NULL,
	`raw_count` integer DEFAULT 0 NOT NULL,
	`unique_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`checked_count` integer DEFAULT 0 NOT NULL,
	`qualified_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`stop_reason` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`locked_until` text DEFAULT '' NOT NULL,
	`heartbeat_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `research_jobs_status_updated_idx` ON `research_jobs` (`status`,`updated_at`);
