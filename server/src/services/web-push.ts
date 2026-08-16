import webpush from "web-push";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { accessService } from "./access.js";
import { pushSubscriptionService } from "./push-subscriptions.js";

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

let loggedMissing = false;

/**
 * VAPID keys from env. The PRIVATE key is a deploy-time secret the operator
 * injects (`paperclipai push generate-vapid-keys` prints a fresh pair) — never
 * hardcoded, never committed. When keys are absent, web-push is a no-op (logged
 * once) so the feature degrades cleanly on any instance that hasn't set it up.
 */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.PAPERCLIP_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.PAPERCLIP_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.PAPERCLIP_VAPID_SUBJECT?.trim() || "mailto:admin@paperclip.local";
  if (!publicKey || !privateKey) {
    if (!loggedMissing) {
      logger.info(
        "web-push: VAPID keys not configured (PAPERCLIP_VAPID_PUBLIC_KEY / PAPERCLIP_VAPID_PRIVATE_KEY); phone push disabled",
      );
      loggedMissing = true;
    }
    return null;
  }
  return { publicKey, privateKey, subject };
}

export function isWebPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

/** The public half is safe to hand to the browser (needed for pushManager.subscribe). */
export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}

export type PushNotification = { title: string; body: string; url?: string };

/**
 * Send a notification to every browser the user has subscribed. Best-effort:
 * unconfigured → no-op; a 404/410 from the push service means the subscription
 * is dead, so we prune that row.
 */
export async function sendToUser(
  db: Db,
  target: { companyId: string; recipientUserId: string } & PushNotification,
): Promise<void> {
  const vapid = getVapidConfig();
  if (!vapid) return;
  // Defense-in-depth: only deliver to a user who STILL has active access to this
  // company. A subscription row outlives membership, so without this an offboarded
  // user's browser would keep receiving issue content via @mention/assignment.
  const membership = await accessService(db).getMembership(target.companyId, "user", target.recipientUserId);
  if (membership?.status !== "active") return;
  const subs = pushSubscriptionService(db);
  const rows = await subs.list(target.companyId, target.recipientUserId);
  if (rows.length === 0) return;

  const payload = JSON.stringify({ title: target.title, body: target.body, url: target.url ?? "/" });
  const options = {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  };

  await Promise.all(
    rows.map(async (row) => {
      const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(subscription, payload, options);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await subs.removeByEndpoint(target.companyId, target.recipientUserId, row.endpoint);
          return;
        }
        logger.warn({ err, endpoint: row.endpoint }, "web-push: send failed");
      }
    }),
  );
}

/**
 * Fire-and-forget wrapper (mirrors hire-hook.ts): a push failure must never
 * break the mutation that triggered it. No-ops when there is no recipient or
 * when the recipient is the actor (never notify yourself of your own action).
 */
export function notifyUser(
  db: Db,
  target: {
    companyId: string;
    recipientUserId: string | null | undefined;
    actorUserId?: string | null;
  } & PushNotification,
): void {
  const recipient = target.recipientUserId?.trim();
  if (!recipient) return;
  if (target.actorUserId && target.actorUserId === recipient) return;
  void sendToUser(db, {
    companyId: target.companyId,
    recipientUserId: recipient,
    title: target.title,
    body: target.body,
    url: target.url,
  }).catch((err) => logger.warn({ err }, "web-push: notifyUser failed"));
}

/** Generate a fresh VAPID keypair (used by the CLI keygen verb). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
