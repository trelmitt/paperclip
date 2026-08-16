import { afterEach, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issueEvents, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { visibleIssueCondition } from "../services/issue-visibility.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog J: fork/side-chat. A fork is a hidden scratch child (harness_kind =
// 'scratch_fork') seeded with the parent's event-log prefix up to an anchor.
// The dual-write flag must be on so the parent has `commented` events to mine
// and so the fork emits its own single `created` event.
describeEmbeddedPostgres("issue fork", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-fork-", {
    resetEach: resetCompanyIssueFixtures,
  });

  const FLAG = "PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE";
  let prevFlag: string | undefined;
  beforeEach(() => {
    prevFlag = process.env[FLAG];
    process.env[FLAG] = "true";
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  async function commentedEvents(issueId: string) {
    return ctx.db
      .select()
      .from(issueEvents)
      .where(and(eq(issueEvents.issueId, issueId), eq(issueEvents.kind, "commented")))
      .orderBy(issueEvents.id);
  }

  async function issueRow(id: string) {
    return ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0]!);
  }

  it("forks a hidden scratch child seeded up to the anchor event", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Fork anchor");
    const svc = issueService(ctx.db);

    const parent = await svc.create(companyId, {
      title: "Parent thread",
      description: "seed description",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    await svc.addComment(parent.id, "FIRST message before anchor", { userId });
    await svc.addComment(parent.id, "SECOND message after anchor", { userId });

    const events = await commentedEvents(parent.id);
    expect(events).toHaveLength(2);
    const anchorEventId = events[0].id; // cut at the first comment

    const { issue: fork } = await svc.forkIssue(parent.id, {
      anchorEventId,
      createdByUserId: userId,
    });

    const forkRow = await issueRow(fork.id);
    expect(forkRow).toMatchObject({
      parentId: parent.id,
      harnessKind: "scratch_fork",
      originKind: "issue_fork",
      originId: parent.id,
      status: "backlog",
    });
    const parentRow = await issueRow(parent.id);
    expect(forkRow.requestDepth).toBe(parentRow.requestDepth + 1);

    // Anchor cut: seed carries the parent description + the pre-anchor comment
    // only; the post-anchor comment must not leak in.
    expect(forkRow.description).toContain("seed description");
    expect(forkRow.description).toContain("FIRST message before anchor");
    expect(forkRow.description).not.toContain("SECOND message after anchor");

    // Exactly one `created` event on the child, none inherited from the parent.
    const forkCreated = await ctx.db
      .select()
      .from(issueEvents)
      .where(and(eq(issueEvents.issueId, fork.id), eq(issueEvents.kind, "created")));
    expect(forkCreated).toHaveLength(1);
  });

  it("excludes the fork from visible/rollup queries but keeps the parent", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Fork hidden");
    const svc = issueService(ctx.db);

    const parent = await svc.create(companyId, {
      title: "Visible parent",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const { issue: fork } = await svc.forkIssue(parent.id, { createdByUserId: userId });

    const visibleIds = (
      await ctx.db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), visibleIssueCondition()))
    ).map((r) => r.id);

    expect(visibleIds).toContain(parent.id);
    expect(visibleIds).not.toContain(fork.id);
  });

  it("defaults the title and seeds the full thread when no anchor is given", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Fork head");
    const svc = issueService(ctx.db);

    const parent = await svc.create(companyId, {
      title: "Head parent",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    await svc.addComment(parent.id, "alpha comment", { userId });
    await svc.addComment(parent.id, "omega comment", { userId });

    const { issue: fork } = await svc.forkIssue(parent.id, { createdByUserId: userId });

    const forkRow = await issueRow(fork.id);
    const parentRow = await issueRow(parent.id);
    expect(forkRow.title).toBe(`Fork of ${parentRow.identifier ?? parentRow.title}`);
    // No anchor → the whole thread seeds in.
    expect(forkRow.description).toContain("alpha comment");
    expect(forkRow.description).toContain("omega comment");
  });
});
