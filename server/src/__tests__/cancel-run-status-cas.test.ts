import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Regression coverage for the cancel-vs-finalize TOCTOU: cancelRunInternal /
// cancelActiveForAgentInternal used to write the terminal "cancelled" status
// with an UNCONDITIONAL update. The cancellable snapshot they read can go stale
// while they await (getAgent, process terminate), so a run that finalized on its
// own — the finalize path CAS-writes "succeeded"/"failed" from "running" — would
// be clobbered back to "cancelled" and wrongly released/re-promoted. The fix
// makes the terminal write a compare-and-set from the cancellable statuses.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cancel-run-status-cas tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cancel run status compare-and-set", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancel-cas-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "CEO") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(companyId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
    });
    return issueId;
  }

  async function seedRunningRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "ceo", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    return runId;
  }

  // Mirror the finalize path's compare-and-set: "running" -> "succeeded". Returns
  // the number of rows it actually updated, so a caller can tell whether it won.
  async function finalizeToSucceededCas(runId: string) {
    return db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")))
      .returning();
  }

  async function statusOf(runId: string) {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row?.status ?? null;
  }

  it("cancels a running run and releases its issue execution lock (happy path)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId);
    const runId = await seedRunningRun(companyId, agentId, issueId);

    await heartbeatService(db).cancelRun(runId);

    expect(await statusOf(runId)).toBe("cancelled");
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfter?.executionRunId).toBeNull();
    expect(issueAfter?.executionLockedAt).toBeNull();
  });

  it("cancelRun never clobbers a run the finalize path wins the race for", async () => {
    // Airtight invariant on the fixed code: whenever the finalize CAS matched a
    // row (it moved running -> succeeded), cancelRun's CAS-from-cancellable must
    // have matched nothing, so the terminal status stays "succeeded". The old
    // unconditional write would relabel it "cancelled" whenever the finalize
    // landed inside cancelRun's stale window, so this fails pre-fix. Looped
    // because the interleaving that trips the old code is timing-dependent; the
    // fixed code satisfies the invariant on every interleaving.
    const svc = heartbeatService(db);
    for (let i = 0; i < 25; i++) {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId);
      const runId = await seedRunningRun(companyId, agentId, issueId);

      const [, finalizeRows] = await Promise.all([
        svc.cancelRun(runId).catch(() => null),
        finalizeToSucceededCas(runId),
      ]);

      const finalStatus = await statusOf(runId);
      if (finalizeRows.length === 1) {
        expect(finalStatus).toBe("succeeded");
      } else {
        // cancel won the CAS first; a terminal "cancelled" is the correct outcome.
        expect(finalStatus).toBe("cancelled");
      }
    }
  });

  it("cancelActiveForAgent never clobbers a run the finalize path wins the race for", async () => {
    // Same invariant for the agent-pause batch path (cancelActiveForAgentInternal),
    // whose per-run write shared the identical unconditional-clobber bug.
    const svc = heartbeatService(db);
    for (let i = 0; i < 25; i++) {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId);
      const runId = await seedRunningRun(companyId, agentId, issueId);

      const [, finalizeRows] = await Promise.all([
        svc.cancelActiveForAgent(agentId).catch(() => null),
        finalizeToSucceededCas(runId),
      ]);

      const finalStatus = await statusOf(runId);
      if (finalizeRows.length === 1) {
        expect(finalStatus).toBe("succeeded");
      } else {
        expect(finalStatus).toBe("cancelled");
      }
    }
  });
});
