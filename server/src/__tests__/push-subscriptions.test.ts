import express from "express";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "@paperclipai/db";
import { pushSubscriptionService } from "../services/push-subscriptions.js";
import { pushSubscriptionRoutes } from "../routes/push-subscriptions.js";
import { errorHandler } from "../middleware/index.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

function sub(endpoint: string, tag: string) {
  return { endpoint, p256dh: `p256dh-${tag}`, auth: `auth-${tag}` };
}

describeEmbeddedPostgres("push subscriptions", () => {
  const ctx = useEmbeddedPostgres("paperclip-push-subscriptions-", {
    resetEach: async (db) => {
      await db.delete(pushSubscriptions);
      await resetCompanyIssueFixtures(db);
    },
  });

  afterEach(async () => {
    await ctx.db.delete(pushSubscriptions);
  });

  it("scopes list and upsert to (company, user) and dedupes by endpoint", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push scope");
    const svc = pushSubscriptionService(ctx.db);
    const other = "user-other";

    await svc.upsert(companyId, userId, sub("https://push.example/a", "a"));
    await svc.upsert(companyId, other, sub("https://push.example/b", "b"));
    // Same endpoint again with new keys → upsert, not a duplicate row.
    await svc.upsert(companyId, userId, { ...sub("https://push.example/a", "a2"), userAgent: "iPhone" });

    const mine = await svc.list(companyId, userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].endpoint).toBe("https://push.example/a");
    expect(mine[0].p256dh).toBe("p256dh-a2"); // updated
    expect(mine[0].userAgent).toBe("iPhone");

    // The other user's subscription never leaks into my list.
    expect(mine.map((r) => r.endpoint)).not.toContain("https://push.example/b");
    const theirs = await svc.list(companyId, other);
    expect(theirs).toHaveLength(1);
  });

  it("removeByEndpoint only deletes the caller's own subscription", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push delete");
    const svc = pushSubscriptionService(ctx.db);
    const other = "user-attacker";
    const endpoint = "https://push.example/victim";

    await svc.upsert(companyId, userId, sub(endpoint, "v"));

    // Attacker knows the endpoint but cannot remove another user's subscription.
    const stolen = await svc.removeByEndpoint(companyId, other, endpoint);
    expect(stolen).toBeNull();
    expect(await svc.list(companyId, userId)).toHaveLength(1);

    // The owner can.
    const removed = await svc.removeByEndpoint(companyId, userId, endpoint);
    expect(removed?.endpoint).toBe(endpoint);
    expect(await svc.list(companyId, userId)).toHaveLength(0);
  });

  it("supports the board subscribe → list → unsubscribe round trip over HTTP", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Push http");
    const app = routeApp(ctx.db, actor, pushSubscriptionRoutes);
    const endpoint = "https://push.example/http";

    const created = await request(app)
      .post(`/api/companies/${companyId}/push-subscriptions`)
      .send({ endpoint, keys: { p256dh: "pub", auth: "sec" }, userAgent: "Pixel" });
    expect(created.status).toBe(201);

    const listed = await request(app).get(`/api/companies/${companyId}/push-subscriptions`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].endpoint).toBe(endpoint);

    const removed = await request(app)
      .delete(`/api/companies/${companyId}/push-subscriptions`)
      .send({ endpoint });
    expect(removed.status).toBe(204);

    const empty = await request(app).get(`/api/companies/${companyId}/push-subscriptions`);
    expect(empty.body).toHaveLength(0);
  });

  it("rejects a non-board (agent) actor with 403", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Push agent deny");
    const agentActor = { type: "agent", source: "agent-key", companyId, agentId: "agent-x" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = agentActor;
      next();
    });
    app.use("/api", pushSubscriptionRoutes(ctx.db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/push-subscriptions`)
      .send({ endpoint: "https://push.example/x", keys: { p256dh: "a", auth: "b" } });
    expect(res.status).toBe(403);
  });
});
