CREATE TABLE `checkpoint` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`source` text NOT NULL DEFAULT 'prompt',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checkpoint_session_message_idx` ON `checkpoint` (`session_id`,`message_id`);
