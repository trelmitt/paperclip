---
title: "Backlog E — issue_events implementation plan"
status: SCOPE / DESIGN — no code until approved
source: workflow e-issue-event-log-design (11 agents, grounded in codebase @ /Users/trev/paperclip)
date: 2026-08-14
---

# Backlog Item E — Per-Issue Append-Only Event Log (`issue_events`)

## 1. Resolved design decisions

### Q1 — `payload` carries a REFERENCE (+ denormalized parity fields), never embedded bodies

**Decision:** `issue_events` rows store the **actor**, the **kind**, the **effective timestamp**, a **source reference** (`source_table` + `source_id`), and a small JSONB `payload` holding only the *derived scalar fields the work-timeline reader needs* — assignee ids, parent-actor id, both approval/interaction timestamps, an is-assign flag, run usage. They do **not** embed comment bodies, approval reason text, interaction payloads, or any large/mutable content.

**Rationale:** The work-timeline reader is the parity oracle, and it never reads a body. Every source sub-query selects only ids and timestamps: comments pull `issueId, authorAgentId, authorUserId, createdAt, deletedAt` (work-timeline.ts:582-598), approvals pull `decidedByUserId, decidedAt, requestedByAgentId, requestedByUserId, createdAt` (:599-619), interactions pull the `resolvedBy*/createdBy*` ids + `resolvedAt/createdAt` (:620-640) — the emitted entry is always the bare `Event{actorId, kind, issueId, at}` (:684-728). Nothing downstream needs the text. Embedding bodies would duplicate mutable content (comments soft-delete via `deletedAt`, get `sourceTrust` promoted at routes/issues.ts:7190, get tombstoned at issues.ts:8556) and force the event log to chase every later edit to stay correct — the opposite of append-only. A `source_table`/`source_id` reference lets any richer consumer (a future detail panel) join back to the live row and get the current body for free, while the parity-critical scalars ride in `payload` so the reader needs zero joins for the timeline itself.

### Q2 — No per-issue `seq`. Order and cursor on the global `bigserial id`

**Decision:** The table's primary key is a global `bigserial id`. Per-issue ordering is `WHERE issue_id = ? ORDER BY id`. There is **no** contiguous per-issue `seq` column. F's replayable cursor is the durable, monotonic `id` (or `company_id`-scoped `id`), not a per-issue counter and not the volatile in-process `LiveEvent.id`.

**Rationale:** The seq-allocation map is unambiguous that copying `heartbeat_run_events.seq` faithfully copies its bug. `nextRunEventSeq` (heartbeat.ts:9695-9701) is a `SELECT max(seq)+1` read-modify-write with no `UNIQUE(run_id,seq)` (only the non-unique index at heartbeat_run_events.ts:23), no advisory lock, no DB sequence — a TOCTOU race the code tolerates *only* because one run-driver process owns the in-memory `seq=1` counter (heartbeat.ts:15073) and lifecycle `MAX+1` writes are time-separated from it. An issue has **no single owning writer** — comments, status flips, checkout, and multiple agents append from independent request handlers that genuinely race — so the `MAX+1` collision the runs path narrowly avoids would fire routinely. The map's own recommendation (option 1, echoed in its `ponytail` note) is to skip per-issue seq entirely: the read path already proves `id` is a sufficient order (heartbeat.ts:18922 falls back to `id desc`). Using the DB-assigned `bigserial` means allocation is atomic by construction, needs no constraint gymnastics, and hands F a better cursor than the runs table ever had. Add a per-issue `seq` later *only* if product demands contiguous 1..N numbering (it doesn't for a timeline).

### Q3 — Backfill orders historical rows by `(created_at ASC, source-precedence, source_id)` so `id` order == timeline order

**Decision:** The one-time backfill inserts historical rows sorted by `created_at ASC`, tie-broken by **work-timeline's source insertion precedence** — `created`/`delegated` → `commented` → `approved`(approvals) → `approved`(interactions) → `assigned` — and finally by `source_id`. Because `id` is `bigserial`, ascending insertion yields ascending ids that already encode chronological-plus-precedence order; the reader then just `ORDER BY id`.

