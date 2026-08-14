import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issueEvents } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Exercises the flag-gated issue_events dual-write (backlog E, step 2b) end to end:
// with the flag on, canonical mutators append rows atomically; with it off, the
// projection stays inert. The parity oracle (E5) reads these rows, so getting the
// kind/actor/source mapping right here is what E5 will lean on.
describeEmbeddedPostgres("issue_events dual-write", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-dual-write-", {
    resetEach: resetCompanyIssueFixtures,
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

  async function eventsFor(issueId: string) {
    return ctx.db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issueId))
      .orderBy(issueEvents.id);
  }

  it("writes created + status_changed rows when the flag is on", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Dual write on");
    const svc = issueService(ctx.db);

    const issue = await svc.create(companyId, {
      title: "Event log target",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const afterCreate = await eventsFor(issue.id);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]).toMatchObject({
      companyId,
      issueId: issue.id,
      kind: "created",
      actorType: "user",
      actorId: userId,
      sourceTable: "issues",
      sourceId: issue.id,
    });

    await svc.update(issue.id, { status: "cancelled", actorUserId: userId });
    const afterUpdate = await eventsFor(issue.id);
    const kinds = afterUpdate.map((row) => row.kind);
    expect(kinds).toContain("status_changed");
    const statusEvent = afterUpdate.find((row) => row.kind === "status_changed");
    expect(statusEvent?.payload).toMatchObject({ from: "todo", to: "cancelled" });
  });

  it("writes nothing when the flag is off", async () => {
    delete process.env[FLAG];
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Dual write off");
    const svc = issueService(ctx.db);

    const issue = await svc.create(companyId, {
      title: "No events please",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);
    await svc.update(issue.id, { status: "cancelled", actorUserId: userId });

    expect(await eventsFor(issue.id)).toHaveLength(0);
  });
});
