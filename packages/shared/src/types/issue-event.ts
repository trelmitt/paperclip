import type { IssueEventActorType, IssueEventKind } from "../constants.js";

/**
 * A single append-only entry in an issue's event log (backlog item E).
 *
 * `payload` carries only denormalized parity scalars (ids, timestamps, flags),
 * never comment/approval bodies — those are reached through
 * `sourceTable`/`sourceId` (design decision Q1). `id` is the global durable
 * order key and the F/H replay cursor (Q2).
 */
export interface IssueEvent {
  id: number;
  companyId: string;
  issueId: string;
  kind: IssueEventKind;
  actorType: IssueEventActorType;
  actorId: string | null;
  actorRunId: string | null;
  sourceTable: string | null;
  sourceId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}
