CREATE TABLE "spatial_buckets" (
	"world" uuid NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"z" integer NOT NULL,
	CONSTRAINT "spatial_buckets_world_x_y_z_pk" PRIMARY KEY("world","x","y","z")
);
--> statement-breakpoint
CREATE TABLE "connector_slot_claims" (
	"world" uuid NOT NULL,
	"part" uuid NOT NULL,
	"slot" text NOT NULL,
	"connection" uuid NOT NULL,
	CONSTRAINT "connector_slot_claims_world_part_slot_pk" PRIMARY KEY("world","part","slot")
);
--> statement-breakpoint
CREATE TABLE "part_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world" uuid NOT NULL,
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"ca" text NOT NULL,
	"cb" text NOT NULL,
	"revision" integer NOT NULL,
	"deleted" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_world_history" (
	"world" uuid NOT NULL,
	"guest" uuid NOT NULL,
	"generation" integer NOT NULL,
	"undo" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redo" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "guest_world_history_world_guest_pk" PRIMARY KEY("world","guest")
);
--> statement-breakpoint
CREATE TABLE "world_memberships" (
	"world" uuid NOT NULL,
	"guest" uuid NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "world_memberships_world_guest_pk" PRIMARY KEY("world","guest")
);
--> statement-breakpoint
CREATE TABLE "build_operations" (
	"world" uuid NOT NULL,
	"guest" uuid NOT NULL,
	"id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"digest" text NOT NULL,
	"receipt" jsonb,
	"before" jsonb,
	"after" jsonb,
	"before_connections" jsonb,
	"after_connections" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_operations_world_guest_id_pk" PRIMARY KEY("world","guest","id")
);
--> statement-breakpoint
CREATE TABLE "part_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world" uuid NOT NULL,
	"key" text NOT NULL,
	"color" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"z" integer NOT NULL,
	"rotation" integer NOT NULL,
	"revision" integer NOT NULL,
	"deleted" integer DEFAULT 0 NOT NULL,
	"minx" integer NOT NULL,
	"miny" integer NOT NULL,
	"minz" integer NOT NULL,
	"maxx" integer NOT NULL,
	"maxy" integer NOT NULL,
	"maxz" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guest" uuid NOT NULL,
	"hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expiry" timestamp with time zone NOT NULL,
	"revoked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guest_sessions_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "viewer_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world" uuid NOT NULL,
	"guest" uuid NOT NULL,
	"session" uuid NOT NULL,
	"generation" integer NOT NULL,
	"selection" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview" jsonb,
	"sequence" integer DEFAULT 0 NOT NULL,
	"preview_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"owner" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"catalogue" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worlds_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "spatial_buckets" ADD CONSTRAINT "spatial_buckets_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_slot_claims" ADD CONSTRAINT "connector_slot_claims_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_slot_claims" ADD CONSTRAINT "connector_slot_claims_part_part_instances_id_fk" FOREIGN KEY ("part") REFERENCES "public"."part_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_slot_claims" ADD CONSTRAINT "connector_slot_claims_connection_part_connections_id_fk" FOREIGN KEY ("connection") REFERENCES "public"."part_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_connections" ADD CONSTRAINT "part_connections_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_connections" ADD CONSTRAINT "part_connections_a_part_instances_id_fk" FOREIGN KEY ("a") REFERENCES "public"."part_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_connections" ADD CONSTRAINT "part_connections_b_part_instances_id_fk" FOREIGN KEY ("b") REFERENCES "public"."part_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_world_history" ADD CONSTRAINT "guest_world_history_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_world_history" ADD CONSTRAINT "guest_world_history_guest_guests_id_fk" FOREIGN KEY ("guest") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_memberships" ADD CONSTRAINT "world_memberships_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_memberships" ADD CONSTRAINT "world_memberships_guest_guests_id_fk" FOREIGN KEY ("guest") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_operations" ADD CONSTRAINT "build_operations_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_operations" ADD CONSTRAINT "build_operations_guest_guests_id_fk" FOREIGN KEY ("guest") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_instances" ADD CONSTRAINT "part_instances_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_guest_guests_id_fk" FOREIGN KEY ("guest") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer_sessions" ADD CONSTRAINT "viewer_sessions_world_worlds_id_fk" FOREIGN KEY ("world") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer_sessions" ADD CONSTRAINT "viewer_sessions_guest_guests_id_fk" FOREIGN KEY ("guest") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer_sessions" ADD CONSTRAINT "viewer_sessions_session_guest_sessions_id_fk" FOREIGN KEY ("session") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_pair" ON "part_connections" USING btree ("world","a","b","ca","cb");--> statement-breakpoint
CREATE INDEX "connections_a" ON "part_connections" USING btree ("world","a");--> statement-breakpoint
CREATE INDEX "connections_b" ON "part_connections" USING btree ("world","b");--> statement-breakpoint
CREATE INDEX "parts_world_bounds" ON "part_instances" USING btree ("world","minx","maxx") WHERE "part_instances"."deleted"=0;--> statement-breakpoint
CREATE INDEX "viewers_expiry" ON "viewer_sessions" USING btree ("world","expires_at");