import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  approvals as approvalsTable,
  issueApprovals,
  issueComments,
  issueEvents,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { backfillIssueEvents } from "../services/issue-events-backfill.js";
import { deriveWorkTimelineEventsFromLog } from "../services/issue-events-timeline.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog E step 4: the historical backfill. Reconstructs the source-bearing
// event kinds (created, commented, approval_requested/resolved) from the canonical
// tables for rows that predate the dual-write, idempotently.
describeEmbeddedPostgres("issue_events historical backfill", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-backfill-", {
    resetEach: async (db) => {
      await db.delete(issueApprovals);
      await db.delete(approvalsTable);
      await db.delete(activityLog);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedIssue(companyId: string, title: string, createdByUserId?: string) {
    const id = randomUUID();
    await ctx.db
      .insert(issues)
      .values({ id, companyId, title, status: "todo", priority: "medium", createdByUserId: createdByUserId ?? null });
    return id;
  }

  async function eventsFor(issueId: string) {
    return ctx.db.select().from(issueEvents).where(eq(issueEvents.issueId, issueId)).orderBy(issueEvents.id);
  }

  it("backfills created, commented, and fanned-out approval events; re-run is a no-op", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Backfill");
    const issueA = await seedIssue(companyId, "Issue A", userId);
    const issueB = await seedIssue(companyId, "Issue B", userId);

    // A visible comment on A, plus a soft-deleted one that must be skipped.
    await ctx.db.insert(issueComments).values({
      companyId,
      issueId: issueA,
      authorUserId: userId,
      authorType: "user",
      body: "hello",
    });
    await ctx.db.insert(issueComments).values({
      companyId,
      issueId: issueA,
      authorUserId: userId,
      authorType: "user",
      body: "gone",
      deletedAt: new Date(),
    });

    // One approval, decided, linked to BOTH issues (fan-out). Link with the flag
    // OFF so the junction rows exist without any dual-write events — the backfill
    // is the only writer here.
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);
    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);
    await junction.link(issueA, approval.id, { userId });
    await junction.link(issueB, approval.id, { userId });
    await approvals.approve(approval.id, "decider-user");

    // An assign activity on A, plus an orphan assign row (entityId points at no
    // issue) that the backfill's issues join must skip instead of FK-violating.
    await ctx.db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.assigned",
      entityType: "issue",
      entityId: issueA,
    });
    await ctx.db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.assigned",
      entityType: "issue",
      entityId: randomUUID(), // no such issue
    });

    // A resolved thread interaction on A — the backfill must emit BOTH a
    // `thread_interaction` created event (creator @createdAt) and a resolved one
    // (resolver @resolvedAt), which the reader collapses to one `approved`.
    const interactionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const interactionResolvedAt = new Date("2026-01-02T00:00:00.000Z");
    const [interaction] = await ctx.db
      .insert(issueThreadInteractions)
      .values({
        companyId,
        issueId: issueA,
        kind: "request_confirmation",
        status: "accepted",
        payload: { version: 1, prompt: "Proceed?" },
        createdByUserId: userId,
        resolvedByUserId: "interaction-resolver",
        createdAt: interactionCreatedAt,
        resolvedAt: interactionResolvedAt,
      })
      .returning({ id: issueThreadInteractions.id });

    const first = await backfillIssueEvents(ctx.db, { batchSize: 1 });
    expect(first.created).toBeGreaterThanOrEqual(2);
    expect(first.commented).toBeGreaterThanOrEqual(1);
    expect(first.approvalRequested).toBe(2);
    expect(first.approvalResolved).toBe(2);
    expect(first.assigned).toBe(1); // orphan row skipped by the issues join
    expect(first.interactionCreated).toBe(1);
    expect(first.interactionResolved).toBe(1);

    const aKinds = (await eventsFor(issueA)).map((r) => r.kind).sort();
    expect(aKinds).toEqual([
      "approval_requested",
      "approval_resolved",
      "assignee_changed",
      "commented",
      "created",
      "thread_interaction",
      "thread_interaction",
    ]);
    // The pair is keyed on the interaction id with :created / :resolved suffixes.
    const interactionEvents = (await eventsFor(issueA))
      .filter((r) => r.kind === "thread_interaction")
      .map((r) => ({ sourceId: r.sourceId, actorId: r.actorId }));
    expect(interactionEvents).toEqual(
      expect.arrayContaining([
        { sourceId: `${interaction!.id}:created`, actorId: userId },
        { sourceId: `${interaction!.id}:resolved`, actorId: "interaction-resolver" },
      ]),
    );

    // Reader collapse: the created/resolved pair yields ONE `approved`, resolved
    // wins (resolver actor, at resolvedAt).
    const derived = await deriveWorkTimelineEventsFromLog(ctx.db, {
      issueIds: [issueA],
      from: new Date("2020-01-01T00:00:00.000Z"),
      to: new Date("2030-01-01T00:00:00.000Z"),
    });
    const interactionApproved = derived.filter(
      (e) => e.kind === "approved" && e.actorId === "user:interaction-resolver",
    );
    expect(interactionApproved).toHaveLength(1);
    expect(interactionApproved[0]!.at).toBe(interactionResolvedAt.toISOString());
    const aAssign = (await eventsFor(issueA)).find((r) => r.kind === "assignee_changed");
    expect(aAssign).toMatchObject({ sourceTable: "activity_log", actorType: "user", actorId: userId });

    // The soft-deleted comment is excluded — exactly one commented event on A.
    expect((await eventsFor(issueA)).filter((r) => r.kind === "commented")).toHaveLength(1);

    // Fan-out: B gets its own approval pair, keyed on its own (issue, approval) link.
    const bApproval = (await eventsFor(issueB)).find((r) => r.kind === "approval_resolved");
    expect(bApproval).toMatchObject({
      actorType: "user",
      actorId: "decider-user",
      sourceId: `${issueB}:${approval.id}`,
    });

    // Idempotent + resumable: a second full run writes nothing new.
    const second = await backfillIssueEvents(ctx.db, { batchSize: 1 });
    expect(second).toMatchObject({
      created: 0,
      commented: 0,
      approvalRequested: 0,
      approvalResolved: 0,
      assigned: 0,
      interactionCreated: 0,
      interactionResolved: 0,
    });
  });
});
