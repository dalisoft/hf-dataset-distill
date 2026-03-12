CREATE TABLE `dataset` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`messages` blob
);
--> statement-breakpoint
CREATE TABLE `output_batch` (
	`request_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `output_batch_batch_id_unique` ON `output_batch` (`batch_id`);--> statement-breakpoint
CREATE INDEX `output_batch_status_idx` ON `output_batch` (`status`);--> statement-breakpoint
CREATE TABLE `store` (
	`batchId` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_hash_unique` ON `store` (`hash`);--> statement-breakpoint
CREATE INDEX `store_hash_idx` ON `store` (`hash`);