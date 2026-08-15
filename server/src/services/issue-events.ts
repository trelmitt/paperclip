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
 * Actor for a RESOLVED thread interaction, matching work-timeline's `approved`
 * precedence (work-timeline.ts:711-720): resolver first (user before agent), then
 * the creator (agent before user), else system. When an interaction is resolved
 * administratively (resolvedAt set but no resolvedBy*), this correctly falls
 * through to the creator — exactly what work-timeline does. The CREATED event
 * (still pending) instead uses resolveIssueEventActor(createdByAgentId,
 * createdByUserId), which is the same fall-through with both resolvedBy* null.
 */
export function resolveInteractionEventActor(interaction: {
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}): { actorType: IssueEventActorType; actorId: string | null } {
  if (interaction.resolvedByUserId) return { actorType: "user", actorId: interaction.resolvedByUserId };
  if (interaction.resolvedByAgentId) return { actorType: "agent", actorId: interaction.resolvedByAgentId };
  return resolveIssueEventActor(interaction.createdByAgentId, interaction.createdByUserId);
}

/** The issue_thread_interactions columns {@link appendInteractionRowEvents} reads. */
export interface InteractionEventRow {
  id: string;
  companyId: string;
  issueId: string;
  kind: string;
  status: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  sourceRunId?: string | null;
  createdAt?: Date | string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
  resolvedByRunId?: string | null;
  resolvedAt?: Date | string | null;
}

/**
 * Emits the `thread_interaction` created event (creator @createdAt) and, once
 * resolvedAt is set, the resolved event (resolveInteractionEventActor @resolvedAt)
 * for one issue_thread_interactions row (backlog E3b). The derived reader collapses
 * the pair to work-timeline's single `approved`.
 *
 * Both writes are keyed on the interaction id (`${id}:created` / `${id}:resolved`)
 * and go through appendIssueEvent's onConflictDoNothing, so it is safe to call at
 * create time, at resolve time, AND in the backfill — every caller converges on the
 * same two rows. This is the ONE definition of the pairing convention: the service
 * hooks, the E4 backfill, and the raw interaction writers in tool-gateway.ts /
 * tool-access.ts (which bypass the service) all route through here so the live log
 * has no coverage holes. Rows-only (no live publication) — like the rest of cut-1.
 *
 * ponytail: append-only ceiling — a `${id}:resolved` event cannot be rewritten, so
 * an interaction that is resolved, then REOPENED (tool-access OAuth reconnect), then
 * re-resolved keeps the FIRST resolution in the log while work-timeline shows the
 * second. Reopen is rare (OAuth only) and closing it needs a retraction event;
 * deferred with the rest of reopen semantics.
 */
export async function appendInteractionRowEvents(
  dbOrTx: any,
  row: InteractionEventRow,
): Promise<{ createdWritten: boolean; resolvedWritten: boolean }> {
  const createdActor = resolveIssueEventActor(row.createdByAgentId, row.createdByUserId);
  const created = await appendIssueEvent(dbOrTx, {
    companyId: row.companyId,
    issueId: row.issueId,
    kind: "thread_interaction",
    actorType: createdActor.actorType,
    actorId: createdActor.actorId,
    actorRunId: row.sourceRunId ?? null,
    sourceTable: "issue_thread_interactions",
    sourceId: `${row.id}:created`,
    payload: { interactionId: row.id, interactionKind: row.kind, status: row.status, phase: "created" },
    // Hydrated timestamps are Date | string; coerce (new Date copies a Date, parses a string).
    at: row.createdAt ? new Date(row.createdAt) : undefined,
  });
  let resolvedWritten = false;
  if (row.resolvedAt) {
    const resolvedActor = resolveInteractionEventActor(row);
    const resolved = await appendIssueEvent(dbOrTx, {
      companyId: row.companyId,
      issueId: row.issueId,
      kind: "thread_interaction",
      actorType: resolvedActor.actorType,
      actorId: resolvedActor.actorId,
      actorRunId: row.resolvedByRunId ?? null,
      sourceTable: "issue_thread_interactions",
      sourceId: `${row.id}:resolved`,
      payload: { interactionId: row.id, interactionKind: row.kind, status: row.status, phase: "resolved" },
      at: row.resolvedAt ? new Date(row.resolvedAt) : undefined,
    });
    resolvedWritten = resolved.id !== null;
  }
  return { createdWritten: created.id !== null, resolvedWritten };
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
