import { useEffect, useState } from "react";
import { Bell, BellOff, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { disablePush, enablePush, getPushState } from "@/lib/pushNotifications";

type State = "loading" | "unsupported" | "denied" | "subscribed" | "unsubscribed";

// Per-device web-push toggle (backlog I). Subscriptions are per browser, so the
// state ("is this device subscribed?") is read from the service worker, not from
// server state.
export function PushNotificationsControl({ companyId }: { companyId: string | null }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPushState()
      .then((s) => active && setState(s))
      .catch(() => active && setState("unsupported"));
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setState(await getPushState());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Notification change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Bell className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Phone notifications</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Get a push notification on this device when an issue is assigned to you or you are @mentioned.
      </p>

      {state === "loading" ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : state === "unsupported" ? (
        <p className="text-xs text-muted-foreground">This browser does not support web push.</p>
      ) : state === "denied" ? (
        <p className="text-xs text-destructive">Notifications are blocked in your browser settings.</p>
      ) : state === "subscribed" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            companyId &&
            run(async () => {
              await disablePush(companyId);
            })
          }
          disabled={busy || !companyId}
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <BellOff className="size-4" />}
          Disable on this device
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() =>
            companyId &&
            run(async () => {
              const ok = await enablePush(companyId);
              if (!ok) {
                throw new Error("Push is unavailable — permission denied, or not configured on this instance.");
              }
            })
          }
          disabled={busy || !companyId}
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Bell className="size-4" />}
          Enable on this device
        </Button>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
