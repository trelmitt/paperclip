import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pushSubscriptions } from "@paperclipai/db";

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: Date | null;
  userAgent?: string | null;
};

// Web Push subscription store (backlog I, thin slice). Everything is scoped to
// (companyId, userId): a user can only ever read or remove their own browser
// subscriptions. The endpoint is globally unique, so re-subscribing the same
// browser upserts by endpoint — and re-owns it to whoever is logged in there.
export function pushSubscriptionService(db: Db) {
  return {
    list: async (companyId: string, userId: string) =>
      db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId)))
        .orderBy(desc(pushSubscriptions.updatedAt)),

    upsert: async (companyId: string, userId: string, input: PushSubscriptionInput) => {
      const now = new Date();
      const [row] = await db
        .insert(pushSubscriptions)
        .values({
          companyId,
          userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          expirationTime: input.expirationTime ?? null,
          userAgent: input.userAgent ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            companyId,
            userId,
            p256dh: input.p256dh,
            auth: input.auth,
            expirationTime: input.expirationTime ?? null,
            userAgent: input.userAgent ?? null,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    // Ownership-scoped delete: the (companyId, userId) filter means one user can
    // never remove another user's subscription even by guessing its endpoint.
    removeByEndpoint: async (companyId: string, userId: string, endpoint: string) => {
      const [row] = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, companyId),
            eq(pushSubscriptions.userId, userId),
            eq(pushSubscriptions.endpoint, endpoint),
          ),
        )
        .returning();
      return row ?? null;
    },
  };
}
