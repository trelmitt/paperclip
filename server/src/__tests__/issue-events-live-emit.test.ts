import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issueEvents, type Db } from "@paperclipai/db";
import { LIVE_STREAM_ISSUE, type LiveEvent } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog H: the flag-gated dual-write also emits a live `issue.event` once the
// writing transaction has committed. This locks the three properties that the
// wiring (appendIssueEvent's post-commit thunk + the caller's flush) must hold:
//   1. flag on + owned pool handle -> exactly one issue.event on the company bus,
//      carrying the durable resume position (stream=issue, seq=the row id);
//   2. flag off -> no live frame (and no row);
//   3. a caller-supplied tx -> row written but NO live frame (the lean cut defers
//      external-tx emit to the F backfill; the `dbOrTx === db` guard enforces it).
describeEmbeddedPostgres("issue_events live emit", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-live-", {
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

  function captureIssueEvents(companyId: string) {
    const captured: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "issue.event") captured.push(event);
    });
    return { captured, unsubscribe };
  }

  async function commentedRowId(db: Db, issueId: string): Promise<number> {
    const rows = await db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issueId))
      .orderBy(issueEvents.id);
    const commented = rows.find((row) => row.kind === "commented");
    if (!commented) throw new Error("expected a commented row");
    return commented.id;
  }

  it("emits one issue.event carrying the durable cursor when a comment is added on the pool handle", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Live emit on");
    const svc = issueService(ctx.db);
    const issue = await svc.create(companyId, {
      title: "Feed target",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const { captured, unsubscribe } = captureIssueEvents(companyId);
    try {
      await svc.addComment(issue.id, "hello feed", { userId });
      expect(captured).toHaveLength(1);
      const rowId = await commentedRowId(ctx.db, issue.id);
      expect(captured[0]).toMatchObject({
        type: "issue.event",
        companyId,
        stream: LIVE_STREAM_ISSUE,
        seq: rowId,
      });
      // The feed payload carries the enriched frame (issue-events.ts thunk): the
      // durable id and the derived kind/actor — enough for a client to render.
      expect(captured[0].payload).toMatchObject({
        issueId: issue.id,
        eventId: rowId,
        kind: "commented",
        actorType: "user",
        actorId: userId,
      });
    } finally {
      unsubscribe();
    }
  });

  it("emits nothing when the flag is off", async () => {
    delete process.env[FLAG];
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Live emit off");
    const svc = issueService(ctx.db);
    const issue = await svc.create(companyId, {
      title: "No feed",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const { captured, unsubscribe } = captureIssueEvents(companyId);
    try {
      await svc.addComment(issue.id, "silent", { userId });
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("defers the live frame for a caller-supplied transaction (row written, nothing emitted)", async () => {
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Live emit tx-deferred");
    const svc = issueService(ctx.db);
    const issue = await svc.create(companyId, {
      title: "External tx",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const { captured, unsubscribe } = captureIssueEvents(companyId);
    try {
      // Pass the tx as addComment's dbOrTx: the guard sees dbOrTx !== db and skips
      // the flush, so the row commits with the tx but no phantom-risk live emit fires.
      const comment = await ctx.db.transaction((tx) =>
        svc.addComment(issue.id, "in a tx", { userId }, undefined, tx),
      );
      expect(captured).toHaveLength(0);
      // The row still lands (atomic with the tx) — only the live emit is deferred.
      const rowId = await commentedRowId(ctx.db, issue.id);
      expect(rowId).toBeGreaterThan(0);
      expect(comment.id).toBeTruthy();
    } finally {
      unsubscribe();
    }
  });

  it("emits no phantom when issueService is built FROM a tx that rolls back", async () => {
    // The confirmed regression: issueService(tx) makes the service's closure `db` the
    // tx itself, so an identity guard (dbOrTx === db) would flush INSIDE the open tx.
    // Here the tx rolls back after the comment write — the row must vanish AND no live
    // frame may have been broadcast.
    process.env[FLAG] = "true";
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Live emit tx-rollback");
    const svc = issueService(ctx.db);
    const issue = await svc.create(companyId, {
      title: "Rollback issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
    } as Parameters<typeof svc.create>[1]);

    const { captured, unsubscribe } = captureIssueEvents(companyId);
    try {
      await expect(
        ctx.db.transaction(async (tx) => {
          const txSvc = issueService(tx as unknown as Db);
          await txSvc.addComment(issue.id, "rolled back", { userId }, undefined, tx);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      // No phantom frame, and the comment row was rolled back with the tx.
      expect(captured).toHaveLength(0);
      const rows = await ctx.db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issue.id));
      expect(rows.some((row) => row.kind === "commented")).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});
