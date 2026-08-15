import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  agents,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issueEvents,
  issues as issuesTable,
} from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { LIVE_STREAM_HEARTBEAT, LIVE_STREAM_ISSUE } from "@paperclipai/shared";
import { backfillLiveStreams, planLiveResumeFlush } from "../services/live-events-backfill.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

// Backlog F — the reconnect backfill. backfillLiveStreams reproduces the durable frames a
// client missed since its cursor from issue_events + heartbeat_run_events, shaped byte-identical
// to the live emit. planLiveResumeFlush is the seam that drops from the buffered live frames only
// the exact (stream, seq) keys the backfill already delivered — never a `seq <= max` fence, so a
// late out-of-order lower-id commit is not lost. These two pieces carry the resume correctness.
describeEmbeddedPostgres("live-events backfill (F)", () => {
  const ctx = useEmbeddedPostgres("paperclip-live-backfill-", {
    resetEach: async (db) => {
      await db.delete(issueEvents);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(issuesTable);
      await db.delete(agents);
      await db.delete(companies);
    },
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await ctx.db.insert(companies).values({
      id: companyId,
      name: `Backfill ${companyId}`,
      issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string) {
    const issueId = randomUUID();
    await ctx.db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Backfill issue",
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  async function seedAgentAndRun(companyId: string) {
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    return { agentId, runId };
  }

  it("replays only rows after the cursor per stream, ascending, byte-shaped like the live emit", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const { agentId, runId } = await seedAgentAndRun(companyId);

    const issueRows = await ctx.db
      .insert(issueEvents)
      .values([
        { companyId, issueId, kind: "created", actorType: "user", actorId: "u1", payload: {} },
        { companyId, issueId, kind: "commented", actorType: "user", actorId: "u1", sourceTable: "issue_comments", sourceId: "c1", payload: { commentId: "c1" } },
        { companyId, issueId, kind: "status_changed", actorType: "agent", actorId: "a1", payload: { to: "in_progress" } },
      ])
      .returning({ id: issueEvents.id });
    const [i1, i2, i3] = issueRows.map((r) => r.id);

    const hbRows = await ctx.db
      .insert(heartbeatRunEvents)
      .values([
        { companyId, runId, agentId, seq: 1, eventType: "lifecycle", message: "start" },
        { companyId, runId, agentId, seq: 2, eventType: "stdout", stream: "stdout", message: "hello" },
        { companyId, runId, agentId, seq: 3, eventType: "lifecycle", message: "done" },
      ])
      .returning({ id: heartbeatRunEvents.id });
    const [h1, h2, h3] = hbRows.map((r) => r.id);

    const result = await backfillLiveStreams(ctx.db, companyId, {
      [LIVE_STREAM_ISSUE]: i1,
      [LIVE_STREAM_HEARTBEAT]: h1,
    });

    // Only rows strictly after each cursor, each stream ascending, interleaved as issue-then-heartbeat.
    expect(result.frames.map((f) => ({ type: f.type, stream: f.stream, seq: f.seq }))).toEqual([
      { type: "issue.event", stream: LIVE_STREAM_ISSUE, seq: i2 },
      { type: "issue.event", stream: LIVE_STREAM_ISSUE, seq: i3 },
      { type: "heartbeat.run.event", stream: LIVE_STREAM_HEARTBEAT, seq: h2 },
      { type: "heartbeat.run.event", stream: LIVE_STREAM_HEARTBEAT, seq: h3 },
    ]);
    expect(result.deliveredKeys).toEqual(
      new Set([`${LIVE_STREAM_ISSUE}:${i2}`, `${LIVE_STREAM_ISSUE}:${i3}`, `${LIVE_STREAM_HEARTBEAT}:${h2}`, `${LIVE_STREAM_HEARTBEAT}:${h3}`]),
    );
    expect(result.truncatedStreams).toEqual([]);

    // issue.event payload matches appendIssueEvent's live shape (issueId/eventId/kind/actor + spread).
    // Look up by (stream, seq): issue_events.id and heartbeat_run_events.id are independent
    // bigserials, so seq collides across streams — which is exactly why the cursor namespaces by stream.
    const issueFrame = result.frames.find((f) => f.stream === LIVE_STREAM_ISSUE && f.seq === i2)!;
    expect(issueFrame.companyId).toBe(companyId);
    expect(issueFrame.payload).toEqual({
      issueId,
      eventId: i2,
      kind: "commented",
      actorType: "user",
      actorId: "u1",
      commentId: "c1",
    });

    // heartbeat.run.event preserves runId + per-run seq + body; issueId is live-only -> null on replay.
    const hbFrame = result.frames.find((f) => f.stream === LIVE_STREAM_HEARTBEAT && f.seq === h2)!;
    expect(hbFrame.payload).toEqual({
      runId,
      agentId,
      issueId: null,
      seq: 2,
      eventType: "stdout",
      stream: "stdout",
      level: null,
      color: null,
      message: "hello",
      payload: null,
    });
  });

  it("scans only the streams present in the cursor", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const { agentId, runId } = await seedAgentAndRun(companyId);
    await ctx.db.insert(issueEvents).values({ companyId, issueId, kind: "created", actorType: "user", actorId: "u1", payload: {} });
    await ctx.db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "lifecycle", message: "x" });

    const result = await backfillLiveStreams(ctx.db, companyId, { [LIVE_STREAM_ISSUE]: 0 });

    expect(result.frames.every((f) => f.stream === LIVE_STREAM_ISSUE)).toBe(true);
    expect([...result.deliveredKeys].some((k) => k.startsWith(`${LIVE_STREAM_HEARTBEAT}:`))).toBe(false);
  });

  it("does not cross the company boundary", async () => {
    const mine = await seedCompany();
    const other = await seedCompany();
    const otherIssue = await seedIssue(other);
    await ctx.db.insert(issueEvents).values({ companyId: other, issueId: otherIssue, kind: "created", actorType: "user", actorId: "u1", payload: {} });

    const result = await backfillLiveStreams(ctx.db, mine, { [LIVE_STREAM_ISSUE]: 0 });
    expect(result.frames).toEqual([]);
  });

  it("keeps the oldest CAP, drops the newest overflow, and flags truncation", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const CAP = 2000;
    const rows = Array.from({ length: CAP + 1 }, () => ({
      companyId,
      issueId,
      kind: "created" as const,
      actorType: "user" as const,
      actorId: "u1",
      payload: {},
    }));
    const inserted = await ctx.db.insert(issueEvents).values(rows).returning({ id: issueEvents.id });
    const ids = inserted.map((r) => r.id).sort((a, b) => a - b);

    const result = await backfillLiveStreams(ctx.db, companyId, { [LIVE_STREAM_ISSUE]: 0 });

    expect(result.truncatedStreams).toEqual([LIVE_STREAM_ISSUE]);
    expect(result.frames).toHaveLength(CAP);
    // Delivered frames are the oldest CAP ids (contiguous from the cursor); the newest is dropped.
    expect(result.frames[result.frames.length - 1]!.seq).toBe(ids[CAP - 1]);
    expect(result.deliveredKeys.has(`${LIVE_STREAM_ISSUE}:${ids[CAP - 1]}`)).toBe(true);
    expect(result.frames.some((f) => f.seq === ids[CAP])).toBe(false);
    expect(result.deliveredKeys.has(`${LIVE_STREAM_ISSUE}:${ids[CAP]}`)).toBe(false);
  });
});

