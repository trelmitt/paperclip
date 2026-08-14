import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals as approvalsTable, issueApprovals, issueComments, issueEvents, issues } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { backfillIssueEvents } from "../services/issue-events-backfill.js";
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

    const first = await backfillIssueEvents(ctx.db, { batchSize: 1 });
    expect(first.created).toBeGreaterThanOrEqual(2);
    expect(first.commented).toBeGreaterThanOrEqual(1);
    expect(first.approvalRequested).toBe(2);
    expect(first.approvalResolved).toBe(2);

    const aKinds = (await eventsFor(issueA)).map((r) => r.kind).sort();
    expect(aKinds).toEqual(["approval_requested", "approval_resolved", "commented", "created"]);

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
    expect(second).toMatchObject({ created: 0, commented: 0, approvalRequested: 0, approvalResolved: 0 });
  });
});
