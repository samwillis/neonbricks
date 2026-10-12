CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guest" uuid NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"blueprint" jsonb,
	"issues" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"world" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generations_guest_created" ON "ai_generations" USING btree ("guest","created_at");--> statement-breakpoint
CREATE INDEX "ai_generations_status_lease" ON "ai_generations" USING btree ("status","lease_until");