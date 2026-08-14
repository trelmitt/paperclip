import { and, asc, eq, gt, isNull, like, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, issueApprovals, issueComments, issues } from "@paperclipai/db";
import {
  appendIssueEvent,
  resolveApprovalEventActor,
  resolveIssueEventActor,
} from "./issue-events.js";

/**
 * Backlog E step 4: one-time historical backfill of the append-only issue_events
 * log from the canonical source tables, so the log covers issues that predate the
 * dual-write (E2/E3).
 *
 * Idempotent AND resumable by construction: every row written here is
 * source-bearing (source_table + source_id), so issue_events' partial unique index
 * `(source_table, source_id, kind)` plus appendIssueEvent's onConflictDoNothing
 * swallows anything a prior run — or the live dual-write — already wrote. A killed
 * run is "resumed" simply by running it again; re-scanned rows that already exist
 * no-op. (ponytail: no persisted cursor — re-scan + skip-existing is fine at
 * control-plane scale; add a keyset checkpoint table only if a company's row count
 * ever makes the full re-scan itself the bottleneck.)
 *
 * Scope mirrors the live dual-write's source-bearing kinds. The issue-row-diff
 * lifecycle events (status_changed / assignee_changed with a null source) are
 * deliberately NOT backfilled: they are unconstrained (would double on re-run) and
 * their transition history is unrecoverable from the current issue row. The
 * ACTIVITY-LOG-sourced `assignee_changed` (source_table="activity_log") IS
 * backfilled — it is the `assigned` parity signal and is source-bearing/idempotent.
 * Thread-interaction (`approved`) backfill is deferred with E3b.
 */
export type IssueEventsBackfillResult = {
  scannedIssues: number;
  scannedComments: number;
  scannedApprovalLinks: number;
  scannedAssignLogs: number;
  created: number;
  commented: number;
  approvalRequested: number;
  approvalResolved: number;
  assigned: number;
};

const DEFAULT_BATCH_SIZE = 500;

