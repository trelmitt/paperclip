CREATE TABLE "issue_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_run_id" uuid,
	"source_table" text,
	"source_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_events_kind_check" CHECK ("issue_events"."kind" in (
        'created',
        'status_changed',
        'assignee_changed',
        'blocker_added',
        'blocker_cleared',
        'commented',
        'comment_removed',
        'approval_requested',
        'approval_resolved',
        'thread_interaction',
        'run_started',
        'run_finished'
      )),
	CONSTRAINT "issue_events_actor_type_check" CHECK ("issue_events"."actor_type" in ('agent', 'user', 'system', 'plugin'))
);
--> statement-breakpoint
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_events_issue_id_id_idx" ON "issue_events" USING btree ("issue_id","id");--> statement-breakpoint
CREATE INDEX "issue_events_company_id_id_idx" ON "issue_events" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_events_source_kind_uniq" ON "issue_events" USING btree ("source_table","source_id","kind") WHERE "issue_events"."source_id" is not null;