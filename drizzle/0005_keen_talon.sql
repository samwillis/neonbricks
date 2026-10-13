ALTER TABLE "ai_generations" ADD COLUMN "target" uuid;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "activity" text;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "preview_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_target_worlds_id_fk" FOREIGN KEY ("target") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;