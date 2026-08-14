import { issueEvents } from "@paperclipai/db";
import type { IssueEventActorType, IssueEventKind } from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";

/**
 * Deferred live-event publisher. Mirrors the ActivityPublication post-commit
 * pattern in activity-log.ts: when {@link appendIssueEvent} runs inside a
 * caller's transaction, the publish is pushed onto a list the caller flushes
 * AFTER commit, so a rolled-back mutation never emits a phantom "issue.event".
 */
export type IssueEventPublication = () => void;

export interface AppendIssueEventInput {
  companyId: string;
  issueId: string;
  kind: IssueEventKind;
  actorType: IssueEventActorType;
  actorId?: string | null;
  actorRunId?: string | null;
  payload?: Record<string, unknown>;
  sourceTable?: string | null;
  sourceId?: string | null;
  /** Effective timestamp; omit for live (defaults now()). The backfill passes the source ts. */
  at?: Date;
}

/**
 * Dual-write feature flag (backlog E). Off by default, so callers skip emitting
 * and the issue_events projection stays inert with no behavior change until the
 * flag is deliberately turned on for a rollout.
 */
export function issueEventsDualWriteEnabled(): boolean {
  return process.env.PAPERCLIP_ISSUE_EVENTS_DUAL_WRITE === "true";
}

/**
 * Resolves an (agentId, userId) pair to the event's actor. Mirrors the
 * `actorAgentId ? "agent" : actorUserId ? "user" : "system"` idiom the issue
 * service already uses for logActivity, so the two logs attribute identically.
 */
export function resolveIssueEventActor(
  agentId?: string | null,
  userId?: string | null,
): { actorType: IssueEventActorType; actorId: string | null } {
  if (agentId) return { actorType: "agent", actorId: agentId };
  if (userId) return { actorType: "user", actorId: userId };
  return { actorType: "system", actorId: null };
}

/**
 * Actor for an approval event, matching work-timeline's `approved` precedence
 * (work-timeline.ts:694-701): the decider wins once decided, else the requester,
 * else system. One `approval_requested` (decidedByUserId still null) resolves to
 * the requester; one `approval_resolved` resolves to the decider.
 */
export function resolveApprovalEventActor(approval: {
  decidedByUserId?: string | null;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
}): { actorType: IssueEventActorType; actorId: string | null } {
  if (approval.decidedByUserId) return { actorType: "user", actorId: approval.decidedByUserId };
  return resolveIssueEventActor(approval.requestedByAgentId, approval.requestedByUserId);
}

/**
 * Appends one row to the append-only issue_events log (backlog E). No per-issue
 * seq is allocated — the bigserial id is the order key and the F/H replay cursor
 * (design decision Q2).
 *
 * `dbOrTx` is typed `any` per the repo convention (a drizzle Tx is not assignable
 * to Db). Pass a transaction so the event commits atomically with the mutation
 * that caused it, and pass `postCommitPublications` so the live emit is deferred
 * until after that transaction commits (omit the list for rows-only, no live emit).
 *
 * The insert is `onConflictDoNothing`: source-bearing events (created per issue,
 * commented per comment, approval_* per issue+approval link) collide on the
 * partial unique index (source_table, source_id, kind) if the same logical event
 * is written twice — a re-link, a retry, or the E4 backfill overlapping the live
 * write. Swallowing that duplicate is exactly the idempotency Q3 designed the
 * index for. Lifecycle events (source_id null) are unconstrained and never conflict.
 * Returns the new row id, or null when the insert was a no-op (already present).
 */
export async function appendIssueEvent(
  dbOrTx: any,
  input: AppendIssueEventInput,
  postCommitPublications?: IssueEventPublication[],
): Promise<{ id: number | null }> {
  const [row] = await dbOrTx
    .insert(issueEvents)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      kind: input.kind,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorRunId: input.actorRunId ?? null,
      sourceTable: input.sourceTable ?? null,
      sourceId: input.sourceId ?? null,
      payload: input.payload ?? {},
      ...(input.at ? { createdAt: input.at } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: issueEvents.id });

  // Live emit is opt-in and post-commit ONLY: the thunk is appended to a list the
  // caller flushes AFTER its OUTERMOST transaction commits. We never publish
  // inline. A service can be built from an open transaction (issueService(tx)), so
  // there is no reliable in-helper signal that the row is durable yet — emitting
  // early would deliver a phantom `issue.event` if that outer tx rolls back. The
  // cut-1 dual-write and the backfill pass no list (rows only); H wires the flush.
  // On a conflict no-op there is no new row and nothing new happened, so there is
  // nothing to emit — skip the thunk and report a null id.
  if (postCommitPublications && row) {
    const eventId = row.id;
    postCommitPublications.push(() =>
      publishLiveEvent({
        companyId: input.companyId,
        type: "issue.event",
        payload: {
          issueId: input.issueId,
          eventId,
          kind: input.kind,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          ...input.payload,
        },
      }));
  }

  return { id: row?.id ?? null };
}
