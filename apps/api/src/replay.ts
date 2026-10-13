import type { Observation, Role } from "./types.js";
import type { Store } from "./db.js";
import type { EventBroker } from "./events.js";
import type { RcaManager } from "./rca.js";
import { detectObservation } from "./detection.js";

export type ReplayConfig = { mode?: "full" | "curated"; seed?: number; speed?: number; ordering?: "sequential" | "seeded-interleaved"; emitEvents?: boolean; principalUsername?: string | null; principalRole?: Role | null; scopeReportIds?: string[] | null; sharedEvaluation?: boolean };
const speeds = [1, 5, 20];

function seededOrder(ids: string[], seed: number) {
  const values = [...ids]; let state = Math.abs(Number.isFinite(seed) ? seed : 1) >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = values.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}

function curatedRows(rows: Observation[]) {
  const picks: Observation[] = []; const used = new Set<string>();
  const requirements: Array<(row: Observation) => boolean> = [row => row.avgLoadTimeSec > 15, row => row.refreshStatus === "FAILED", row => row.refreshStatus === "TIMED_OUT", row => !row.ownerNormalized, row => row.snowflakeCredits < 0, row => row.monthlyActiveViews === 0];
  for (const requirement of requirements) { const row = rows.find(candidate => !used.has(candidate.id) && requirement(candidate)); if (row) { picks.push(row); used.add(row.id); } }
  // Keep a second real slow observation so the evaluator can see deterministic
  // grouping and an incident update without manufacturing a duplicate row.
  const firstLatency = picks.find(row => row.avgLoadTimeSec > 15);
  const repeatedLatency = rows.find(row => !used.has(row.id) && row.avgLoadTimeSec > 15 && (!firstLatency || row.reportId === firstLatency.reportId));
  if (repeatedLatency) { picks.push(repeatedLatency); used.add(repeatedLatency.id); }
  const normal = rows.find(row => !used.has(row.id) && row.avgLoadTimeSec <= 15 && row.refreshStatus === "SUCCESS" && row.ownerNormalized && row.snowflakeCredits >= 0 && row.monthlyActiveViews > 0); if (normal) picks.push(normal);
  return picks;
}

