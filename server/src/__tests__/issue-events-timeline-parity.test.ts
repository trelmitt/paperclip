import { afterEach, beforeEach, expect, it } from "vitest";
import { approvals as approvalsTable, issueApprovals } from "@paperclipai/db";
import type { WorkTimelineEvent } from "@paperclipai/shared";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { issueService } from "../services/issues.js";
import { deriveWorkTimelineEventsFromLog } from "../services/issue-events-timeline.js";
import { workTimelineService } from "../services/work-timeline.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Backlog E step 5: the derived reader (issue-events-timeline.ts) must reproduce
// work-timeline's `events` array from the issue_events log. This drives the LIVE
// dual-write path (flag on), then compares the reader against work-timeline over
// the same data — the parity gate E6's read-flip depends on.
describeEmbeddedPostgres("issue_events -> work-timeline parity", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-events-parity-", {
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
    process.env[FLAG] = "true";
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  const key = (e: WorkTimelineEvent) => `${e.at}|${e.kind}|${e.issueId}|${e.actorId}`;
  const norm = (events: WorkTimelineEvent[]) => events.map(key).sort();

  // work-timeline covers four derived event kinds; the log currently carries three.
  // `assigned` (activity-log-derived) and interaction-`approved` (deferred E3b) are
  // the known remaining gaps, filtered out of the parity comparison below.
  const WIRED_KINDS = new Set(["created", "commented", "approved"]);

  it("reproduces created + commented + approved for a live-written issue set", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Parity");
    const issues = issueService(ctx.db);
    const approvals = approvalService(ctx.db);
    const junction = issueApprovalService(ctx.db);

    const issueA = await issues.create(companyId, { title: "Issue A", status: "todo", priority: "medium", createdByUserId: userId });
    const issueB = await issues.create(companyId, { title: "Issue B", status: "todo", priority: "medium", createdByUserId: userId });

    await issues.addComment(issueA.id, "first comment", { userId });
    await issues.addComment(issueA.id, "second comment", { userId });

    const approval = await approvals.create(companyId, {
      type: "request_board_approval",
      requestedByUserId: userId,
      payload: {},
    } as Parameters<typeof approvals.create>[1]);
    await junction.link(issueA.id, approval.id, { userId });
    await junction.link(issueB.id, approval.id, { userId });
    await approvals.approve(approval.id, "decider-user");

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const timeline = await workTimelineService(ctx.db).getTimeline({
      companyId,
      from,
      to,
      canReadIssue: async () => true,
    });
    const expected = timeline.events.filter((e) => WIRED_KINDS.has(e.kind));
    const actual = await deriveWorkTimelineEventsFromLog(ctx.db, {
      issueIds: [issueA.id, issueB.id],
      from,
      to,
    });

    // Sanity: the fixture actually exercised all three wired kinds.
    const kinds = new Set(expected.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["created", "commented", "approved"]));
    // 2 created + 2 commented + 2 approved (one per fanned-out link).
    expect(expected).toHaveLength(6);

    expect(norm(actual)).toEqual(norm(expected));
  });
});
