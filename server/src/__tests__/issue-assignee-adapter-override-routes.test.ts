import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, agentTaskSessions, companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { listServerAdapters } from "../adapters/registry.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { getBuiltInAgentDefinition } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// An adapter this instance actually runs (clears the floor) but which the
// "briefs" built-in is NOT allowed to use — so only the built-in allowlist
// (layer 2) can reject it. Computed from the live registry so the test holds
// under any adapter curation (pi_local, codex_local, etc. may be disabled).
const BRIEFS_ALLOWED = new Set(getBuiltInAgentDefinition("briefs")?.allowedAdapterTypes ?? []);
const DISABLED_ADAPTERS = new Set(getDisabledAdapterTypes());
const ENABLED_NOT_ALLOWED_FOR_BRIEFS = listServerAdapters()
  .map((a) => a.type)
  .find((t) => !DISABLED_ADAPTERS.has(t) && !BRIEFS_ALLOWED.has(t));
// The mirror: an enabled adapter that the "briefs" built-in IS allowed to use.
const ENABLED_ALLOWED_FOR_BRIEFS = listServerAdapters()
  .map((a) => a.type)
  .find((t) => !DISABLED_ADAPTERS.has(t) && BRIEFS_ALLOWED.has(t));

// Phase 1 (model/adapter coherence): declare a deterministic model list for one
// enabled adapter (via PAPERCLIP_ADAPTER_MODELS, set in beforeAll) so the model
// check has a known-good id and a known-bad id to validate against without a
// live CLI. FLOOR_OK_ADAPTER passes the instance floor.
const FLOOR_OK_ADAPTER = listServerAdapters().map((a) => a.type).find((t) => !DISABLED_ADAPTERS.has(t));
const DECLARED_MODEL_ID = "phase1-valid-model";
const UNKNOWN_MODEL_ID = "__no_such_model__";

