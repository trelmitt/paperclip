import { and, asc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueEvents } from "@paperclipai/db";
import type { WorkTimelineEvent } from "@paperclipai/shared";

/**
 * Backlog E step 5: derive work-timeline's `events` array from the append-only
 * issue_events log instead of re-deriving it from the 4 source tables
 * (work-timeline.ts:684-737). E6 flips the read behind a flag once parity holds.
 *
 * Reproduced kinds — the log currently covers three of work-timeline's four
 * derived event kinds:
 *   - created   (issue_events `created`)      — one per issue, unconditional, at=createdAt
 *   - commented (issue_events `commented`)    — windowed on createdAt
 *   - approved  (approval_requested/_resolved)— collapsed per (issue,approval) link
 *
 * KNOWN GAPS (the parity test pins these; they are the remaining wiring):
 *   - `assigned`: work-timeline derives it from the activity log
 *     (action.includes("assign")); no such event is in the log yet (E2 emits a
 *     lifecycle `assignee_changed` with a null source, which is issue-row-diff
 *     semantics, not activity-log semantics).
 *   - `approved` from thread interactions: deferred with E3b, so interaction-only
 *     `approved` events are absent here.
 */

const KINDS = ["created", "commented", "approval_requested", "approval_resolved"] as const;

// Match work-timeline's actorId encoding (work-timeline.ts:86, :689/:701): system
// (and any actor without an id) collapses to the shared "system:system" id.
function encodeActor(actorType: string, actorId: string | null): string {
  if (actorType === "system" || !actorId) return "system:system";
  return `${actorType}:${actorId}`;
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
    } else if (row.kind === "approval_requested" || row.kind === "approval_resolved") {
      const key = row.sourceId ?? `${row.issueId}:${row.kind}`;
      const pair = approvalPair.get(key) ?? {};
      if (row.kind === "approval_requested") pair.requested = row;
      else pair.resolved = row;
      approvalPair.set(key, pair);
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

  return events.sort((left, right) => left.at.localeCompare(right.at));
}