**Rationale:** Work-timeline sorts events by `at.localeCompare` on ISO-Z strings with a **stable** sort, so equal-`at` ties keep source insertion order (work-timeline.ts:778, parity-risk #9/#10). To reproduce byte-identical output the derived reader must break `at` ties the same way. Rather than re-implement a multi-key comparator at read time, the backfill *bakes the tie-break into `id`* by inserting in that exact order, so the live `ORDER BY id` path and the historical rows agree. Ties within one source (two comments at the same instant) fall through to `source_id`, which is stable. This also fixes the approvals/interactions inclusion-vs-label quirk cleanly: instead of one row with two timestamps, each lifecycle moment becomes its **own** event stamped at the moment it happened (`approval_requested` at `createdAt`, `approval_resolved` at `decidedAt`), so there is no OR-window to replicate — the reader collapses them back to the work-timeline shape (§6).

---

## 2. `issue_events` table — Drizzle schema

Modeled on `heartbeat_run_events.ts` (bigserial id + notNull cols) and `case_events.ts:99-114` (inline `check()` allow-list). New file `packages/db/src/schema/issue_events.ts`, exported from `packages/db/src/schema/index.ts`.

```ts
import { sql } from "drizzle-orm";
import {
  bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies";
import { issues } from "./issues";

export const issueEvents = pgTable(
  "issue_events",
  {
    // Global durable cursor / order key (Q2). Also F's WS replay cursor.
    id: bigserial("id", { mode: "number" }).primaryKey(),

    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),

    kind: text("kind").notNull(),          // CHECK below — mirrors ISSUE_EVENT_KINDS
    actorType: text("actor_type").notNull(), // CHECK below — agent|user|system|plugin
    actorId: text("actor_id"),             // null when actorType = system
    actorRunId: uuid("actor_run_id"),      // optional run attribution (heartbeat/checkout)

    // Reference, not embed (Q1). source_id null for lifecycle events with no 1:1 source row.
    sourceTable: text("source_table"),
    sourceId: text("source_id"),

    // Denormalized parity scalars only — no bodies (Q1).
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),

    // Effective timestamp of the moment (Q3): now() for live, source ts for backfill.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Per-issue ordered read (work-timeline reader, issue detail).
    issueIdIdx: index("issue_events_issue_id_id_idx").on(t.issueId, t.id),
    // Company-scoped replay/cursor for F (single WS per company).
    companyIdx: index("issue_events_company_id_id_idx").on(t.companyId, t.id),
    // Backfill idempotency (Q3 / §8): re-runnable via ON CONFLICT DO NOTHING.
    sourceUniq: uniqueIndex("issue_events_source_kind_uniq")
      .on(t.sourceTable, t.sourceId, t.kind)
      .where(sql`${t.sourceId} is not null`),

    kindCheck: sql`constraint issue_events_kind_check check (${t.kind} in (
      'created','status_changed','assignee_changed','blocker_added','blocker_cleared',
      'commented','comment_removed',
      'approval_requested','approval_resolved',
      'thread_interaction',
      'run_started','run_finished'))`,
    actorTypeCheck: sql`constraint issue_events_actor_type_check check (${t.actorType} in (
      'agent','user','system','plugin'))`,
  }),
);
```

Notes: no `updatedAt` (append-only); `id` is the only order key; the partial unique index makes backfill idempotent while leaving live lifecycle events (`status_changed` etc., `source_id` null) unconstrained. Use `check()` helper form matching company_secret_proposals.ts:50-51 if preferred over raw `sql` constraints — same literals either way.

---

## 3. Shared contract — files to touch (const → z.enum → type → DB check, hand-synced)

Per the migration-conventions map, nothing auto-links the DB `kind` CHECK to a shared enum — sync is a **code-review invariant**. Follow the SECRET_STATUSES model (constants.ts:665-666 → validators/secret.ts:121 → schema check).

1. **`packages/shared/src/constants.ts`** — single source of truth:
   ```ts
   export const ISSUE_EVENT_KINDS = [
     "created","status_changed","assignee_changed","blocker_added","blocker_cleared",
     "commented","comment_removed","approval_requested","approval_resolved",
     "thread_interaction","run_started","run_finished",
   ] as const;
   export type IssueEventKind = (typeof ISSUE_EVENT_KINDS)[number];

   export const ISSUE_EVENT_ACTOR_TYPES = ["agent","user","system","plugin"] as const;
   export type IssueEventActorType = (typeof ISSUE_EVENT_ACTOR_TYPES)[number];
   ```
2. **`packages/shared/src/validators/issue-event.ts`** (new) — `z.enum(ISSUE_EVENT_KINDS)`, `z.enum(ISSUE_EVENT_ACTOR_TYPES)`, and an `issueEventSchema` for the payload shape, mirroring validators/secret.ts:121 / validators/decision-queue.ts:4.
3. **`packages/shared/src/types/issue-event.ts`** (new) — `IssueEvent` row type + the per-kind `payload` discriminated union; re-export via **`packages/shared/src/types/index.ts`** and **`packages/shared/src/index.ts`** (barrel, per index.ts:1087 pattern) so server + ui import from `@paperclipai/shared`.
4. **`packages/db/src/schema/issue_events.ts`** — the `check()` literal list **must be a byte-for-byte copy** of `ISSUE_EVENT_KINDS` (Drizzle does not read the shared const). Export from `schema/index.ts`.
5. **`packages/shared/src/constants.ts`** LIVE type — add `"issue.event"` to `LIVE_EVENT_TYPES` (constants.ts:878-891) so `LiveEventType` accepts it (shared constant, no `db:generate` needed for the event type — §7).

To add/remove a kind: edit the step-1 const **and** the step-4 check literals in lockstep, regenerate. No test fails on drift — reviewer-enforced.

---

## 4. `appendIssueEvent(dbOrTx, {...})` — signature, tx contract, allocation

Mirror `logActivity(db, input, postCommitPublications?)` (activity-log.ts:160-229) and `addComment`'s trailing `dbOrTx` (issues.ts:8585). New file `server/src/services/issue-events.ts`.

```ts
export interface AppendIssueEventInput {
  companyId: string;
  issueId: string;
  kind: IssueEventKind;
  actorType: IssueEventActorType;
  actorId?: string | null;      // null for system
  actorRunId?: string | null;
  payload?: Record<string, unknown>;
  sourceTable?: string;
  sourceId?: string;
  at?: Date;                    // omit for live (defaults now()); backfill passes source ts
}

export async function appendIssueEvent(
  dbOrTx: Db | Tx,
  input: AppendIssueEventInput,
  postCommitPublications?: PostCommitPublication[], // deferred live emit (see §7)
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

  // Publish AFTER commit, never inside the tx (a rollback must not emit a phantom).
  const pub = () => publishLiveEvent({
    companyId: input.companyId,
    type: "issue.event",
    payload: { issueId: input.issueId, eventId: row.id, kind: input.kind,
               actorType: input.actorType, actorId: input.actorId ?? null,
               ...input.payload },
  });
  if (postCommitPublications) postCommitPublications.push(pub); else pub();
  return row;
}
```

**Transaction contract:**
- **Seq allocation: none.** `id` is `bigserial`, assigned atomically by Postgres on insert (Q2). No `SELECT max`, no counter, no retry.
- **Atomicity is the caller's choice, exactly as today's audit writes.** Pass a `tx` → the event row commits or rolls back with the mutation (the only correct mode for lifecycle events). Pass `db` → best-effort non-atomic write, matching how `logActivity(db,...)` already runs today (activity-log map risk #1). Sites that pass `db` because the service already committed are flagged in §5 and are the restructuring targets.
- **Live emit is post-commit.** For `tx` callers, `appendIssueEvent` pushes the `publishLiveEvent` thunk onto the caller's `postCommitPublications` list (the exact pattern issueService.update already threads via `postCommitActivityPublications`, issues.ts:7647); the caller flushes after commit. For `db` callers it fires inline. This prevents emitting an `issue.event` for a rolled-back row.

---

## 5. Wiring table (by domain)

`⚠ = non-transactional at the site; needs a `tx` wrapper or accept best-effort non-atomic.` `▲ = bulk/loop, one call → N events.` "Parity" = consumed by the work-timeline reader (§6); other kinds are lifecycle coverage for F/H.

### 5.1 Issues (canonical mutators — issues.ts)
| Site | file:line | in tx? | kind(s) | notes |
|---|---|---|---|---|
| `issueService.create` | issues.ts:7161 | ✅ | `created` (Parity) + initial `status_changed`/`assignee_changed` snapshot | dedup short-circuit 6964-6975 returns existing → **must not emit**. payload: `assigneeAgentId/assigneeUserId`, `parentActorId` (denormalize parent's resolved actor for delegation edge — §6). |
| `issueService.update` | issues.ts:7648 | ✅ | `status_changed`, `assignee_changed`, `blocker_added/cleared` | **THE hook.** Already reads FOR UPDATE baseline (7613) + `buildIssueChanges` diff (7780) with from/to; join its existing `db.transaction`/`postCommitActivityPublications`. status→blocked (7482-7489) = `status_changed` only. |
| `issueService.syncBlockedByIssueIds` | issues.ts:5022 | ✅ | `blocker_added`, `blocker_cleared` | delete-all+insert; diff new vs prior to classify. `create` path = all additions. Uses `dbOrTx`. |
| `issueService.checkout` | issues.ts:7984 | ⚠ | `status_changed`, `assignee_changed` | **RESTRUCTURE:** the atomic claim is a bare conditional `db.update ... WHERE inArray(status,…)` — wrap in `db.transaction` to append atomically. Two more branches: adoption 8032, stale 8098. |
| `issueService.release` | issues.ts:8318 | ✅ | `status_changed` (only if was in_progress), `assignee_changed` | FOR UPDATE 8284. |
| `issueService.adminForceRelease` | issues.ts:8364 | ✅ | `assignee_changed` (only if `clearAssignee`) | no status change; actor = system/board. |
| `pipelines` linked-cancel | pipelines.ts:4617 | ✅ ▲ | `status_changed`→cancelled | `.returning({id})` loop already present. system actor. |
| `treeControl.cancel…ForHold` | issue-tree-control.ts:875 | ✅ ▲ | `status_changed` | actor needs plumbing from route (issue-tree-control.ts:184). |
| `treeControl.restore…ForHold` | issue-tree-control.ts:978 | ✅ ▲ | `status_changed` | `input.actor` in scope; per-status loop. |
| `accessService.archiveMember` | access.ts:370 / 382 | ✅ ▲ | `status_changed`+`assignee_changed` / `assignee_changed` | `.returning({id})` present. |
| `agentsService.remove` | agents.ts:777 | ✅ ▲ | `assignee_changed` | **MISS RISK:** no `.returning()` today — add RETURNING to enumerate affected issue ids. |
| `heartbeat.enqueueWakeup` unrunnable→blocked | heartbeat.ts:17848 | ✅ | `status_changed`→blocked | in dispatch tx (17470); bypasses `update()`. |

Delegated sites (route through the canonical mutators — instrument the mutator, **do not double-emit**): status-cards.ts, decisions.ts:515, task-watchdogs.ts, issue-thread-interactions createChild, issues.ts createChild 6559 / decomposeAcceptedPlan 6750. **Out of service** (a follow-up, not covered by server append): cli/src/commands/worktree.ts, packages/db/src/seed.ts. Excluded (execution-lock/monitor/touch bookkeeping — ~28 sites listed in the issues map).

### 5.2 Comments (issue_comments)
| Site | file:line | in tx? | kind | notes |
|---|---|---|---|---|
| `issuesSvc.addComment` | issues.ts:8644 | ⚠ | `commented` (Parity) | **THE chokepoint (~30 callers).** Does not open its own tx — insert + `updatedAt` bump are two statements on `dbOrTx`. **RESTRUCTURE:** wrap addComment in a tx so the appended event is atomic on the default-`db` route callers (routes/issues.ts:9401, 11295). payload: `authorAgentId/authorUserId`; source ref = the comment id. |
| `tombstoneComment` | issues.ts:8556 | ✅ | `comment_removed` | soft-delete; actor present. |
| `removeComment` | issues.ts:8522 | ✅ | `comment_removed` | **NO actor** (hard delete) → system attribution. |
| `addStopRelayCommentIfNeeded` | issues.ts:5348 | ✅ | `commented` | **issueId = PARENT** (child.parentId), not the transitioning child — key on parent. bypasses addComment; both callers pass tx. |
| `postSystemCommentOnLinkedIssues` | pipelines.ts:1935 | ✅ ▲ | `commented` | loop; tx passed. |
| `notifyDependentWork…` | pipelines.ts:2050 | ✅ ▲ | `commented` | nested loop; tx passed. |
| `performIssueMonitorRecovery` escalate | heartbeat.ts:7675 | ⚠ | `commented` | module `db`, also skips `updatedAt` bump. |
| `enqueueWakeup` block-guard comment | heartbeat.ts:17858 | ✅ | `commented` | same dispatch tx as the status→blocked flip. |
| `writeDirtyQuarantineAuditComments` | workspace-runtime.ts:1239 / 1260 | ⚠ | `commented` | two different issues (source + claimant) in one non-tx call. |
| `addImportedComments` | issues.ts:7396 | ✅ ▲ | `commented` | **decide: suppress on import** (large fan-out) — recommend skip, backfill covers history. |

Excluded: company/agent cascade hard-deletes (companies.ts:453, agents.ts:789 — no issueId, teardown), `persistDerivedIssueCommentAttribution` (issues.ts:4539, read-path backfill, **not** an event).

### 5.3 Thread-interactions (issue_thread_interactions)
Single kind `thread_interaction`; Parity-relevant only for the resolved→`approved` mapping (§6). Owning service issue-thread-interactions.ts.
| Site | file:line | in tx? | notes |
|---|---|---|---|
| `create` (insert) | :1870 | ✅ | join tx@1847. |
| `create` (supersede prior) | :1897 | ✅ ▲ | `.returning()` N rows → N events. |
| `acceptRequestConfirmation` | :1321 | ✅ | also mutates issue (update@1368) + logActivity@1389 in-tx — the template shape. |
| `rejectRequestConfirmation` | :1441 | ⚠ | plain db.update. |
| `expireStaleRequestConfirmationTarget` (shared) | :1145 | ⚠/✅ | tx varies by caller — thread the handle consistently. |
| `submitItemVerdicts` | :2245 | ✅ | **partial**: status may stay pending — emit resolution only when `complete`. |
| bulk expiry/sweep family | :1636,1706,2364,2465,2486,2505,2572,2636 | mixed ▲ | per-row issueId; :1706/:2636 open per-row tx. |
| `withdraw/answer/cancel` | :2712,2768,2824 | mixed ⚠ | non-tx for answer/cancel. |
| **Cross-service bypass** | tool-access.ts:5554/5716, tool-gateway.ts:1508, change-consent-gate.ts:202, heartbeat.ts:6756 | ⚠ | **easy-to-miss** — write the table outside the owning service; several have no issueId in scope (need a join) → these are **not** wired in cut 1; parity gate (§6) does not consume them so they can wait for H. |

### 5.4 Approvals (approvals + issue_approvals)
issueId lives only in the `issue_approvals` junction → **fan-out 0..N**. No tx exists anywhere in this domain → every emit site needs a `db.transaction` wrapper introduced (approvals map core risk).
| Site | file:line | in tx? | kind | notes |
|---|---|---|---|---|
| create route (+link) | routes/approvals.ts:245 | ⚠ | `approval_requested` (Parity) | best emit point — real `issueIds` from `req.body.issueIds`; one event per id; may be empty. |
| agent-hire create | routes/agents.ts:2610 | ⚠ | `approval_requested` | `sourceIssueIds` fan-out. |
| tool-gateway direct | tool-gateway.ts:1693 | ⚠ | `approval_requested` | **bypasses both services**; single `session.issueId` guaranteed. Wire here or miss every tool approval. |
| approve/reject | routes/approvals.ts:296 / 404 | ⚠ | `approval_resolved` (Parity) | fan-out via `listIssuesForApproval` (299/415). |
| plugin/agents resolution paths | plugin-host-services.ts:2634, agents.ts:3375/3426, built-in-agents.ts:1535 | ⚠ | `approval_resolved` | **under-report risk** — emit inside `approvalService.approve/reject/cancel` (needs a junction lookup there) to catch all paths, or accept the route-only coverage and document the gap. |
| `link` / `linkManyForApproval` | issue-approvals.ts:110 / 135 | ⚠ ▲ | `approval_requested` | junction is where issueId is direct. |

### 5.5 Heartbeat runs (run_started / run_finished — Parity via spans)
Run spans in work-timeline come from `heartbeat_runs`, keyed on `context_snapshot->>'issueId'` (**nullable** — filter null). For E, run-lifecycle events give F/H the run signal; work-timeline's span reader can keep reading `heartbeat_runs` directly in cut 1 (see §6). If emitting:
| Site | file:line | in tx? | kind | notes |
|---|---|---|---|---|
| `claimQueuedRun` | heartbeat.ts:12495 | ⚠ | `run_started` | **primary start; bypasses `setRunStatus`** — hooking only chokepoints misses every normal start. |
| `setRunStatusFromLive` | heartbeat.ts:8868 | ⚠ | `run_finished` | emit **only when `updated===true`** (CAS may lose the race → double-fire). |
| `setRunStatus` | heartbeat.ts:8827 | ⚠ | `run_finished`/`run_started` | gate on **actual status change** — liveness patches (9088/9133) call it with unchanged status. |
| enqueueWakeup terminal cancels | heartbeat.ts:17550 / 17661 | ✅ | `run_finished` | already tx. |
| recovery service | recovery/service.ts:1705,5652,1572 | mixed ⚠ | `run_finished`/`run_event` | separate file — easy to miss. |

**Recommendation (ponytail):** run-lifecycle wiring is the largest, raciest surface and is **not required for work-timeline parity** (the reader can keep its `heartbeat_runs` span query, §6). Defer `run_started`/`run_finished` emission to the **H** milestone; ship E's cut 1 with issues + comments + approvals + interactions only.

### 5.6 Activity-log — not a wiring target
`activity_log` has no issueId column and every issue-scoped write is post-commit non-atomic (activity map risk #1). Do **not** hook `logActivity` as an event source; instead emit `issue_events` from the underlying service mutations above. The `activity_log`-derived work-timeline `assigned` events (§6) are reproduced from `issueService.update`'s `assignee_changed` events, not by mirroring activity rows.

---

## 6. Work-timeline reader rewrite

**Goal:** `loadWorkTimeline` produces the identical `WorkTimelineResult` (packages/shared/src/types/work-timeline.ts) reading `issue_events` instead of the 6-table re-derivation (work-timeline.ts:534-660).

**Keep unchanged:** issue paging (`sortedIssues` createdAt DESC → slice → `readableIssueIds`, :470-475) and `pagination`/`window` (:100-115). The reader still pages the **issue set** first, then loads that page's events — never paginates events (parity map, pagination section).

**Kind → output mapping** (one query: `SELECT * FROM issue_events WHERE company_id=? AND issue_id IN readableIssueIds AND kind IN (...) ORDER BY id`):

| issue_events kind | work-timeline output | source of `at` / fields |
|---|---|---|
| `created` | `Event{creator,'created'}` + assignment edge (if assignee) + delegation edge/event (if `parentActorId != assignee`) | `payload.parentActorId` denormalized at emit (removes the cross-row parent lookup, parity-risk #4) |
| `commented` | `Event{author,'commented'}` | filter is automatic — soft-deleted comments never produced a live event and are excluded from backfill via `deletedAt` (parity-risk #6) |
| `approval_requested` + `approval_resolved` | **collapse to one** `Event{decider??requester,'approved'}` at `resolvedAt??requestedAt` | reproduces work-timeline's single 'approved' per approval keyed on resolution-or-creation (:694-709). Pending approval = only `approval_requested` exists → emit at `createdAt`. |
| `thread_interaction` (resolved) | `Event{resolver??creator,'approved'}` at `resolvedAt??createdAt` | same 'approved' kind as approvals, no distinguishing field (parity-risk #7) — preserve by emitting from both sources in source-precedence order |
| `assignee_changed` | `Event{actor,'assigned'}` + assignment edge (if target resolvable) | reproduces the `activity_log action.includes('assign')` path (:730-747); target from `payload.assigneeAgentId/assigneeUserId` |

**Run spans:** keep the existing `heartbeat_runs` span query (work-timeline.ts:534-581) verbatim in cut 1 — E does not need to move spans to be a work-timeline replacement, and the run-events surface is deferred to H (§5.5). Spans dedup/overlap logic (parity-risks #2/#5) stays where it already correctly lives.

**Actor set:** built by iterating `issue_events` in `id` order (which encodes source-precedence via Q3 backfill), then run agents, reproducing the Set-insertion order (parity-risks #10). The activity-log "actor-only side effect" (every in-window issue activity row contributes an actor even with no event, parity-risk #3): covered because `assignee_changed`/`status_changed`/`commented` events already surface those actors; verify in the parity test and add a synthetic actor-contribution pass if any actor is dropped.

**Concrete parity test** (`server/src/services/__tests__/work-timeline-parity.test.ts`):
```
for each sample company (pick ~10 with rich history):
  for offset in [0, limit, 2*limit]:
    old = loadWorkTimelineFromSixTables(company, page)   // current impl, frozen as oracle
    new = loadWorkTimelineFromEvents(company, page)       // derived reader
    assert deepEqual(old, new)   // actors[], spans[], events[], edges[], pagination, window
```
Run it against a backfilled DB. Any diff names the exact issue + missing/extra entry → points at an un-wired site from §5. Iterate wiring until the diff is empty for all samples; that empty diff **is the flip gate** (§8). One runnable check, no framework beyond the existing test harness.

---

## 7. Emit-on-append (live, for F/H)

Copy the `heartbeat.run.event` pattern exactly (heartbeat.ts:9646-9677 — insert row, then immediately `publishLiveEvent`), but fire **post-commit** via the `postCommitPublications` list (§4) so a rollback emits nothing.

- **New LIVE type:** add `"issue.event"` to `LIVE_EVENT_TYPES` (constants.ts:878-891). Shared constant, both server and ui import `LiveEventType` from `@paperclipai/shared` — no `db:generate`, no DB enum.
- **Payload is flat** `Record<string,unknown>`: `{ issueId, eventId (the durable bigserial id), kind, actorType, actorId, ...payload }`. **The durable id goes in `payload.eventId`, never in `LiveEvent.id`** (that field is the volatile in-process `nextEventId`, live-events.ts:10 — useless as a cursor).
- **Scope:** `publishLiveEvent({ companyId: issue.companyId, type: "issue.event", payload })`. Dispatch is company-scoped (live-events.ts:33; one WS per company, live-events-ws.ts:230). There is no issue-level server filter, so **F/H filter by `payload.issueId` client-side** (`useCompanyLiveEvent((e) => e.type==='issue.event' && e.payload.issueId===id)`).
- **No replay today** (live-events map `replayExistsToday:false`). F builds replay on top of the `bigserial id` cursor: `GET issue timeline WHERE id > lastSeenId`. Until F lands, F/H must refetch on mount/reconnect (mirroring LiveUpdatesProvider.tsx:1391-1393) — E just guarantees the durable row + best-effort live nudge.

---

## 8. Migration + rollout (dual-write behind a flag → backfill → parity gate → flip reads)

Precedent to copy end-to-end: **issue-reference mentions** (dual-write projection + one-time per-company backfill) — scripts/backfill-issue-reference-mentions.ts, `syncAllForCompany` (issue-references.ts:333), `syncX(recordId, dbOrTx?)` called from write paths with an optional tx, documented contract in DATABASE.md ("migration creates the table but does NOT backfill; future writes sync automatically").

**Step 1 — Author schema + shared contract.**
Edit `packages/db/src/schema/issue_events.ts` (§2) + export; edit the shared const/validator/type (§3). Then `pnpm db:generate` → runs `check:migrations` (numbering + safety) → `tsc` (compiles to dist/schema/*.js, which drizzle-kit diffs) → `drizzle-kit generate` emits `packages/db/src/migrations/NNNN_*.sql` (additive `CREATE TABLE` + indexes; model = 0213_real_forge.sql).
**✔ Checkpoint:** `pnpm -r typecheck` passes; the generated SQL is a pure additive `CREATE TABLE` + indexes with **no** mutation of existing tables (safety check passes because the table is new/empty). `pnpm db:migrate`; confirm the table exists.

**Step 2 — Dual-write behind a flag.**
Add `appendIssueEvent` (§4) and wire the §5 canonical sites (issues create/update/checkout/release/syncBlockedBy; addComment; approval create+resolve routes+tool-gateway; thread-interaction resolutions). Gate every emit on `env.ISSUE_EVENTS_DUAL_WRITE` (default off). Restructure the ⚠ sites: wrap `checkout` (issues.ts:7984) and `addComment` (issues.ts:8644) in `db.transaction`; add `.returning()` to agents.ts:777. Authoritative tables are untouched — `issue_events` is a pure projection.
**✔ Checkpoint:** with the flag on in a dev DB, exercise each write path; assert one `issue_events` row per mutation with correct actor/issueId; assert **no double-emit** from delegated sites; assert rollback (force a tx error) leaves no event row and emits no live event.

**Step 3 — Historical backfill (idempotent, resumable).**
`scripts/backfill-issue-events.ts` + root script `issue-events:backfill`, looping companies (`--company <id>`), each calling a `syncAllForCompany`-style rebuild. For each company, `INSERT ... ON CONFLICT (source_table, source_id, kind) DO NOTHING` from the five work-timeline sources, **ordered by `created_at ASC, source-precedence, source_id`** (Q3) so `id` order matches timeline order. Idempotency = the partial unique index (§2); resumability = per-company loop, safe to re-run (conflict rows skipped). `createdAt` set to the source timestamp (approvals: `decidedAt??createdAt` for `approval_resolved`, `createdAt` for `approval_requested`).
**✔ Checkpoint:** row counts per kind reconcile against `SELECT count(*)` of each source (comments minus soft-deleted, etc.); re-running the backfill inserts zero new rows (idempotent); spot-check one issue's events vs its work-timeline output.

**Step 4 — Parity gate.**
Run the §6 parity test (derived reader vs the frozen 6-table oracle) across sample companies × pages. Fix wiring/backfill until the diff is empty. **The empty diff is the gate — do not flip reads until it holds.**
**✔ Checkpoint:** parity test green for all samples; CI job added so it stays green while both paths coexist.

**Step 5 — Flip reads.**
Behind a second flag `ISSUE_EVENTS_READ`, switch `loadWorkTimeline` to the derived reader. Ship with both flags on; keep the 6-table code path one release as fallback. Point F/H at `issue.event` + the `id` cursor.
**✔ Checkpoint:** production work-timeline responses match the shadow (old) path for a sampling window; then remove the old query and the flags in a follow-up.

---

## 9. Effort / sequence & scope boundary

**Sequence:** (1) schema + shared contract [~0.5d]; (2) `appendIssueEvent` + wire the ~12 canonical issue/comment sites + restructure the 2 ⚠ chokepoints [~2d]; (3) approvals fan-out + interaction resolutions [~1.5d]; (4) backfill script [~1d]; (5) derived reader + parity test, iterate to green [~2–3d]; (6) flip behind flags [~0.5d]. Roughly **1.5–2 weeks** for cut 1.

**In scope for E:** `issue_events` table; `appendIssueEvent`; dual-write on the canonical issue/comment/approval/interaction sites; backfill; work-timeline reader replacement + parity gate; `issue.event` live emit.

**Explicitly out of scope (later items):**
- **F (replayable WS cursor):** builds on E's `bigserial id` cursor + `GET events WHERE id > lastSeen`. E only guarantees the durable row and best-effort nudge.
- **H (fine-grained live feed):** the full `run_started`/`run_finished`/`run_event` surface (§5.5) and the cross-service thread-interaction bypass sites (§5.3) — the raciest, highest-volume wiring, deferred because work-timeline parity doesn't need them.
- **G / J:** not touched.
- **CLI + seed** event emission (worktree.ts, seed.ts) — separate process, not covered by a server-side helper.
- **Bulk import** `comment_added` (issues.ts:7396) — suppressed on import; backfill owns history.

---

## 10. Residual risks + human decisions before coding

**Human must decide:**
1. **Cut-1 kind set.** Confirm shipping issues + comments + approvals + interactions and **deferring run-lifecycle to H** is acceptable (the schema CHECK already reserves `run_started`/`run_finished` so no later migration is needed to add them).
2. **`blocker_added/cleared` semantics.** The dependency-relation blocker (`issue_relations 'blocks'`, syncBlockedByIssueIds) vs the `status=='blocked'` transition are *different notions* (issues map ambiguity #1). Decide whether the event kind targets relations, status, or both. Work-timeline consumes neither, so this is an F/H concern — but it fixes the payload schema now.
3. **Approval resolution coverage.** Emit `approval_resolved` from the **routes** (misses plugin/agents/built-in paths) or push into `approvalService` (catches all but needs a junction lookup + loses route actor fidelity). Recommend service-layer emission with a `listIssuesForApproval` fan-out; confirm.
4. **PHI check (per CLAUDE.md).** `payload` deliberately excludes bodies (Q1), but `actorId`, `issueId`, and denormalized ids are still user-linked data written to a new table read by the timeline. Confirm the field set before coding — the reference-only design keeps sensitive text out, which is the intended posture.

**Residual technical risks:**
- **Un-wired bulk/bypass sites under-report** until parity catches them — mitigated because the §6 parity gate fails loudly per-issue, but only for the *work-timeline-consumed* kinds; F/H-only kinds (interactions, runs) have **no parity oracle**, so their coverage rests on code review of the site lists, not a test.
- **`addComment`/`checkout` tx wrapping** changes their concurrency shape (now hold a transaction across the insert + `updatedAt` bump). Low risk (both already do multi-statement writes) but must be load-checked — flag if either is on a hot path.
- **Double-emit** from delegated sites (status-cards, decisions, createChild) if someone wires both the mutator and the wrapper — enforce "instrument the canonical mutator only" as a review rule.
- **Backfill volume** on large companies — the partial unique index + per-company chunked loop (issue-references precedent) keeps it resumable, but run off-peak and watch the migration-safety baseline for any large-table index warning.
- **`activity_log` actor-only contributions** (parity-risk #3) are the most likely source of a stubborn parity diff; budget time for a synthetic actor pass if `assignee_changed`/`commented` events don't surface every actor the old path did.