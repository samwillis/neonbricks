ALTER TABLE "ai_generations" ADD COLUMN "design" jsonb;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "source" uuid;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "reference" jsonb;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "attempts" jsonb DEFAULT '{}'::jsonb NOT NULL;