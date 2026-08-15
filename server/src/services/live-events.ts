import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

/**
 * Gap-free reconnect resume (backlog F). Off by default: the WS ignores any ?cursor= and behaves
 * exactly as before (attach the live listener, no backfill). When on, a client that sends a resume
 * cursor has its missed durable events replayed before the live stream attaches. Reversible; the
 * feature is doubly gated (a client must also send a cursor, which no client does until F4 ships).
 */
export function liveResumeEnabled(): boolean {
  return process.env.PAPERCLIP_LIVE_RESUME === "true";
}

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
  /** Durable resume position (backlog F); omit on class-3 stateless frames. */
  stream?: string | null;
  seq?: number | null;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
    stream: input.stream ?? null,
    seq: input.seq ?? null,
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
  /**
   * Durable resume position for the backlog F reconnect cursor. Set together on the durably-backed
   * types (issue.event -> LIVE_STREAM_ISSUE + issue_events.id; heartbeat.run.event ->
   * LIVE_STREAM_HEARTBEAT + heartbeat_run_events.id). Omit on stateless frames.
   */
  stream?: string | null;
  seq?: number | null;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
