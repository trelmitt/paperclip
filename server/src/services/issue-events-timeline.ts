import { and, asc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueEvents } from "@paperclipai/db";
import type { WorkTimelineEvent } from "@paperclipai/shared";

/**
 * Backlog E step 5: derive work-timeline's `events` array from the append-only
 * issue_events log instead of re-deriving it from the 4 source tables
 * (work-timeline.ts:684-737). E6 flips the read behind a flag once parity holds.
 *
 * Reproduced kinds — the log now covers three of work-timeline's four derived
 * event kinds plus `assigned`:
 *   - created   (issue_events `created`)      — one per issue, unconditional, at=createdAt
 *   - commented (issue_events `commented`)    — windowed on createdAt
 *   - approved  (approval_requested/_resolved)— collapsed per (issue,approval) link
 *   - assigned  (issue_events `assignee_changed` with source_table="activity_log")
 *     — the activity-log-sourced assign rows work-timeline derives `assigned` from.
 *     E2's lifecycle `assignee_changed` (null source, issue-row-diff semantics) is
 *     deliberately NOT read here — only the activity-log-sourced rows are the
 *     `assigned` signal, exactly mirroring work-timeline's activity-log read.
 *   - approved  (thread_interaction created/resolved) — one per interaction,
 *     collapsed like approvals: the resolved event wins (resolver @resolvedAt) once
 *     present, else the creation stands (creator @createdAt).
 *
 * The reader now covers all four of work-timeline's derived event kinds.
 */

const KINDS = [
  "created",
  "commented",
  "approval_requested",
  "approval_resolved",
  "assignee_changed",
  "thread_interaction",
] as const;

// Match work-timeline's actorId encoding (work-timeline.ts:86): `${type}:${id}`.
// For `assigned`, work-timeline uses the raw activity-log actorId even when the
// actor type is system (`system:${row.actorId}`), so keep the id when present and
// only fall back to the shared "system" id when it is null (created/commented/
// approved system actors carry a null id, collapsing to "system:system").
function encodeActor(actorType: string, actorId: string | null): string {
  return `${actorType}:${actorId ?? "system"}`;
}

function inWindow(at: Date, from: Date, to: Date): boolean {
  const ms = at.getTime();
  return ms >= from.getTime() && ms <= to.getTime();
}

export async function deriveWorkTimelineEventsFromLog(
  db: Db,
  input: { issueIds: string[]; from: Date; to: Date },
): Promise<WorkTimelineEvent[]> {
  if (input.issueIds.length === 0) return [];

  const rows = await db
    .select({
      issueId: issueEvents.issueId,
      kind: issueEvents.kind,
      actorType: issueEvents.actorType,
      actorId: issueEvents.actorId,
      sourceTable: issueEvents.sourceTable,
      sourceId: issueEvents.sourceId,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(and(inArray(issueEvents.issueId, input.issueIds), inArray(issueEvents.kind, KINDS as unknown as string[])))
    .orderBy(asc(issueEvents.id));

  const events: WorkTimelineEvent[] = [];
  // Collapse approval_requested + approval_resolved for the same (issue,approval)
  // link into one `approved`, mirroring work-timeline: the resolved event wins
  // once present (decider actor, decidedAt), else the request stands (requester
  // actor, createdAt). Keyed on sourceId (`${issueId}:${approvalId}`).
  const approvalPair = new Map<string, { requested?: typeof rows[number]; resolved?: typeof rows[number] }>();
  // Same collapse for thread interactions (E3b): keyed on the interaction id, the
  // created event pairs with the resolved event (source_id `<id>:created` /
  // `<id>:resolved`). Resolved wins once present, mirroring work-timeline's single
  // `approved` per interaction (resolver??creator, resolvedAt??createdAt).
  const interactionPair = new Map<string, { created?: typeof rows[number]; resolved?: typeof rows[number] }>();

  for (const row of rows) {
    if (row.kind === "created") {
      // Unconditional per issue (work-timeline pushes created for every paged
      // issue regardless of the window).
      events.push({
        actorId: encodeActor(row.actorType, row.actorId),
        kind: "created",
        issueId: row.issueId,
        at: row.createdAt.toISOString(),
      });
    } else if (row.kind === "commented") {
      if (!inWindow(row.createdAt, input.from, input.to)) continue;
      events.push({
        actorId: encodeActor(row.actorType, row.actorId),
        kind: "commented",
        issueId: row.issueId,
        at: row.createdAt.toISOString(),
      });
    } else if (row.kind === "assignee_changed") {
      // Only the activity-log-sourced rows are the `assigned` signal; the
      // lifecycle assignee_changed (null source) is for the F/H live feed.
      if (row.sourceTable !== "activity_log") continue;
      if (!inWindow(row.createdAt, input.from, input.to)) continue;
      events.push({
        actorId: encodeActor(row.actorType, row.actorId),
        kind: "assigned",
        issueId: row.issueId,
        at: row.createdAt.toISOString(),
      });
    } else if (row.kind === "approval_requested" || row.kind === "approval_resolved") {
      const key = row.sourceId ?? `${row.issueId}:${row.kind}`;
      const pair = approvalPair.get(key) ?? {};
      if (row.kind === "approval_requested") pair.requested = row;
      else pair.resolved = row;
      approvalPair.set(key, pair);
    } else if (row.kind === "thread_interaction") {
      // sourceId is `<interactionId>:created` or `<interactionId>:resolved`.
      const sourceId = row.sourceId ?? "";
      const sep = sourceId.lastIndexOf(":");
      const interactionId = sep === -1 ? sourceId : sourceId.slice(0, sep);
      const phase = sep === -1 ? "" : sourceId.slice(sep + 1);
      const pair = interactionPair.get(interactionId) ?? {};
      if (phase === "resolved") pair.resolved = row;
      else pair.created = row;
      interactionPair.set(interactionId, pair);
    }
  }

  for (const pair of approvalPair.values()) {
    const chosen = pair.resolved ?? pair.requested;
    if (!chosen) continue;
    // work-timeline includes the link if the request OR the decision falls in the
    // window (approvals source query: `or(createdAt in window, decidedAt in window)`).
    const requestedIn = pair.requested ? inWindow(pair.requested.createdAt, input.from, input.to) : false;
    const resolvedIn = pair.resolved ? inWindow(pair.resolved.createdAt, input.from, input.to) : false;
    if (!requestedIn && !resolvedIn) continue;
    events.push({
      actorId: encodeActor(chosen.actorType, chosen.actorId),
      kind: "approved",
      issueId: chosen.issueId,
      at: chosen.createdAt.toISOString(),
    });
  }

  for (const pair of interactionPair.values()) {
    const chosen = pair.resolved ?? pair.created;
    if (!chosen) continue;
    // work-timeline includes the interaction if its creation OR resolution falls in
    // the window (interactions source query: `or(createdAt in window, resolvedAt in window)`).
    const createdIn = pair.created ? inWindow(pair.created.createdAt, input.from, input.to) : false;
    const resolvedIn = pair.resolved ? inWindow(pair.resolved.createdAt, input.from, input.to) : false;
    if (!createdIn && !resolvedIn) continue;
    events.push({
      actorId: encodeActor(chosen.actorType, chosen.actorId),
      kind: "approved",
      issueId: chosen.issueId,
      at: chosen.createdAt.toISOString(),
    });
  }

  return events.sort((left, right) => left.at.localeCompare(right.at));
}
