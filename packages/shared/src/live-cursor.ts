import { LIVE_EVENT_TYPES, type LiveEventType } from "./constants.js";

/**
 * The reconnect resume cursor (backlog F). The live-events WebSocket is one company-scoped
 * multiplexed stream of heterogeneous event types with DIFFERENT durable backings, so a single
 * scalar cursor cannot resume all of them. Instead every replayable frame carries a
 * (stream, seq) position (see LiveEvent), and the resume cursor is the aggregate: the max seq
 * the client has seen per stream. On reconnect the client sends this map and the server
 * backfills each stream WHERE id > seq before going live.
 *
 * Delivery is at-least-once with idempotent consumers, not strict gap-free: the cursor seqs are
 * bigserial row ids, monotonic in ALLOCATION but not commit order, so under concurrent writers a
 * lower seq can be published/committed after the client advanced past a higher one. Dedupe is
 * therefore exact-membership (never `seq <= max`), and the rare below-cursor late commit is not
 * replayed — it self-heals via the durable re-read (see LiveEvent.stream/seq for the full note).
 *
 * Two company-global resume streams exist today; both are cursored by a bigserial row id (NOT
 * the ephemeral LiveEvent.id, and NOT a per-issue/per-run seq):
 *   - LIVE_STREAM_ISSUE     -> issue_events.id          (backlog E's declared F/H cursor)
 *   - LIVE_STREAM_HEARTBEAT -> heartbeat_run_events.id  (company-global id, not the per-run seq)
 * The token is deliberately opaque + generic (mergeLiveCursor works for ANY stream key) so H
 * can add streams — e.g. promote activity.logged once activity_log gains a monotonic column —
 * without changing the WS query contract or the client's cursor-tracking code.
 */
export type LiveCursor = Record<string, number>;

export const LIVE_STREAM_ISSUE = "issue";
export const LIVE_STREAM_HEARTBEAT = "heartbeat";

/**
 * The LIVE_EVENT_TYPES that carry a durable (stream, seq) bigserial cursor and are backfilled
 * from a durable store on reconnect. Keep in lockstep with the publish sites that set
 * LiveEvent.stream/seq. The remaining types resume by OTHER means, deliberately NOT via this
 * composite cursor:
 *   - heartbeat.run.log resumes by the byte-offset log store (the client's existing /log?offset
 *     backfill), not a bigserial — a separate cursor space, so it is not listed here.
 *   - activity.logged is a state-refetch for now: activity_log has a uuid PK with no monotonic
 *     column; promote it here once it gains one.
 *   - the 8 stateless projections (agent.status, heartbeat.run.status/queued/progress,
 *     external_object.updated, plugin.*) are re-derivable current state -> state-refetch.
 */
export const RESUMABLE_LIVE_EVENT_TYPES = [
  "issue.event",
  "heartbeat.run.event",
] as const satisfies readonly LiveEventType[];

export function isResumableLiveEventType(type: LiveEventType): boolean {
  return (RESUMABLE_LIVE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Fold one frame's (stream, seq) into the running cursor, keeping the MAX seq per stream.
 * A no-op for class-3 frames (stream/seq null) and for out-of-order/duplicate frames whose
 * seq does not advance the stream. The client calls this on every received frame; the result
 * is what it resends on reconnect.
 */
export function mergeLiveCursor(
  cursor: LiveCursor,
  stream: string | null | undefined,
  seq: number | null | undefined,
): LiveCursor {
  if (!stream || typeof seq !== "number" || !Number.isFinite(seq)) return cursor;
  const current = cursor[stream];
  if (current !== undefined && current >= seq) return cursor;
  return { ...cursor, [stream]: seq };
}

/** Base64url of the cursor JSON — a compact, opaque, URL-safe token for `?cursor=`. */
export function encodeLiveCursor(cursor: LiveCursor): string {
  const clean: LiveCursor = {};
  for (const [stream, seq] of Object.entries(cursor)) {
    if (typeof seq === "number" && Number.isFinite(seq)) clean[stream] = seq;
  }
  const json = JSON.stringify(clean);
  // btoa/atob exist in modern Node (18+) and browsers; the JSON here is ASCII (stream keys +
  // integers), so no unicode handling is needed. Make it URL-safe for a query param.
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a `?cursor=` token back to a LiveCursor. Total: any malformed / hostile / stale-format
 * token decodes to an empty cursor (resume from the beginning of every stream) rather than
 * throwing — a bad cursor must never break the WS upgrade.
 */
export function decodeLiveCursor(token: string | null | undefined): LiveCursor {
  if (!token) return {};
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64);
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: LiveCursor = {};
    for (const [stream, seq] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof seq === "number" && Number.isFinite(seq) && seq >= 0) out[stream] = seq;
    }
    return out;
  } catch {
    return {};
  }
}

// Re-exported for callers that want to iterate all types and split resumable vs stateless.
export { LIVE_EVENT_TYPES };
