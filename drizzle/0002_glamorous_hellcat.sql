ALTER TABLE "viewer_sessions" ADD COLUMN "cursor" jsonb;--> statement-breakpoint
ALTER TABLE "viewer_sessions" ADD COLUMN "cursor_at" timestamp with time zone;