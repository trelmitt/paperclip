import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals as approvalsTable, issueApprovals, issueEvents, issues } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog E step 3a: the `approved` parity source. work-timeline derives one
// `approved` event per issue+approval link (approvals + interactions); this covers
// the approvals half — approval_requested at link, approval_resolved at decision,
// fanned out over the issue_approvals junction.
describeEmbeddedPostgres("issue_events approvals dual-write", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-approvals-", {
    // resetCompanyIssueFixtures does not clear approvals, which FK-reference the
    // company (no cascade) — drop them (and the junction) first so the company
    // delete succeeds.
    resetEach: async (db) => {
      await db.delete(issueApprovals);
      await db.delete(approvalsTable);
      await resetCompanyIssueFixtures(db);
    },
  });

  const FLAG = "PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE";
  let prevFlag: string | undefined;
  beforeEach(() => {
    prevFlag = process.env[FLAG];
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  async function seedIssue(companyId: string, title: string) {
    const id = randomUUID();
    await ctx.db.insert(issues).values({ id, companyId, title, status: "todo", priority: "medium" });
    return id;
  }

  async function eventsFor(issueId: string) {
    return ctx.db.select().from(issueEvents).where(eq(issueEvents.issueId, issueId)).orderBy(issueEvents.id);
  }

  it("emits approval_requested at link and approval_resolved at decision, fanned out per issue", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Approvals on");
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);

    const issueA = await seedIssue(companyId, "Issue A");
    const issueB = await seedIssue(companyId, "Issue B");

    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);

    // One approval linked to two issues -> two approval_requested events.
    await junction.link(issueA, approval.id, { userId });
    await junction.link(issueB, approval.id, { userId });

    for (const issueId of [issueA, issueB]) {
      const requested = (await eventsFor(issueId)).find((r) => r.kind === "approval_requested");
      expect(requested).toMatchObject({
        kind: "approval_requested",
        actorType: "user",
        actorId: userId, // requester, since not yet decided
        sourceTable: "issue_approvals",
        sourceId: `${issueId}:${approval.id}`,
      });
    }

    // A single decision fans out one approval_resolved per linked issue.
    const decider = "decider-user";
    const { applied } = await approvals.approve(approval.id, decider);
    expect(applied).toBe(true);

    for (const issueId of [issueA, issueB]) {
      const resolved = (await eventsFor(issueId)).find((r) => r.kind === "approval_resolved");
      expect(resolved).toMatchObject({
        kind: "approval_resolved",
        actorType: "user",
        actorId: decider, // decider wins once decided
        sourceTable: "issue_approvals",
        sourceId: `${issueId}:${approval.id}`,
      });
      expect(resolved?.payload).toMatchObject({ status: "approved" });
    }
  });

  it("linking to an already-resolved approval emits both request and resolve", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Approvals late-link");
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);
    const issueId = await seedIssue(companyId, "Late-linked issue");
    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);

    // Decide the approval BEFORE any issue is linked — the resolve-time fan-out
    // finds no junction rows, so the link itself must backfill approval_resolved.
    await approvals.approve(approval.id, "decider-user");
    await junction.link(issueId, approval.id, { userId });

    const events = await eventsFor(issueId);
    expect(events.find((r) => r.kind === "approval_requested")).toMatchObject({
      actorType: "user",
      actorId: userId,
    });
    expect(events.find((r) => r.kind === "approval_resolved")).toMatchObject({
      actorType: "user",
      actorId: "decider-user",
      payload: { status: "approved" },
    });
  });

  it("re-linking the same issue+approval does not throw or duplicate the event", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Approvals relink");
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);
    const issueId = await seedIssue(companyId, "Relink issue");
    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);

    await junction.link(issueId, approval.id, { userId });
    await junction.link(issueId, approval.id, { userId }); // idempotent — onConflictDoNothing

    const requested = (await eventsFor(issueId)).filter((r) => r.kind === "approval_requested");
    expect(requested).toHaveLength(1);
  });

  it("writes nothing when the flag is off", async () => {
    delete process.env[FLAG];
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Approvals off");
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);
    const issueId = await seedIssue(companyId, "Silent issue");
    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);

    await junction.link(issueId, approval.id, { userId });
    await approvals.approve(approval.id, "decider-user");

    expect(await eventsFor(issueId)).toHaveLength(0);
  });
});