// Phase 2 (cross-adapter session cleanup): two distinct enabled adapters to
// swap between. Both clear the instance floor; a regular assignee has no
// allowlist, so the swap is accepted and the clear runs.
const ENABLED_ADAPTERS = listServerAdapters().map((a) => a.type).filter((t) => !DISABLED_ADAPTERS.has(t));
const SWAP_FROM_ADAPTER = ENABLED_ADAPTERS[0];
const SWAP_TO_ADAPTER = ENABLED_ADAPTERS.find((t) => t !== SWAP_FROM_ADAPTER);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue assignee adapter override tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// G (per-issue runner override) write-time authority gate. A per-issue
// adapterType reroutes the assignee's whole runner, so it is validated at
// create/update time: it must be a known + enabled adapter on this instance,
// and — when the assignee is a built-in agent — must stay inside that agent's
// allowedAdapterTypes. Both rejection paths short-circuit before svc.create.
describeEmbeddedPostgres("issue assignee adapterType override gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let priorAdapterModelsEnv: string | undefined;

  beforeAll(async () => {
    priorAdapterModelsEnv = process.env.PAPERCLIP_ADAPTER_MODELS;
    if (FLOOR_OK_ADAPTER) {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        [FLOOR_OK_ADAPTER]: [{ id: DECLARED_MODEL_ID, label: "Phase 1 valid model" }],
      });
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-adapter-override-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (priorAdapterModelsEnv === undefined) delete process.env.PAPERCLIP_ADAPTER_MODELS;
    else process.env.PAPERCLIP_ADAPTER_MODELS = priorAdapterModelsEnv;
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id") ?? "cloud-user-1";
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: userId }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithOwner(companyId: string, userId = "cloud-user-1") {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("rejects an override onto an adapter this instance does not know", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await seedCompanyWithOwner(companyId);
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Route onto a bogus runner",
        assigneeAgentId,
        assigneeAdapterOverrides: { adapterType: "totally_not_an_adapter" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain("Unknown adapter type: totally_not_an_adapter");
  });

  it.skipIf(!ENABLED_NOT_ALLOWED_FOR_BRIEFS)(
    "rejects an override outside a built-in assignee's allowedAdapterTypes",
    async () => {
      const overrideType = ENABLED_NOT_ALLOWED_FOR_BRIEFS!;
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      await seedCompanyWithOwner(companyId);
      // "briefs" is a built-in definition with an allowedAdapterTypes list. The
      // override adapter is enabled on this instance (clears the floor) but not
      // in that list, so only the built-in allowlist can reject it.
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "Briefs",
        role: "analyst",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] } },
      });

      const res = await request(createApp(companyId))
        .post(`/api/companies/${companyId}/issues`)
        .send({
          title: "Escalate a built-in onto a disallowed runner",
          assigneeAgentId,
          assigneeAdapterOverrides: { adapterType: overrideType },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code ?? res.body.details?.code).toBe("issue_assignee_adapter_override_not_allowed");
    },
  );

  it.skipIf(!FLOOR_OK_ADAPTER)(
    "Phase 1: rejects an override whose adapterConfig.model is unknown for the target adapter",
    async () => {
      const adapter = FLOOR_OK_ADAPTER!;
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      await seedCompanyWithOwner(companyId);
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: adapter,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const res = await request(createApp(companyId))
        .post(`/api/companies/${companyId}/issues`)
        .send({
          title: "Swap onto a model the adapter cannot run",
          assigneeAgentId,
          assigneeAdapterOverrides: { adapterType: adapter, adapterConfig: { model: UNKNOWN_MODEL_ID } },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code ?? res.body.details?.code).toBe("issue_assignee_adapter_override_model_unknown");
      expect(res.body.details?.availableModelIds ?? []).toContain(DECLARED_MODEL_ID);
    },
  );

  it.skipIf(!FLOOR_OK_ADAPTER)(
    "Phase 1: rejects a swap that inherits a model the target adapter cannot run",
    async () => {
      const adapter = FLOOR_OK_ADAPTER!;
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      await seedCompanyWithOwner(companyId);
      // Agent configured with a model that is NOT in the target adapter's list.
      // The override supplies only adapterType (no model, no profile), so the
      // gate must validate the INHERITED model against the target adapter.
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: adapter,
        adapterConfig: { model: UNKNOWN_MODEL_ID },
        runtimeConfig: {},
        permissions: {},
      });

      const res = await request(createApp(companyId))
        .post(`/api/companies/${companyId}/issues`)
        .send({
          title: "Swap that inherits an incoherent model",
          assigneeAgentId,
          assigneeAdapterOverrides: { adapterType: adapter },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code ?? res.body.details?.code).toBe("issue_assignee_adapter_override_model_unknown");
    },
  );

  it.skipIf(!ENABLED_NOT_ALLOWED_FOR_BRIEFS)(
    "Phase 1: a modelProfile-only override skips model coherence (reaches the allowlist check)",
    async () => {
      const overrideType = ENABLED_NOT_ALLOWED_FOR_BRIEFS!;
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      await seedCompanyWithOwner(companyId);
      // Built-in "briefs" agent with an incoherent literal model. The override
      // sets a modelProfile (which resolves per-adapter at run time), so the
      // model check must be SKIPPED — flow reaches the allowlist and 403s on the
      // disallowed adapter rather than 422-ing on the inherited model.
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "Briefs",
        role: "analyst",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: { model: UNKNOWN_MODEL_ID },
        runtimeConfig: {},
        permissions: {},
        metadata: { paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] } },
      });

      const res = await request(createApp(companyId))
        .post(`/api/companies/${companyId}/issues`)
        .send({
          title: "Profile override must not trip the model check",
          assigneeAgentId,
          assigneeAdapterOverrides: { adapterType: overrideType, modelProfile: "cheap" },
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code ?? res.body.details?.code).toBe("issue_assignee_adapter_override_not_allowed");
    },
  );

  it.skipIf(!ENABLED_NOT_ALLOWED_FOR_BRIEFS)(
    "Phase 3: auto-strips a persisted adapter pin when the issue is reassigned without a new override",
    async () => {
      const pinnedAdapter = ENABLED_NOT_ALLOWED_FOR_BRIEFS!;
      const companyId = randomUUID();
      const agentA = randomUUID();
      const agentB = randomUUID();
      const issueId = randomUUID();
      await seedCompanyWithOwner(companyId);
      // A is a regular agent (any enabled adapter is fine for it); B is the
      // built-in "briefs" that MUST NOT run pinnedAdapter. The persisted pin was
      // authorized against A; reassigning to B without a new override must strip
      // it, not let B silently run the disallowed adapter.
      await db.insert(agents).values([
        {
          id: agentA, companyId, name: "A", role: "engineer", status: "active",
          adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
        },
        {
          id: agentB, companyId, name: "Briefs B", role: "analyst", status: "active",
          adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
          metadata: { paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] } },
        },
      ]);
      await db.insert(issues).values({
        id: issueId, companyId, title: "Pinned to A's runner", status: "backlog", priority: "medium",
        assigneeAgentId: agentA, assigneeAdapterOverrides: { adapterType: pinnedAdapter },
      });

      const res = await request(createApp(companyId))
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeAgentId: agentB });

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const row = await db
        .select({ overrides: issues.assigneeAdapterOverrides, assignee: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(row?.assignee).toBe(agentB);
      // Override was adapterType-only, so stripping it empties the object -> null.
      expect(row?.overrides).toBeNull();
    },
  );

  it.skipIf(!ENABLED_ALLOWED_FOR_BRIEFS)(
    "Phase 3: preserves an override the same PATCH explicitly supplies for the new assignee",
    async () => {
      const newAdapter = ENABLED_ALLOWED_FOR_BRIEFS!;
      const companyId = randomUUID();
      const agentA = randomUUID();
      const agentB = randomUUID();
      const issueId = randomUUID();
      await seedCompanyWithOwner(companyId);
      await db.insert(agents).values([
        {
          id: agentA, companyId, name: "A", role: "engineer", status: "active",
          adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
        },
        {
          id: agentB, companyId, name: "Briefs B", role: "analyst", status: "active",
          adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
          metadata: { paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] } },
        },
      ]);
      await db.insert(issues).values({
        id: issueId, companyId, title: "Reassign with a fresh override", status: "backlog", priority: "medium",
        assigneeAgentId: agentA, assigneeAdapterOverrides: { adapterType: "claude_local" },
      });

      // Explicit new override in the same PATCH is respected (and gate-validated
      // against B), NOT auto-stripped.
      const res = await request(createApp(companyId))
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeAgentId: agentB, assigneeAdapterOverrides: { adapterType: newAdapter } });

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const row = await db
        .select({ overrides: issues.assigneeAdapterOverrides })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect((row?.overrides as { adapterType?: string } | null)?.adapterType).toBe(newAdapter);
    },
  );

  it.skipIf(!SWAP_FROM_ADAPTER || !SWAP_TO_ADAPTER)(
    "Phase 2: a same-agent adapter swap clears the issue's task sessions across adapters, scoped to that issue",
    async () => {
      const fromAdapter = SWAP_FROM_ADAPTER!;
      const toAdapter = SWAP_TO_ADAPTER!;
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const otherTaskKey = randomUUID();
      await seedCompanyWithOwner(companyId);
      await db.insert(agents).values({
        id: agentId, companyId, name: "A", role: "engineer", status: "active",
        adapterType: fromAdapter, adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      await db.insert(issues).values({
        id: issueId, companyId, title: "Swap the runner", status: "backlog", priority: "medium",
        assigneeAgentId: agentId, assigneeAdapterOverrides: { adapterType: fromAdapter },
      });
      // Two sessions for THIS issue (the pinned adapter + a stray prior adapter),
      // and one for an unrelated taskKey that must survive the scoped clear.
      await db.insert(agentTaskSessions).values([
        { companyId, agentId, adapterType: fromAdapter, taskKey: issueId },
        { companyId, agentId, adapterType: "process", taskKey: issueId },
        { companyId, agentId, adapterType: fromAdapter, taskKey: otherTaskKey },
      ]);

      const res = await request(createApp(companyId))
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeAdapterOverrides: { adapterType: toAdapter } });

      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const rows = await db
        .select({ taskKey: agentTaskSessions.taskKey, adapterType: agentTaskSessions.adapterType })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.agentId, agentId));
      // Every session for the swapped issue is gone (across adapters)...
      expect(rows.filter((r) => r.taskKey === issueId)).toHaveLength(0);
      // ...but the unrelated task session is untouched (blast radius scoped).
      expect(rows.filter((r) => r.taskKey === otherTaskKey)).toHaveLength(1);
    },
  );
});