export class ReplayService {
  private timer: NodeJS.Timeout | undefined;
  private timers = new Map<string, NodeJS.Timeout>();
  private sessionId: string | null = null;
  private sessionCounter = 0;
  constructor(private store: Store, private broker: EventBroker, private rca: RcaManager, private autoRca = true) {
    const existing = store.replaySession();
    // A process restart cannot safely continue loops whose timers no longer
    // exist. Preserve every cursor and require an explicit resume.
    for (const running of store.runningReplaySessions()) store.updateReplaySession(running.id, { state: "paused" });
    this.sessionId = existing?.id ?? null;
  }
  status() { return this.sessionId ? this.store.replaySession(this.sessionId) : null; }
  configure(config: ReplayConfig = {}) {
    // Configuration is session-scoped. A new principal may prepare an isolated
    // replay while another session is active; the configured concurrency limit is
    // enforced when sessions are started.
    if (config.mode && !["full", "curated"].includes(config.mode)) throw new Error("mode must be full or curated");
    if (config.ordering && !["sequential", "seeded-interleaved"].includes(config.ordering)) throw new Error("ordering must be sequential or seeded-interleaved");
    const mode = config.mode ?? "curated"; const seed = Number.isFinite(config.seed) ? Number(config.seed) : 42; const speed = speeds.includes(Number(config.speed)) ? Number(config.speed) : 1; const ordering = config.ordering ?? "sequential";
    const sourceRows = mode === "curated" ? curatedRows(this.store.observations()) : this.store.observations();
    // `undefined` means the caller intentionally requested the complete
    // dataset (ADMIN only at the HTTP boundary). An explicit empty scope is a
    // real zero-report scope and must never expand to all source rows.
    const hasExplicitScope = config.scopeReportIds !== undefined && config.scopeReportIds !== null;
    const rows = hasExplicitScope ? sourceRows.filter(row => config.scopeReportIds!.includes(row.reportId)) : sourceRows;
    if (config.principalUsername && hasExplicitScope && rows.length === 0) throw new Error("No authorized reports are assigned to this replay principal");
    const ids = rows.map(row => row.id); const order = ordering === "seeded-interleaved" ? seededOrder(ids, seed) : ids;
    const id = `replay-${Date.now()}-${Math.abs(seed)}-${++this.sessionCounter}`; this.sessionId = id;
    const sharedEvaluation = config.sharedEvaluation === true && mode === "full" && !config.principalUsername && !config.principalRole && !hasExplicitScope;
    this.store.saveReplaySession({ id, mode, seed, speed, ordering, state: "configured", position: 0, total: order.length, order, startedAt: null, principalUsername: config.principalUsername ?? null, principalRole: config.principalRole ?? null, scopeReportIds: config.scopeReportIds ?? null, sharedEvaluation });
    if (config.emitEvents !== false) this.broker.publish("replay.configured", { sessionId: id, mode, seed, speed, ordering, total: order.length });
    return this.status();
  }
  start(sessionId?: string) { const session = this.requireSession(sessionId); if (session.state === "completed") throw new Error("Replay is complete; configure a new session or reset first"); if (session.state === "running") return session; const max = Number(process.env.REPLAY_MAX_CONCURRENT ?? 3); if (this.store.runningReplayCount() >= (Number.isFinite(max) && max > 0 ? Math.floor(max) : 3)) throw new Error("Replay concurrency limit reached"); const allReports = new Set(this.store.observations().map(row => row.reportId)); const requestedReports = new Set(session.scopeReportIds ?? allReports); for (const activeRow of this.store.runningReplaySessions()) { if (activeRow.id === session.id) continue; const active = this.store.replaySession(activeRow.id); const activeReports = new Set(active?.scopeReportIds ?? allReports); if ([...requestedReports].some(reportId => activeReports.has(reportId))) throw new Error("A conflicting replay session is already running for this report scope"); } this.store.updateReplaySession(session.id, { state: "running", startedAt: session.startedAt ?? new Date().toISOString() }); this.broker.publish("replay.started", { sessionId: session.id, mode: session.mode, position: session.position, total: session.total, speed: session.speed, principalUsername: session.principalUsername ?? null }); this.loop(session.id); return this.store.replaySession(session.id); }
  pause(sessionId?: string) { const session = this.requireSession(sessionId); if (session.state === "running") { this.stopTimer(session.id); this.store.updateReplaySession(session.id, { state: "paused" }); this.broker.publish("replay.paused", { sessionId: session.id, position: session.position }); } return this.store.replaySession(session.id); }
  resume() { return this.start(); }
  reset(sessionId?: string) { const session = this.requireSession(sessionId); this.stopTimer(session.id); this.store.updateReplaySession(session.id, { state: "reset", position: 0 }); this.broker.publish("replay.reset", { sessionId: session.id, sourceDataPreserved: true }); return this.store.replaySession(session.id); }
  restart(start = true) {
    const previous = this.requireSession();
    this.stopTimer(previous.id);
    if (previous.state === "running") {
      this.store.updateReplaySession(previous.id, { state: "paused" });
      this.broker.publish("replay.paused", { sessionId: previous.id, position: previous.position, reason: "restart" });
    }
    const session = this.configure({ mode: previous.mode, seed: previous.seed, speed: previous.speed, ordering: previous.ordering });
    this.broker.publish("replay.restarted", { previousSessionId: previous.id, sessionId: session?.id ?? null, sourceDataPreserved: true, freshSession: true });
    return start ? this.start() : session;
  }
  prepareDemo(config: { seed?: number; speed?: number } = {}) {
    if (this.status()?.state === "running") this.pause();
    const session = this.configure({ mode: "curated", seed: config.seed ?? 42, speed: config.speed ?? 1, ordering: "sequential" });
    const cursor = this.store.latestEventId();
    this.broker.publish("demo.ready", { sessionId: session?.id ?? null, cursor, total: session?.total ?? 0, simulated: true, requiresSubscription: true });
    return { session: this.status(), cursor, simulated: true, requiresSubscription: true };
  }
  startDemo(sessionId: string, cursor: number) {
    const session = this.requireSession();
    if (session.id !== sessionId) throw new Error("Demo session is no longer current");
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.store.latestEventId()) throw new Error("A valid event cursor is required");
    if (!["configured", "paused", "reset"].includes(session.state)) throw new Error("Demo session is not ready to start");
    return this.start();
  }
  /** Build the shared completed evaluation without simulated wall-clock pacing. */
  ensureCompletedEvaluation(seed = 42) {
    const existing = this.store.latestCompletedFullReplay();
    if (existing) { this.sessionId = existing.id; this.store.updateReplaySession(existing.id, { state: "completed", position: existing.total }); return this.store.replaySession(existing.id); }
    if (this.store.runningReplayCount()) throw new Error("Another replay is already running");
    const session = this.configure({ mode: "full", seed, speed: 20, ordering: "sequential", emitEvents: false, sharedEvaluation: true });
    if (!session) throw new Error("Unable to configure completed evaluation");
    this.store.updateReplaySession(session.id, { state: "running", startedAt: new Date().toISOString() });
    this.broker.record("replay.started", { sessionId: session.id, mode: "full", position: 0, total: session.total, speed: 20, historicalEvaluation: true, sourceType: "completed_evaluation" });
    while ((this.status()?.position ?? 0) < session.total) this.processOne(false);
    return this.status();
  }
  step(sessionId?: string) { const session = this.requireSession(sessionId); if (session.state === "running") throw new Error("Pause the replay before single-step"); if (session.position >= session.total) return session; this.store.updateReplaySession(session.id, { state: "paused" }); this.processOne(true, session.id); return this.store.replaySession(session.id); }
  private requireSession(id?: string) { const session = this.store.replaySession(id ?? undefined); if (!session) throw new Error("Configure a replay first"); return session; }
  private loop(id = this.sessionId ?? undefined) { if (!id) return; this.stopTimer(id); const session = this.requireSession(id); if (session.state !== "running") return; this.processOne(true, id); const next = this.store.replaySession(id); if (next?.state === "running") { const configuredCadence = Number(process.env.REPLAY_CURATED_CADENCE_MS ?? 1500); const curatedCadence = Number.isFinite(configuredCadence) && configuredCadence > 0 ? Math.max(250, Math.floor(configuredCadence)) : 1500; const delay = next.mode === "curated" ? curatedCadence : Math.max(5, Math.floor(200 / next.speed)); const timer = setTimeout(() => this.loop(id), delay); this.timers.set(id, timer); if (id === this.sessionId) this.timer = timer; } }
  private stopTimer(id = this.sessionId ?? undefined) { if (!id) return; const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); if (id === this.sessionId) this.timer = undefined; }
  private processOne(realtime = true, sessionId?: string) {
    const session = this.requireSession(sessionId); if (session.position >= session.total) { this.stopTimer(session.id); this.store.updateReplaySession(session.id, { state: "completed" }); const payload = { sessionId: session.id, total: session.total, ...(realtime ? {} : { historicalEvaluation: true, sourceType: "completed_evaluation" }) }; if (realtime) this.broker.publish("replay.completed", payload); else this.broker.record("replay.completed", payload); return; }
    const observation = this.store.observation(session.order[session.position]); if (!observation) throw new Error(`Replay source row missing: ${session.order[session.position]}`);
    const simulationTimestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, session.position)).toISOString();
    const result = detectObservation(this.store, this.broker, observation, simulationTimestamp, session.id, { emitEvents: realtime, eventMetadata: realtime ? undefined : { historicalEvaluation: true, sourceType: "completed_evaluation" } });
    // Deterministic replay may auto-queue RCA for the demo, but hosted
    // inference is opt-in. This keeps an alert's first SSE event independent
    // from provider work and prevents replay from silently spending a hosted
    // RCA budget.
    if (this.autoRca) for (const incident of result.inserted) this.rca.enqueue(incident);
    const position = session.position + 1; this.store.updateReplaySession(session.id, { position, state: position >= session.total ? "completed" : session.state });
    const progress = { sessionId: session.id, position, total: session.total, observationId: observation.id, reportId: observation.reportId, detections: result.detections, simulationTimestamp, ...(realtime ? {} : { historicalEvaluation: true, sourceType: "completed_evaluation" }) };
    if (realtime) this.broker.publish("replay.progress", progress); else this.broker.record("replay.progress", progress);
    if (position >= session.total) { const payload = { sessionId: session.id, total: session.total, ...(realtime ? {} : { historicalEvaluation: true, sourceType: "completed_evaluation" }) }; if (realtime) this.broker.publish("replay.completed", payload); else this.broker.record("replay.completed", payload); }
  }
}
