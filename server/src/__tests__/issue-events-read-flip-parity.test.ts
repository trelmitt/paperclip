import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, approvals as approvalsTable, issueApprovals, issues as issuesTable } from "@paperclipai/db";
import type { WorkTimelineEvent, WorkTimelineActor, WorkTimelineEdge } from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { workTimelineService } from "../services/work-timeline.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog E6: the read-flip. work-timeline.getTimeline reads its four log-derived event
// kinds from the 6-table derivation (flag off) or from issue_events (flag on). Per the E6
// review the contract is LOG-AUTHORITATIVE, not byte-identical everywhere (see
// issue-events-timeline.ts KNOWN DIVERGENCES): this asserts identity on the COMMON case —
// create + delegate + comment + approval + interaction + assign, plus GENUINE deletions
// (comment delete, approval unlink) which the retraction events match. It deliberately
// does NOT exercise the documented divergence cases (createdAt backdating, parked
// revision-requests, unlink->relink, agent-scrub), where the log is the more-faithful
// record and identity is not claimed. Also covers `delegated` (structural, kept out of
// the log by design) surviving the flip.
describeEmbeddedPostgres("issue_events read-flip parity (E6)", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-read-flip-", {
    resetEach: async (db) => {
      await db.delete(issueApprovals);
      await db.delete(approvalsTable);
      await db.delete(activityLog);
      // issue_thread_interactions cascades from issues -> no explicit delete.
      await resetCompanyIssueFixtures(db);
    },
  });

  const DUAL_WRITE = "PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE";
  const READ_FROM_LOG = "PAPERCLIP_ISSUE_EVENTS_READ_FROM_LOG";
  let prevDualWrite: string | undefined;
  let prevReadFromLog: string | undefined;
  beforeEach(() => {
    prevDualWrite = process.env[DUAL_WRITE];
    prevReadFromLog = process.env[READ_FROM_LOG];
    // Dual-write on for the whole fixture so the log is populated live; the read flag
    // is toggled per getTimeline call inside the test.
    process.env[DUAL_WRITE] = "true";
    delete process.env[READ_FROM_LOG];
  });
  afterEach(() => {
    if (prevDualWrite === undefined) delete process.env[DUAL_WRITE];
    else process.env[DUAL_WRITE] = prevDualWrite;
    if (prevReadFromLog === undefined) delete process.env[READ_FROM_LOG];
    else process.env[READ_FROM_LOG] = prevReadFromLog;
  });

  const eventKey = (e: WorkTimelineEvent) => `${e.at}|${e.kind}|${e.issueId}|${e.actorId}`;
  const edgeKey = (e: WorkTimelineEdge) => `${e.at}|${e.kind}|${e.issueId}|${e.fromActorId}|${e.toActorId}`;
  const actorKey = (a: WorkTimelineActor) => `${a.id}|${a.type}|${a.name}|${a.avatar ?? ""}`;
  const sortBy = <T,>(items: T[], key: (item: T) => string) => items.map(key).sort();

  it("getTimeline is identical with reads from the 6 tables vs from the log", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "ReadFlip");
    const issues = issueService(ctx.db);
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);
    const interactions = issueThreadInteractionService(ctx.db);

    // Parent + child where the child's assignee differs from the parent's actor ->
    // a `delegated` event (structural, never in the log) alongside the four
    // log-derived kinds. The assignee is set with a raw update (work-timeline reads
    // the issue row directly, identically under both flags) so the fixture skips the
    // service's assertAssignableUser check for a throwaway assignee id.
    const parent = await issues.create(companyId, {
      title: "Parent",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    });
    const child = await issues.create(companyId, {
      title: "Child",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      parentId: parent.id,
    });
    await ctx.db.update(issuesTable).set({ assigneeUserId: "delegate-user" }).where(eq(issuesTable.id, child.id));

    await issues.addComment(parent.id, "a comment", { userId });
    // A second comment, then delete it. work-timeline drops a deleted comment
    // (isNull(deletedAt)); the log keeps its `commented` and adds `comment_removed`.
    // The read-flip must suppress it so both flags land on ONE surviving `commented`.
    const doomedComment = await issues.addComment(parent.id, "delete me", { userId });
    await issues.tombstoneComment(doomedComment.id, { actorType: "user", userId });

    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);
    await junction.link(parent.id, approval.id, { userId });
    await junction.link(child.id, approval.id, { userId });
    await approvals.approve(approval.id, "decider-user");
    // Unlink the approval from the child. work-timeline drops the child's `approved`
    // (its inner-join on issue_approvals is gone); the log keeps approval_* and adds
    // `approval_unlinked`. The parent keeps its `approved` — the read-flip must suppress
    // only the child's.
    await junction.unlink(child.id, approval.id);

    await interactions.create(
      { id: parent.id, companyId },
      { kind: "request_confirmation", payload: { version: 1, prompt: "Proceed?" } },
      { userId },
    );

    await logActivity(ctx.db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.assigned",
      entityType: "issue",
      entityId: child.id,
      details: { assigneeUserId: "delegate-user" },
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const query = { companyId, from, to, canReadIssue: async () => true };

    process.env[READ_FROM_LOG] = "false";
    const baseline = await workTimelineService(ctx.db).getTimeline(query);
    process.env[READ_FROM_LOG] = "true";
    const candidate = await workTimelineService(ctx.db).getTimeline(query);

    // The fixture exercised every kind the reader is responsible for, plus the
    // structural `delegated` that must survive the flip.
    expect(new Set(baseline.events.map((e) => e.kind))).toEqual(
      new Set(["created", "delegated", "commented", "approved", "assigned"]),
    );
    // Proof the retraction paths are genuinely exercised (not a silent no-op): the
    // baseline (work-timeline, the trusted derivation) already dropped the deleted
    // comment, leaving exactly one `commented`. If the read-flip failed to suppress it,
    // candidate would carry two and the equality below would fail.
    expect(baseline.events.filter((e) => e.kind === "commented")).toHaveLength(1);

    expect(sortBy(candidate.events, eventKey)).toEqual(sortBy(baseline.events, eventKey));
    expect(sortBy(candidate.edges, edgeKey)).toEqual(sortBy(baseline.edges, edgeKey));
    expect(sortBy(candidate.actors, actorKey)).toEqual(sortBy(baseline.actors, actorKey));
    expect(candidate.pagination).toEqual(baseline.pagination);
  });
});
