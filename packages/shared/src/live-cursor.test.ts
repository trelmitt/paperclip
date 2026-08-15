import { describe, expect, it } from "vitest";
import {
  decodeLiveCursor,
  encodeLiveCursor,
  isResumableLiveEventType,
  LIVE_STREAM_HEARTBEAT,
  LIVE_STREAM_ISSUE,
  mergeLiveCursor,
  type LiveCursor,
} from "./live-cursor.js";

describe("live-cursor (backlog F composite reconnect cursor)", () => {
  it("round-trips a multi-stream cursor through encode/decode", () => {
    const cursor: LiveCursor = { [LIVE_STREAM_ISSUE]: 42, [LIVE_STREAM_HEARTBEAT]: 1007 };
    expect(decodeLiveCursor(encodeLiveCursor(cursor))).toEqual(cursor);
  });

  it("produces a URL-safe token (no + / = that would need escaping in a query param)", () => {
    // A large payload is the case most likely to emit +// = under plain base64.
    const token = encodeLiveCursor({ [LIVE_STREAM_ISSUE]: 9_999_999, [LIVE_STREAM_HEARTBEAT]: 8_888_888 });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes any malformed / hostile / stale token to an empty cursor instead of throwing", () => {
    for (const bad of ["", undefined, null, "not-base64!!", btoa("[1,2,3]"), btoa("null"), btoa("\"str\""), btoa("{oops")]) {
      expect(decodeLiveCursor(bad as string)).toEqual({});
    }
  });

  it("drops non-numeric / negative seqs on decode (a client cannot forge a nonsense position)", () => {
    const token = btoa(JSON.stringify({ issue: 5, bogus: "x", neg: -3, nan: Number.NaN }));
    expect(decodeLiveCursor(token)).toEqual({ issue: 5 });
  });

  it("mergeLiveCursor keeps the max seq per stream and ignores non-advancing frames", () => {
    let c: LiveCursor = {};
    c = mergeLiveCursor(c, LIVE_STREAM_ISSUE, 10);
    c = mergeLiveCursor(c, LIVE_STREAM_ISSUE, 8); // out-of-order/dup -> ignored
    c = mergeLiveCursor(c, LIVE_STREAM_HEARTBEAT, 3);
    c = mergeLiveCursor(c, LIVE_STREAM_ISSUE, 12); // advances
    expect(c).toEqual({ [LIVE_STREAM_ISSUE]: 12, [LIVE_STREAM_HEARTBEAT]: 3 });
  });

  it("mergeLiveCursor is a no-op for class-3 (stateless) frames carrying no position", () => {
    const base: LiveCursor = { [LIVE_STREAM_ISSUE]: 1 };
    expect(mergeLiveCursor(base, null, null)).toBe(base);
    expect(mergeLiveCursor(base, undefined, 5)).toBe(base);
    expect(mergeLiveCursor(base, LIVE_STREAM_ISSUE, null)).toBe(base);
  });

  it("classifies resumable vs stateless live event types", () => {
    expect(isResumableLiveEventType("issue.event")).toBe(true);
    expect(isResumableLiveEventType("heartbeat.run.event")).toBe(true);
    // Resumes by byte-offset log store, not the composite bigserial cursor:
    expect(isResumableLiveEventType("heartbeat.run.log")).toBe(false);
    expect(isResumableLiveEventType("agent.status")).toBe(false);
    expect(isResumableLiveEventType("activity.logged")).toBe(false);
    expect(isResumableLiveEventType("plugin.ui.updated")).toBe(false);
  });
});
