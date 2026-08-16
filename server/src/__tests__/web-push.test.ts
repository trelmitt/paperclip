import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { pushSubscriptions } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn<(sub: unknown, payload: string, opts: unknown) => Promise<unknown>>(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "pub-key", privateKey: "priv-key" })),
}));

vi.mock("web-push", () => ({
  default: { sendNotification: mocks.sendNotification, generateVAPIDKeys: mocks.generateVAPIDKeys },
}));

const { sendToUser, notifyUser, getVapidPublicKey, isWebPushConfigured } = await import("../services/web-push.js");
const { pushSubscriptionService } = await import("../services/push-subscriptions.js");
const {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} = await import("./helpers/route-test-harness.js");

describeEmbeddedPostgres("web push sender", () => {
  const ctx = useEmbeddedPostgres("paperclip-web-push-", {
    resetEach: async (db) => {
      await db.delete(pushSubscriptions);
      await resetCompanyIssueFixtures(db);
    },
  });

  const PUB = "PAPERCLIP_VAPID_PUBLIC_KEY";
  const PRIV = "PAPERCLIP_VAPID_PRIVATE_KEY";
  let prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    prev = { [PUB]: process.env[PUB], [PRIV]: process.env[PRIV] };
    mocks.sendNotification.mockReset();
    mocks.sendNotification.mockResolvedValue({});
  });
  afterEach(() => {
    for (const key of [PUB, PRIV]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  function configure() {
    process.env[PUB] = "pub-key";
    process.env[PRIV] = "priv-key";
  }
  function unconfigure() {
    delete process.env[PUB];
    delete process.env[PRIV];
  }

  async function seedSub(db: typeof ctx.db, companyId: string, userId: string, endpoint: string) {
    await pushSubscriptionService(db).upsert(companyId, userId, {
      endpoint,
      p256dh: "p",
      auth: "a",
    });
  }

  it("is a no-op when VAPID keys are not configured", async () => {
    unconfigure();
    expect(isWebPushConfigured()).toBe(false);
    expect(getVapidPublicKey()).toBeNull();
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push unconfigured");
    await seedSub(ctx.db, companyId, userId, "https://push.example/a");

    await sendToUser(ctx.db, { companyId, recipientUserId: userId, title: "t", body: "b" });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("sends to every subscription the user has", async () => {
    configure();
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push send");
    await seedSub(ctx.db, companyId, userId, "https://push.example/a");
    await seedSub(ctx.db, companyId, userId, "https://push.example/b");

    await sendToUser(ctx.db, { companyId, recipientUserId: userId, title: "Hi", body: "there", url: "/x" });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(mocks.sendNotification.mock.calls[0][1] as string);
    expect(payload).toMatchObject({ title: "Hi", body: "there", url: "/x" });
  });

  it("prunes a subscription when the push service reports it gone (410)", async () => {
    configure();
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push prune");
    await seedSub(ctx.db, companyId, userId, "https://push.example/dead");
    mocks.sendNotification.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));

    await sendToUser(ctx.db, { companyId, recipientUserId: userId, title: "t", body: "b" });

    const rows = await ctx.db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId)));
    expect(rows).toHaveLength(0);
  });

  it("keeps the subscription on a transient (500) send failure", async () => {
    configure();
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push transient");
    await seedSub(ctx.db, companyId, userId, "https://push.example/keep");
    mocks.sendNotification.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }));

    await sendToUser(ctx.db, { companyId, recipientUserId: userId, title: "t", body: "b" });

    const rows = await ctx.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.companyId, companyId));
    expect(rows).toHaveLength(1); // transient failure must not drop the subscription
  });

  it("does not deliver to a subscribed user who is not an active company member", async () => {
    configure();
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Push offboarded");
    // A stale subscription row for someone with no active membership in this company
    // (e.g. offboarded after subscribing). getMembership returns null → skip.
    const ghostUserId = "user-ghost-no-membership";
    await seedSub(ctx.db, companyId, ghostUserId, "https://push.example/ghost");

    await sendToUser(ctx.db, { companyId, recipientUserId: ghostUserId, title: "t", body: "b" });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("notifyUser never notifies the actor of their own action", async () => {
    configure();
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Push self");
    await seedSub(ctx.db, companyId, userId, "https://push.example/self");

    notifyUser(ctx.db, { companyId, recipientUserId: userId, actorUserId: userId, title: "t", body: "b" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
