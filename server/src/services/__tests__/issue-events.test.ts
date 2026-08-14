import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendIssueEvent,
  issueEventsDualWriteEnabled,
  type IssueEventPublication,
} from "../issue-events.js";
import * as liveEvents from "../live-events.js";

// Minimal stub of the drizzle insert chain: captures the inserted values and
// returns a fixed id, so the mapping + publish/defer logic is exercised without
// a database. The real INSERT is covered by the E2 dual-write integration path.
function stubDb(returnedId: number, captured: { values?: Record<string, unknown> }) {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.values = v;
        return { returning: () => Promise.resolve([{ id: returnedId }]) };
      },
    }),
  };
}

const BASE = {
  companyId: "c1",
  issueId: "i1",
  kind: "status_changed" as const,
  actorType: "agent" as const,
  actorId: "a1",
};

describe("appendIssueEvent", () => {
  it("maps the input to columns and returns the bigserial id", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const result = await appendIssueEvent(stubDb(42, captured), {
      ...BASE,
      sourceTable: "issue_comments",
      sourceId: "cm1",
      payload: { authorAgentId: "a1" },
    });
    expect(result).toEqual({ id: 42 });
    expect(captured.values).toMatchObject({
      companyId: "c1",
      issueId: "i1",
      kind: "status_changed",
      actorType: "agent",
      actorId: "a1",
      actorRunId: null,
      sourceTable: "issue_comments",
      sourceId: "cm1",
      payload: { authorAgentId: "a1" },
    });
    // No explicit `at` → createdAt is left to the DB default, never set on the insert.
    expect(captured.values).not.toHaveProperty("createdAt");
  });

  it("defers the live publish onto the post-commit list rather than emitting inline", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const pubs: IssueEventPublication[] = [];
    await appendIssueEvent(stubDb(7, captured), BASE, pubs);
    expect(pubs).toHaveLength(1);
    expect(typeof pubs[0]).toBe("function");
    // Flushing the thunk after "commit" must not throw (emits to the live bus).
    expect(() => pubs[0]()).not.toThrow();
  });

  it("never publishes inline — with no post-commit list the row is written but no live event fires", async () => {
    // Regression guard: emitting inline is unsafe because a service can be built
    // from an open transaction (issueService(tx)), so the row may not be durable
    // yet — an inline emit would be a phantom on rollback. Live emit is opt-in.
    const captured: { values?: Record<string, unknown> } = {};
    const spy = vi.spyOn(liveEvents, "publishLiveEvent");
    try {
      await expect(appendIssueEvent(stubDb(1, captured), BASE)).resolves.toEqual({ id: 1 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("sets createdAt from an explicit `at` (backfill path)", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const at = new Date("2026-01-02T03:04:05.000Z");
    await appendIssueEvent(stubDb(1, captured), { ...BASE, at }, []);
    expect(captured.values).toMatchObject({ createdAt: at });
  });
});

describe("issueEventsDualWriteEnabled", () => {
  const prev = process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE;
    else process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE = prev;
  });

  it("is off unless the env flag is exactly 'true'", () => {
    delete process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE;
    expect(issueEventsDualWriteEnabled()).toBe(false);
    process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE = "1";
    expect(issueEventsDualWriteEnabled()).toBe(false);
    process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE = "true";
    expect(issueEventsDualWriteEnabled()).toBe(true);
  });
});
