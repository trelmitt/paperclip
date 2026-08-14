import { z } from "zod";
import { ISSUE_EVENT_ACTOR_TYPES, ISSUE_EVENT_KINDS } from "../constants.js";

export const issueEventKindSchema = z.enum(ISSUE_EVENT_KINDS);
export const issueEventActorTypeSchema = z.enum(ISSUE_EVENT_ACTOR_TYPES);

/**
 * Validates an `issue_events` row as serialized over the API. Structurally
 * mirrors the {@link IssueEvent} interface in ../types/issue-event.ts.
 */
export const issueEventSchema = z.object({
  id: z.number(),
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  kind: issueEventKindSchema,
  actorType: issueEventActorTypeSchema,
  actorId: z.string().nullable(),
  actorRunId: z.string().uuid().nullable(),
  sourceTable: z.string().nullable(),
  sourceId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.coerce.date(),
});
