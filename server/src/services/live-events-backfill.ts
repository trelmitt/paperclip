import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, issueEvents } from "@paperclipai/db";
import {
  LIVE_STREAM_HEARTBEAT,
  LIVE_STREAM_ISSUE,
  type LiveCursor,
  type LiveEvent,
} from "@paperclipai/shared";

/**
 * Reconnect backfill (backlog F). Given a client's resume {@link LiveCursor} — the max durable
 * seq it has seen per stream — reproduce the frames it missed (id > cursor) from the durable
 * stores, as LiveEvents indistinguishable from live ones, so the WS handler can replay-then-stream.
 *
 * Delivery is at-least-once with idempotent consumers, NOT strict gap-free: bigserial ids are
 * allocated at insert but become visible at commit, so under concurrent writers a lower id can
 * commit after the client already advanced its cursor past a higher one — that lower id is then
 * never replayed (id > cursor skips it). This residual miss self-heals: issue.event's consumer
 * re-reads the durable log on any timeline load, and heartbeat.run.event's transcript has the
 * byte-offset /log poll. See {@link LiveBackfillResult.deliveredKeys} for the matching reason the
 * seam dedupe must be exact-membership, not a `seq <= max` fence.
 *
 * A backfilled frame carries the DB row's created_at (not emit time) and its durable id as both
 * the envelope `seq` (the resume cursor) and `id` (a stable key; the ephemeral bus id has no
 * meaning off the live path). Only the two bigserial-cursored streams are backfilled here:
 *   - LIVE_STREAM_ISSUE     -> issue_events          (full fidelity: payload matches the live emit)
 *   - LIVE_STREAM_HEARTBEAT -> heartbeat_run_events  (preserves runId + per-run seq + body; the
 *     live-only display hints issueId/currentToolName/lastAssistantSnippet are not stored, so a
 *     replayed frame omits them — acceptable for history, and the client keys on runId/per-run seq.)
 * heartbeat.run.log (byte-offset store) and the stateless projection types are NOT backfilled here
 * — they resume by the client's byte-offset /log reader and by state-refetch respectively.
 *
 * ponytail: CAP per stream bounds the scan for a normal reconnect (seconds–minutes). An outage
 * long enough to exceed it keeps the OLDEST CAP missed events (ascending id, sliced) — so the
 * delivered frames stay contiguous from the client's cursor — and DROPS the newest overflow,
 * leaving a tail gap the live stream then jumps past. We flag the stream in `truncatedStreams`
 * so the caller can tell the client to full-refetch. Raise CAP or paginate only if truncation is
 * observed in practice.
 */
const BACKFILL_CAP_PER_STREAM = 2000;

/** Seam-dedupe key for a durable frame: `${stream}:${seq}`. Namespaced by stream because
 * issue_events.id and heartbeat_run_events.id are independent bigserials whose seqs collide. */
function frameKey(stream: string, seq: number): string {
  return `${stream}:${seq}`;
}

export interface LiveBackfillResult {
  /** All replayed frames, each stream in ascending id order. */
  frames: LiveEvent[];
  /**
   * The exact (stream, seq) keys this backfill delivered — the seam-dedupe membership set.
   * NOT a max/fence: bigserial ids are allocated at insert but become visible at commit, so a
   * lower id can commit AFTER a higher one (and after this query's snapshot). A `seq <= max`
   * fence would then drop such a late lower-id live frame that the backfill never delivered,
   * losing it. Exact membership only ever drops a true duplicate, never a genuinely-new frame.
   */
  deliveredKeys: Set<string>;
  /** A stream whose missed events exceeded the cap (oldest events dropped; client should refetch). */
  truncatedStreams: string[];
}

