import type { LiveEventType } from "../constants.js";

export interface LiveEvent {
  /**
   * Ephemeral in-process bus id (live-events.ts `nextEventId`). Unique within one server
   * process, resets to 0 on restart, shared across all companies and types. Safe as a
   * React list key; NEVER a resume cursor — use {@link LiveEvent.stream}/{@link LiveEvent.seq}.
   */
  id: number;
  companyId: string;
  type: LiveEventType;
  /** Emit time for live frames; the DB row's created_at for backfilled (replayed) frames. */
  createdAt: string;
  payload: Record<string, unknown>;
  /**
   * Durable resume position (backlog F — the reconnect cursor). Set only on the durably-backed,
   * append-only event types (see RESUMABLE_LIVE_EVENT_TYPES): `stream` is a company-global
   * resume-stream discriminator (LIVE_STREAM_ISSUE / LIVE_STREAM_HEARTBEAT) and `seq` is the
   * durable row id within it (a bigserial). Absent/null on the class-3 stateless projection
   * frames (agent.status, heartbeat.run.status/queued/progress, external_object.updated,
   * plugin.*), which are re-derivable current state, not replayable events — a reconnecting
   * client refetches their state instead of replaying.
   *
   * Together (stream, seq) is the composite cursor: the client tracks the max seq per stream
   * (mergeLiveCursor), resends the aggregate on reconnect (encodeLiveCursor -> ?cursor=), and
   * the server backfills each stream WHERE id > seq before attaching the live listener, deduping
   * the seam by exact (stream, seq) membership.
   *
   * NOTE: `seq` is monotonic in ALLOCATION order, not commit order — a bigserial id is grabbed at
   * insert but only becomes visible at commit, so under concurrent writers a lower seq can be
   * published after a higher one. So the cursor is NOT a dense fence: dedupe (client and seam)
   * must be exact-membership, never `seq <= max`, and delivery is at-least-once with idempotent
   * consumers. The rare event that commits below an already-advanced cursor is not replayed on the
   * next reconnect; it self-heals via the durable re-read (issue.event's timeline reader,
   * heartbeat.run.event's /log poll). True gap-free would need a commit-ordered sequence.
   */
  stream?: string | null;
  seq?: number | null;
}
