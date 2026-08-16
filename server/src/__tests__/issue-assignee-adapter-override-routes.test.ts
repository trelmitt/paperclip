import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-adapter-override-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
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
});