export async function backfillLiveStreams(
  db: Db,
  companyId: string,
  cursor: LiveCursor,
): Promise<LiveBackfillResult> {
  const frames: LiveEvent[] = [];
  const deliveredKeys = new Set<string>();
  const truncatedStreams: string[] = [];

  const issueFrom = cursor[LIVE_STREAM_ISSUE];
  if (typeof issueFrom === "number") {
    const rows = await db
      .select({
        id: issueEvents.id,
        issueId: issueEvents.issueId,
        kind: issueEvents.kind,
        actorType: issueEvents.actorType,
        actorId: issueEvents.actorId,
        payload: issueEvents.payload,
        createdAt: issueEvents.createdAt,
      })
      .from(issueEvents)
      .where(and(eq(issueEvents.companyId, companyId), gt(issueEvents.id, issueFrom)))
      .orderBy(asc(issueEvents.id))
      .limit(BACKFILL_CAP_PER_STREAM + 1);
    if (rows.length > BACKFILL_CAP_PER_STREAM) truncatedStreams.push(LIVE_STREAM_ISSUE);
    for (const row of rows.slice(0, BACKFILL_CAP_PER_STREAM)) {
      frames.push({
        id: row.id,
        companyId,
        type: "issue.event",
        createdAt: row.createdAt.toISOString(),
        stream: LIVE_STREAM_ISSUE,
        seq: row.id,
        // Byte-for-byte the live emit's payload (issue-events.ts appendIssueEvent).
        payload: {
          issueId: row.issueId,
          eventId: row.id,
          kind: row.kind,
          actorType: row.actorType,
          actorId: row.actorId ?? null,
          ...(row.payload ?? {}),
        },
      });
      deliveredKeys.add(frameKey(LIVE_STREAM_ISSUE, row.id));
    }
  }

  const heartbeatFrom = cursor[LIVE_STREAM_HEARTBEAT];
  if (typeof heartbeatFrom === "number") {
    const rows = await db
      .select({
        id: heartbeatRunEvents.id,
        runId: heartbeatRunEvents.runId,
        agentId: heartbeatRunEvents.agentId,
        seq: heartbeatRunEvents.seq,
        eventType: heartbeatRunEvents.eventType,
        stream: heartbeatRunEvents.stream,
        level: heartbeatRunEvents.level,
        color: heartbeatRunEvents.color,
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
        createdAt: heartbeatRunEvents.createdAt,
      })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.companyId, companyId), gt(heartbeatRunEvents.id, heartbeatFrom)))
      .orderBy(asc(heartbeatRunEvents.id))
      .limit(BACKFILL_CAP_PER_STREAM + 1);
    if (rows.length > BACKFILL_CAP_PER_STREAM) truncatedStreams.push(LIVE_STREAM_HEARTBEAT);
    for (const row of rows.slice(0, BACKFILL_CAP_PER_STREAM)) {
      frames.push({
        id: row.id,
        companyId,
        type: "heartbeat.run.event",
        createdAt: row.createdAt.toISOString(),
        stream: LIVE_STREAM_HEARTBEAT,
        seq: row.id,
        payload: {
          runId: row.runId,
          agentId: row.agentId,
          issueId: null, // live-only (readRuntimeStatusIssueIdCandidate); not stored -> omitted on replay
          seq: row.seq, // the per-run order key the transcript consumer + item-A afterSeq use
          eventType: row.eventType,
          stream: row.stream ?? null,
          level: row.level ?? null,
          color: row.color ?? null,
          message: row.message ?? null,
          payload: row.payload ?? null,
        },
      });
      deliveredKeys.add(frameKey(LIVE_STREAM_HEARTBEAT, row.id));
    }
  }

  return { frames, deliveredKeys, truncatedStreams };
}

/**
 * The seam dedupe (backlog F). Given the live frames that buffered while the backfill query ran
 * and the EXACT set of (stream, seq) keys the backfill already delivered, return the frames still
 * to send: drop a resumable frame only if the backfill delivered that same key (a true duplicate),
 * keep every frame it did not (including a lower-seq frame that committed after the backfill's
 * snapshot — see LiveBackfillResult.deliveredKeys), and keep every stateless frame (no stream/seq)
 * as-is. Exact membership, not `seq <= max`: the latter would drop a genuinely-new late lower-id
 * frame and lose it. Exactly-once across the replay->live seam without any density assumption.
 */
export function planLiveResumeFlush(
  bufferedLive: LiveEvent[],
  deliveredKeys: Set<string>,
): LiveEvent[] {
  return bufferedLive.filter((event) => {
    const streamKey = event.stream;
    const seq = event.seq;
    if (!streamKey || typeof seq !== "number") return true; // stateless — never in the backfill
    return !deliveredKeys.has(frameKey(streamKey, seq));
  });
}