export async function backfillIssueEvents(
  db: Db,
  opts: { batchSize?: number; log?: (message: string) => void } = {},
): Promise<IssueEventsBackfillResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const log = opts.log ?? (() => {});
  const result: IssueEventsBackfillResult = {
    scannedIssues: 0,
    scannedComments: 0,
    scannedApprovalLinks: 0,
    scannedAssignLogs: 0,
    created: 0,
    commented: 0,
    approvalRequested: 0,
    approvalResolved: 0,
    assigned: 0,
  };

  // 1) created — one per issue. Not part of work-timeline parity (its events array
  // has no `created`), but backfilled so the log is a complete history.
  let issueCursor: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        parentId: issues.parentId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(issueCursor === null ? undefined : gt(issues.id, issueCursor))
      .orderBy(asc(issues.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const actor = resolveIssueEventActor(row.createdByAgentId, row.createdByUserId);
      const { id } = await appendIssueEvent(db, {
        companyId: row.companyId,
        issueId: row.id,
        kind: "created",
        actorType: actor.actorType,
        actorId: actor.actorId,
        sourceTable: "issues",
        sourceId: row.id,
        payload: {
          status: row.status,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          parentId: row.parentId,
        },
        at: row.createdAt ?? undefined,
      });
      if (id !== null) result.created += 1;
    }
    result.scannedIssues += rows.length;
    issueCursor = rows[rows.length - 1]!.id;
    log(`created: scanned ${result.scannedIssues} issues, wrote ${result.created}`);
    if (rows.length < batchSize) break;
  }

  // 2) commented — matches work-timeline's filter (deletedAt IS NULL), same actor
  // precedence and `at` = comment.createdAt.
  let commentCursor: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: issueComments.id,
        companyId: issueComments.companyId,
        issueId: issueComments.issueId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
        createdByRunId: issueComments.createdByRunId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(
        commentCursor === null
          ? isNull(issueComments.deletedAt)
          : and(isNull(issueComments.deletedAt), gt(issueComments.id, commentCursor)),
      )
      .orderBy(asc(issueComments.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const actor = resolveIssueEventActor(row.authorAgentId, row.authorUserId);
      const { id } = await appendIssueEvent(db, {
        companyId: row.companyId,
        issueId: row.issueId,
        kind: "commented",
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorRunId: row.createdByRunId ?? null,
        sourceTable: "issue_comments",
        sourceId: row.id,
        payload: {
          authorAgentId: row.authorAgentId,
          authorUserId: row.authorUserId,
          authorType: row.authorType,
        },
        at: row.createdAt ?? undefined,
      });
      if (id !== null) result.commented += 1;
    }
    result.scannedComments += rows.length;
    commentCursor = rows[rows.length - 1]!.id;
    log(`commented: scanned ${result.scannedComments} comments, wrote ${result.commented}`);
    if (rows.length < batchSize) break;
  }

  // 3) approvals — fan out over the issue_approvals junction, mirroring
  // work-timeline: approval_requested at createdAt (always), approval_resolved at
  // decidedAt (only when decided). Keyed on the (issueId, approvalId) link so one
  // approval linked to N issues does not collide on the unique index.
  // ponytail: single unbatched scan (unlike the created/commented keyset loops) —
  //   the issue_approvals junction is small (approvals are rare vs issues/comments)
  //   and it has a composite PK, so keyset paging isn't worth it. Add batching here
  //   only if a deployment ever accumulates enough approval links to matter.
  const links = await db
    .select({
      issueId: issueApprovals.issueId,
      companyId: issueApprovals.companyId,
      approvalId: approvals.id,
      type: approvals.type,
      status: approvals.status,
      requestedByAgentId: approvals.requestedByAgentId,
      requestedByUserId: approvals.requestedByUserId,
      decidedByUserId: approvals.decidedByUserId,
      decisionNote: approvals.decisionNote,
      decidedAt: approvals.decidedAt,
      createdAt: approvals.createdAt,
    })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id));
  result.scannedApprovalLinks = links.length;
  for (const link of links) {
    const sourceId = `${link.issueId}:${link.approvalId}`;
    const requestedActor = resolveIssueEventActor(link.requestedByAgentId, link.requestedByUserId);
    const requested = await appendIssueEvent(db, {
      companyId: link.companyId,
      issueId: link.issueId,
      kind: "approval_requested",
      actorType: requestedActor.actorType,
      actorId: requestedActor.actorId,
      sourceTable: "issue_approvals",
      sourceId,
      payload: { approvalId: link.approvalId, approvalType: link.type, status: link.status },
      at: link.createdAt ?? undefined,
    });
    if (requested.id !== null) result.approvalRequested += 1;
    if (link.decidedAt) {
      const resolvedActor = resolveApprovalEventActor(link);
      const resolved = await appendIssueEvent(db, {
        companyId: link.companyId,
        issueId: link.issueId,
        kind: "approval_resolved",
        actorType: resolvedActor.actorType,
        actorId: resolvedActor.actorId,
        sourceTable: "issue_approvals",
        sourceId,
        payload: { approvalId: link.approvalId, status: link.status, decisionNote: link.decisionNote ?? null },
        at: link.decidedAt ?? undefined,
      });
      if (resolved.id !== null) result.approvalResolved += 1;
    }
  }
  log(`approvals: scanned ${result.scannedApprovalLinks} links, wrote ${result.approvalRequested} requested / ${result.approvalResolved} resolved`);

  // 4) assigned — the activity-log-sourced `assignee_changed` events. Mirror
  // work-timeline's exact filter: issue activities whose action contains "assign".
  // Inner-join issues (casting the uuid side to text — always safe) so an assign
  // row for a since-deleted issue is skipped instead of FK-violating; work-timeline
  // likewise never surfaces those. Keyed on the activity row id -> idempotent.
  let assignCursor: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: activityLog.id,
        companyId: activityLog.companyId,
        entityId: activityLog.entityId,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        runId: activityLog.runId,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .innerJoin(issues, sql`${issues.id}::text = ${activityLog.entityId}`)
      .where(
        assignCursor === null
          ? and(eq(activityLog.entityType, "issue"), like(activityLog.action, "%assign%"))
          : and(
              eq(activityLog.entityType, "issue"),
              like(activityLog.action, "%assign%"),
              gt(activityLog.id, assignCursor),
            ),
      )
      .orderBy(asc(activityLog.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const actorType = row.actorType === "agent" || row.actorType === "user" || row.actorType === "plugin"
        ? row.actorType
        : "system";
      const { id } = await appendIssueEvent(db, {
        companyId: row.companyId,
        issueId: row.entityId,
        kind: "assignee_changed",
        actorType,
        actorId: row.actorId,
        actorRunId: row.runId ?? null,
        sourceTable: "activity_log",
        sourceId: row.id,
        payload: { action: row.action },
        at: row.createdAt ?? undefined,
      });
      if (id !== null) result.assigned += 1;
    }
    result.scannedAssignLogs += rows.length;
    assignCursor = rows[rows.length - 1]!.id;
    log(`assigned: scanned ${result.scannedAssignLogs} assign logs, wrote ${result.assigned}`);
    if (rows.length < batchSize) break;
  }

  return result;
}
