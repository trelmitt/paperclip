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
 * Appends one row to the append-only issue_events log (backlog E). No per-issue
 * seq is allocated — the bigserial id is the order key and the F/H replay cursor
 * (design decision Q2).
 *
 * `dbOrTx` is typed `any` per the repo convention (a drizzle Tx is not assignable
 * to Db). Pass a transaction so the event commits atomically with the mutation
 * that caused it, and pass `postCommitPublications` so the live emit is deferred
 * until after that transaction commits; omit the list for a best-effort inline emit.
 */
export async function appendIssueEvent(
  dbOrTx: any,
  input: AppendIssueEventInput,
  postCommitPublications?: IssueEventPublication[],
): Promise<{ id: number }> {
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
    .returning({ id: issueEvents.id });

  const publish: IssueEventPublication = () =>
    publishLiveEvent({
      companyId: input.companyId,
      type: "issue.event",
      payload: {
        issueId: input.issueId,
        eventId: row.id,
        kind: input.kind,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        ...input.payload,
      },
    });

  if (postCommitPublications) postCommitPublications.push(publish);
  else publish();

  return row;
}
