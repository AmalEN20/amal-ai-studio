CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`search_batch_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`industry` text NOT NULL,
	`location` text NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`rating` text,
	`review_count` text,
	`source` text DEFAULT 'demo' NOT NULL,
	`stage` text DEFAULT 'discovered' NOT NULL,
	`audit_json` text,
	`outreach_json` text,
	`site_json` text,
	`analysis_provider` text DEFAULT 'pending' NOT NULL,
	`send_provider` text DEFAULT 'pending' NOT NULL,
	`gmail_message_id` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_source_key_unique` ON `leads` (`source_key`);
