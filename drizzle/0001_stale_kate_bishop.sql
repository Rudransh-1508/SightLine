CREATE TABLE "entity_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"node_id" text NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_node_fk" FOREIGN KEY ("dataset_id","node_id") REFERENCES "public"."nodes"("dataset_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_unique" ON "entity_aliases" USING btree ("dataset_id","alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_dataset_idx" ON "entity_aliases" USING btree ("dataset_id");