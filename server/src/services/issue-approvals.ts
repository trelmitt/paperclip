import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import {
  appendIssueEvent,
  flushIssueEventPublications,
  issueEventsDualWriteEnabled,
  resolveApprovalEventActor,
  resolveIssueEventActor,
  type IssueEventPublication,
} from "./issue-events.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string) {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueAndApprovalSameCompany(issueId: string, approvalId: string) {
    const issue = await getIssue(issueId);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");

    if (issue.companyId !== approval.companyId) {
      throw unprocessable("Issue and approval must belong to the same company");
    }

    return { issue, approval };
  }

  // Emit the link's lifecycle events. Always `approval_requested` at createdAt,
  // attributed to the requester. The reader collapses request+resolve into
  // work-timeline's single `approved`; a still-pending approval surfaces via the
  // request event alone (stamped at createdAt).
  //
  // If the approval was ALREADY decided when this link was created (an issue linked
  // to a resolved approval), approvalService's resolve-time fan-out ran before this
  // junction row existed, so also emit `approval_resolved` here — otherwise E5 would
  // stamp `approved` at createdAt instead of the decision's decidedAt.
  async function emitApprovalLinkEvents(
    companyId: string,
    issueId: string,
    approval: typeof approvals.$inferSelect,
  ) {
    const requestedActor = resolveIssueEventActor(approval.requestedByAgentId, approval.requestedByUserId);
    // source ref is the (issue, approval) link, not the approval — an approval fans
    // out to N issues, so keying on approvalId alone would collide.
    const sourceId = `${issueId}:${approval.id}`;
    // Backlog H: both callers run this after their autocommit `db` write has committed
    // (link's insert, linkManyForApproval's insert), so emit live — request and resolve
    // share one list flushed at the end.
    const pubs: IssueEventPublication[] = [];
    await appendIssueEvent(db, {
      companyId,
      issueId,
      kind: "approval_requested",
      actorType: requestedActor.actorType,
      actorId: requestedActor.actorId,
      sourceTable: "issue_approvals",
      sourceId,
      payload: { approvalId: approval.id, approvalType: approval.type, status: approval.status },
      at: approval.createdAt ?? undefined,
    }, pubs);
    if (approval.decidedAt) {
      const resolvedActor = resolveApprovalEventActor(approval);
      await appendIssueEvent(db, {
        companyId,
        issueId,
        kind: "approval_resolved",
        actorType: resolvedActor.actorType,
        actorId: resolvedActor.actorId,
        sourceTable: "issue_approvals",
        sourceId,
        payload: { approvalId: approval.id, status: approval.status, decisionNote: approval.decisionNote ?? null },
        at: approval.decidedAt ?? undefined,
      }, pubs);
    }
    flushIssueEventPublications(pubs);
  }

  return {
    listApprovalsForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const result = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
        .orderBy(desc(issueApprovals.createdAt));
      return result.map((approval) => ({
        ...approval,
        payload: redactEventPayload(approval.payload) ?? {},
      }));
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      const { issue, approval } = await assertIssueAndApprovalSameCompany(issueId, approvalId);

      await db
        .insert(issueApprovals)
        .values({
          companyId: issue.companyId,
          issueId,
          approvalId,
          linkedByAgentId: actor?.agentId ?? null,
          linkedByUserId: actor?.userId ?? null,
        })
        .onConflictDoNothing();

      if (issueEventsDualWriteEnabled()) {
        await emitApprovalLinkEvents(issue.companyId, issueId, approval);
      }

      return db
        .select()
        .from(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
        .then((rows) => rows[0] ?? null);
    },

    unlink: async (issueId: string, approvalId: string) => {
      const { issue } = await assertIssueAndApprovalSameCompany(issueId, approvalId);
      const [removed] = await db
        .delete(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
        .returning();

      // Retraction (backlog E6): the approval_requested/_resolved events stay in the
      // append-only log, but work-timeline drops the `approved` once the junction row
      // is gone (it inner-joins issue_approvals). Emit `approval_unlinked` on the SAME
      // (issue_approvals, `${issueId}:${approvalId}`) key so the derived reader
      // suppresses the collapsed `approved` and the read-flip stays byte-identical.
      // Only when a link was actually removed — nothing to retract otherwise.
      //
      // ponytail: append-only ceiling — unlink, then re-link the SAME (issue,approval)
      // leaves this `approval_unlinked` in the log while the re-link's approval_requested
      // is idempotency-skipped (partial unique index on source_table/source_id/kind), so
      // the log-read keeps suppressing an approval the mutable view now shows again. This
      // IS reachable (POST /issues/:id/approvals re-links after a DELETE unlink) — a
      // proper fix needs an `approval_relinked` kind + reader recency, disproportionate
      // for a rare manual sequence. Same class as the interaction-reopen residual in
      // appendInteractionRowEvents; a documented log-authoritative divergence (see
      // issue-events-timeline.ts KNOWN DIVERGENCES), not chased to byte-identity.
      if (removed && issueEventsDualWriteEnabled()) {
        // Backlog H: autocommit `db` — the delete above is durable, emit live post-commit.
        const pubs: IssueEventPublication[] = [];
        await appendIssueEvent(db, {
          companyId: issue.companyId,
          issueId,
          kind: "approval_unlinked",
          actorType: "system",
          actorId: null,
          sourceTable: "issue_approvals",
          sourceId: `${issueId}:${approvalId}`,
          payload: { approvalId },
        }, pubs);
        flushIssueEventPublications(pubs);
      }
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return;

      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const uniqueIssueIds = Array.from(new Set(issueIds));
      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(inArray(issues.id, uniqueIssueIds));

      if (rows.length !== uniqueIssueIds.length) {
        throw notFound("One or more issues not found");
      }

      for (const row of rows) {
        if (row.companyId !== approval.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
      }

      await db
        .insert(issueApprovals)
        .values(
          uniqueIssueIds.map((issueId) => ({
            companyId: approval.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })),
        )
        .onConflictDoNothing();

      if (issueEventsDualWriteEnabled()) {
        for (const row of rows) {
          await emitApprovalLinkEvents(row.companyId, row.id, approval);
        }
      }
    },
  };
}
