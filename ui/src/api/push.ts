import { api } from "./client";

// Web-push (backlog I). The server exposes the VAPID public key, and per-user
// subscription CRUD scoped to a company.
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  userAgent?: string;
}

export const pushApi = {
  vapidPublicKey: () => api.get<{ publicKey: string | null }>("/push/vapid-public-key"),
  subscribe: (companyId: string, subscription: PushSubscriptionPayload) =>
    api.post(`/companies/${companyId}/push-subscriptions`, subscription),
  unsubscribe: (companyId: string, endpoint: string) =>
    api.delete(`/companies/${companyId}/push-subscriptions`, { endpoint }),
};
