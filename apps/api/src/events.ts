import type { Response } from "express";
import type { Store } from "./db.js";

type Client = { response: Response; heartbeat: NodeJS.Timeout; sessionId?: string; isAuthorized?: () => boolean; isEventAuthorized?: (payload: unknown) => boolean };
export class EventBroker {
  private clients = new Set<Client>();
  constructor(private store: Store) {}
  subscribe(response: Response, lastEventId = 0, sessionId?: string, isAuthorized?: () => boolean, isEventAuthorized?: (payload: unknown) => boolean) {
    response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    // Catch up in bounded pages before registering the client. This keeps the
    // transition gap-free while allowing a client to recover more than 100 events.
    let cursor = Math.max(0, lastEventId); let page: Record<string, unknown>[];
    do {
      page = this.store.eventsSince(cursor, 100);
      for (const event of page) { cursor = Number(event.id); this.write(response, cursor, String(event.event_type), JSON.parse(String(event.payload_json)), sessionId, isEventAuthorized); }
    } while (page.length === 100);
    response.write(`event: connected\ndata: ${JSON.stringify({ replayFrom: lastEventId, sessionId: sessionId ?? null })}\n\n`);
    const heartbeatMsValue = Number(process.env.SSE_HEARTBEAT_MS ?? 5000);
    const heartbeatMs = Number.isFinite(heartbeatMsValue) && heartbeatMsValue >= 1000 ? heartbeatMsValue : 5000;
    let client: Client;
    const heartbeat = setInterval(() => {
      if (isAuthorized && !isAuthorized()) return this.close(client);
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }, heartbeatMs);
    client = { response, heartbeat, sessionId, isAuthorized, isEventAuthorized }; this.clients.add(client);
    response.on("close", () => this.close(client));
  }
  closeUnauthorized() {
    for (const client of this.clients) if (client.isAuthorized && !client.isAuthorized()) this.close(client);
  }
  /** Persist an event without broadcasting it as a live event. Used for the completed
   * evaluation snapshot, whose history should be inspectable without pretending it
   * arrived in real time. */
  record(eventType: string, payload: unknown) {
    return this.store.addEvent(eventType, payload);
  }
  publish(eventType: string, payload: unknown) {
    const id = this.store.addEvent(eventType, payload);
    for (const client of this.clients) {
      if (client.isAuthorized && !client.isAuthorized()) this.close(client);
      else this.write(client.response, id, eventType, payload, client.sessionId, client.isEventAuthorized);
    }
    return id;
  }
  private close(client: Client) {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
    try { client.response.end(); } catch { /* connection already closed */ }
  }
  private write(response: Response, id: number, eventType: string, payload: unknown, sessionId?: string, isEventAuthorized?: (payload: unknown) => boolean) {
    if (sessionId && this.payloadSessionId(payload) !== sessionId) return;
    if (isEventAuthorized && !isEventAuthorized(payload)) return;
    response.write(`id: ${id}\nevent: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  private payloadSessionId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const value = payload as Record<string, unknown>;
    if (typeof value.sessionId === "string") return value.sessionId;
    if (value.incident && typeof value.incident === "object" && typeof (value.incident as Record<string, unknown>).sessionId === "string") return String((value.incident as Record<string, unknown>).sessionId);
    return undefined;
  }
}
