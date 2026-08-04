ALTER TABLE `leads` ADD `saved_for_launch` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `saved_for_launch_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `leads`
SET `saved_for_launch` = 1,
    `saved_for_launch_at` = `updated_at`
WHERE `source` <> 'demo'
  AND `stage` IN ('qualified', 'drafted', 'approved');
