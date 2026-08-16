import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { pushSubscriptionService } from "../services/push-subscriptions.js";
import { getVapidPublicKey } from "../services/web-push.js";

// The browser's PushSubscription.toJSON() shape, plus an optional userAgent for
// display. Untrusted client input — every field is validated and length-capped.
const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().trim().url().max(2048),
    keys: z.object({
      p256dh: z.string().trim().min(1).max(512),
      auth: z.string().trim().min(1).max(512),
    }),
    expirationTime: z.number().int().positive().nullable().optional(),
    userAgent: z.string().trim().max(512).optional(),
  })
  .strict();

function requireBoardUser(req: Request, res: Response) {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board authentication required" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function pushSubscriptionRoutes(db: Db) {
  const router = Router();
  const svc = pushSubscriptionService(db);

  // The VAPID public key the browser needs before it can pushManager.subscribe.
  // Public by design; null tells the client web-push isn't set up on this instance.
  router.get("/push/vapid-public-key", (_req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  router.get("/companies/:companyId/push-subscriptions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    res.json(await svc.list(companyId, userId));
  });

  router.post(
    "/companies/:companyId/push-subscriptions",
    validate(pushSubscriptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUser(req, res);
      if (!userId) return;
      const row = await svc.upsert(companyId, userId, {
        endpoint: req.body.endpoint,
        p256dh: req.body.keys.p256dh,
        auth: req.body.keys.auth,
        expirationTime: req.body.expirationTime != null ? new Date(req.body.expirationTime) : null,
        userAgent: req.body.userAgent ?? null,
      });
      res.status(201).json(row);
    },
  );

  // Endpoint is passed in the body (it is a long URL, awkward as a path param)
  // and is only ever removed within the caller's own (companyId, userId) scope.
  router.delete(
    "/companies/:companyId/push-subscriptions",
    validate(z.object({ endpoint: z.string().trim().url().max(2048) }).strict()),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireBoardUser(req, res);
      if (!userId) return;
      const removed = await svc.removeByEndpoint(companyId, userId, req.body.endpoint);
      if (!removed) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }
      res.status(204).end();
    },
  );

  return router;
}