// planLiveResumeFlush is pure — the exactly-once dedupe at the replay->live seam. No DB needed.
const frame = (over: Partial<LiveEvent>): LiveEvent => ({
  id: 1,
  companyId: "c",
  type: "issue.event",
  createdAt: "2026-08-14T00:00:00.000Z",
  payload: {},
  stream: null,
  seq: null,
  ...over,
});

it("planLiveResumeFlush drops only the exact (stream,seq) the backfill delivered, keeps the rest", () => {
  const buffered: LiveEvent[] = [
    frame({ stream: LIVE_STREAM_ISSUE, seq: 5 }), // in the delivered set -> dropped (true dup)
    frame({ stream: LIVE_STREAM_ISSUE, seq: 7 }), // in the delivered set -> dropped (true dup)
    frame({ stream: LIVE_STREAM_ISSUE, seq: 8 }), // not delivered -> kept (new)
    frame({ stream: LIVE_STREAM_HEARTBEAT, seq: 5 }), // seq collides with an issue key but stream differs -> kept
    frame({ type: "agent.status", stream: null, seq: null }), // stateless -> kept
  ];
  const delivered = new Set([`${LIVE_STREAM_ISSUE}:5`, `${LIVE_STREAM_ISSUE}:7`]);
  const kept = planLiveResumeFlush(buffered, delivered);
  expect(kept.map((f) => ({ stream: f.stream, seq: f.seq, type: f.type }))).toEqual([
    { stream: LIVE_STREAM_ISSUE, seq: 8, type: "issue.event" },
    { stream: LIVE_STREAM_HEARTBEAT, seq: 5, type: "issue.event" },
    { stream: null, seq: null, type: "agent.status" },
  ]);
});

it("planLiveResumeFlush keeps a late lower-seq frame the backfill never delivered (out-of-order commit)", () => {
  // The regression the review caught: bigserial 501 commits AFTER the backfill's snapshot saw 502,
  // so the backfill delivered 502 but NOT 501. A `seq <= max(502)` fence would drop 501 and lose it.
  // Exact membership keeps 501 (not in the delivered set) and drops only the true duplicate 502.
  const buffered: LiveEvent[] = [
    frame({ stream: LIVE_STREAM_HEARTBEAT, seq: 502 }), // delivered by backfill -> dropped
    frame({ stream: LIVE_STREAM_HEARTBEAT, seq: 501 }), // NOT delivered (committed late) -> MUST be kept
  ];
  const delivered = new Set([`${LIVE_STREAM_HEARTBEAT}:502`]);
  const kept = planLiveResumeFlush(buffered, delivered);
  expect(kept.map((f) => f.seq)).toEqual([501]);
});

it("planLiveResumeFlush with an empty delivered set is a no-op (nothing was backfilled)", () => {
  const buffered: LiveEvent[] = [
    frame({ stream: LIVE_STREAM_ISSUE, seq: 1 }),
    frame({ type: "agent.status" }),
  ];
  expect(planLiveResumeFlush(buffered, new Set())).toEqual(buffered);
});
