CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`industry` text NOT NULL,
	`description` text NOT NULL,
	`audience` text NOT NULL,
	`offer` text NOT NULL,
	`location` text NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`tone` text DEFAULT 'premium' NOT NULL,
	`status` text DEFAULT 'intake' NOT NULL,
	`stages_json` text NOT NULL,
	`site_json` text,
	`provider` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
