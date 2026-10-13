ALTER TABLE "ai_generations" ADD COLUMN "session" uuid;--> statement-breakpoint
CREATE INDEX "ai_generations_target_created" ON "ai_generations" USING btree ("target","created_at","id");--> statement-breakpoint
CREATE INDEX "ai_generations_legacy_created" ON "ai_generations" USING btree ("world","guest","created_at","id") WHERE "ai_generations"."target" IS NULL;