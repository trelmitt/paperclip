import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Append-only per-issue event log (backlog item E).
 *
 * Ordering and the F/H replay cursor are the global `bigserial` id — there is
 * deliberately no per-issue `seq`, because an issue has many concurrent writers
 * and a `MAX(seq)+1` counter would race (see doc/plans/2026-08-14-issue-event-log-E-implementation.md, Q2).
 *
 * `payload` carries only denormalized parity scalars (assignee ids, timestamps,
 * flags). Bodies (comment/approval text) are never embedded — reach them via
 * `sourceTable`/`sourceId` so the log stays correct without chasing later edits (Q1).
 */
export const issueEvents = pgTable(
  "issue_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorRunId: uuid("actor_run_id"),
    sourceTable: text("source_table"),
    sourceId: text("source_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdIdx: index("issue_events_issue_id_id_idx").on(table.issueId, table.id),
    companyIdx: index("issue_events_company_id_id_idx").on(table.companyId, table.id),
    // Makes the historical backfill idempotent (re-runnable via ON CONFLICT DO NOTHING).
    // Partial so live lifecycle events with no 1:1 source row (sourceId null) are unconstrained.
    sourceUniq: uniqueIndex("issue_events_source_kind_uniq")
      .on(table.sourceTable, table.sourceId, table.kind)
      .where(sql`${table.sourceId} is not null`),
    // Byte-for-byte mirror of ISSUE_EVENT_KINDS in packages/shared/src/constants.ts
    // (Drizzle cannot read the shared const — keep both in lockstep).
    kindCheck: check(
      "issue_events_kind_check",
      sql`${table.kind} in (
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
      )`,
    ),
    actorTypeCheck: check(
      "issue_events_actor_type_check",
      sql`${table.actorType} in ('agent', 'user', 'system', 'plugin')`,
    ),
  }),
);
