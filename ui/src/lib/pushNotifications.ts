import { pushApi } from "../api/push";

// Browser-side web-push plumbing (backlog I). Turns a company + the server's
// VAPID public key into a live PushSubscription and registers it, and tears it
// down on disable. All of this only runs in a browser with a service worker.

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// VAPID public keys are URL-safe base64; pushManager.subscribe wants the raw bytes.
// Back the view with a fresh ArrayBuffer so the type is Uint8Array<ArrayBuffer>
// (not ArrayBufferLike) — applicationServerKey rejects a possibly-shared buffer.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function getPushState(): Promise<"unsupported" | "denied" | "subscribed" | "unsubscribed"> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await existingSubscription()) ? "subscribed" : "unsubscribed";
}

/**
 * Ask permission, subscribe this browser to push, and register the subscription
 * with the server. Returns false (a no-op) when unsupported, when the user
 * denies permission, or when the instance has no VAPID key configured.
 */
export async function enablePush(companyId: string): Promise<boolean> {
  if (!isPushSupported()) return false;
  const { publicKey } = await pushApi.vapidPublicKey();
  if (!publicKey) return false; // web-push not configured on this instance

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  await pushApi.subscribe(companyId, {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    expirationTime: subscription.expirationTime ?? null,
    userAgent: navigator.userAgent,
  });
  return true;
}

/** Unsubscribe this browser and remove the subscription from the server. */
export async function disablePush(companyId: string): Promise<void> {
  if (!isPushSupported()) return;
  const subscription = await existingSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => undefined);
  await pushApi.unsubscribe(companyId, endpoint).catch(() => undefined);
}
