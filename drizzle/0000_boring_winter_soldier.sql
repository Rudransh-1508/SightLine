CREATE TYPE "public"."category" AS ENUM('client', 'government', 'regulator', 'competitor', 'supplier', 'customer', 'financier', 'union', 'ngo', 'individual');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."dataset_kind" AS ENUM('illustrative', 'sourced');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('mutual', 'source-depends', 'target-depends');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('node_create', 'edge_create', 'edge_update');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'auto_rejected');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('Iberia', 'North Africa', 'Latin America', 'Europe', 'North America');--> statement-breakpoint
CREATE TYPE "public"."rel_state" AS ENUM('hostile', 'strained', 'transactional', 'stable', 'cooperative');--> statement-breakpoint
CREATE TYPE "public"."rel_type" AS ENUM('contractual', 'regulatory', 'equity', 'financing', 'adversarial', 'political', 'advocacy', 'labour');--> statement-breakpoint
CREATE TYPE "public"."trajectory" AS ENUM('deteriorating', 'stable', 'improving');--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" integer NOT NULL,
	"feature" text NOT NULL,
	"ref_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "dataset_kind" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasets_id_kind_key" UNIQUE("id","kind")
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"type" "rel_type" NOT NULL,
	"direction" "direction" NOT NULL,
	"strength" integer NOT NULL,
	"state" "rel_state" NOT NULL,
	"trajectory" "trajectory" NOT NULL,
	"exposure" text NOT NULL,
	"since" integer NOT NULL,
	"last_event_date" text NOT NULL,
	"last_event_summary" text NOT NULL,
	"narrative" text NOT NULL,
	"confidence" "confidence" NOT NULL,
	CONSTRAINT "edges_strength_range" CHECK ("edges"."strength" between 0 and 100),
	CONSTRAINT "edges_no_self_loop" CHECK ("edges"."source_id" <> "edges"."target_id")
);
--> statement-breakpoint
CREATE TABLE "node_metrics" (
	"dataset_id" text NOT NULL,
	"node_id" text NOT NULL,
	"betweenness" double precision,
	"degree" integer,
	"eigenvector" double precision,
	"community_id" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_metrics_dataset_id_node_id_pk" PRIMARY KEY("dataset_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"name" text NOT NULL,
	"category" "category" NOT NULL,
	"country" text NOT NULL,
	"region" "region" NOT NULL,
	"influence" integer NOT NULL,
	"role" text NOT NULL,
	"description" text NOT NULL,
	"key_people" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "nodes_dataset_id_id_pk" PRIMARY KEY("dataset_id","id"),
	CONSTRAINT "nodes_influence_range" CHECK ("nodes"."influence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"dataset_kind" "dataset_kind" DEFAULT 'sourced' NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"target_ref" text,
	"payload" jsonb NOT NULL,
	"evidence_quote" text,
	"source_id" text,
	"confidence" double precision,
	"model" text,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewer_note" text,
	CONSTRAINT "proposals_sourced_only" CHECK ("proposals"."dataset_kind" = 'sourced')
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"proposal_id" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"publisher" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"workos_user_id" text NOT NULL,
	"email" text NOT NULL,
	"credit_balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_fk" FOREIGN KEY ("dataset_id","source_id") REFERENCES "public"."nodes"("dataset_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_fk" FOREIGN KEY ("dataset_id","target_id") REFERENCES "public"."nodes"("dataset_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_metrics" ADD CONSTRAINT "node_metrics_node_fk" FOREIGN KEY ("dataset_id","node_id") REFERENCES "public"."nodes"("dataset_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_dataset_fk" FOREIGN KEY ("dataset_id","dataset_kind") REFERENCES "public"."datasets"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_slug_key" ON "datasets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "edges_dataset_idx" ON "edges" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "edges_source_idx" ON "edges" USING btree ("dataset_id","source_id");--> statement-breakpoint
CREATE INDEX "edges_target_idx" ON "edges" USING btree ("dataset_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edges_unique_rel" ON "edges" USING btree ("dataset_id","source_id","target_id","type");--> statement-breakpoint
CREATE INDEX "nodes_dataset_idx" ON "nodes" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "revisions_entity_idx" ON "revisions" USING btree ("entity_type","entity_id","applied_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_content_hash_key" ON "sources" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_workos_id_key" ON "users" USING btree ("workos_user_id");