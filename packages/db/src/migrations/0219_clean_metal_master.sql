ALTER TABLE "issue_events" DROP CONSTRAINT "issue_events_kind_check";--> statement-breakpoint
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_kind_check" CHECK ("issue_events"."kind" in (
        'created',
        'status_changed',
        'assignee_changed',
        'blocker_added',
        'blocker_cleared',
        'commented',
        'comment_removed',
        'approval_requested',
        'approval_resolved',
        'approval_unlinked',
        'thread_interaction',
        'run_started',
        'run_finished'
      ));