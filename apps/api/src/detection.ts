import { createHash } from "node:crypto";
import type { Observation, Incident } from "./types.js";
import { Store } from "./db.js";
import { EventBroker } from "./events.js";

export const RULE_VERSION = "2026-10-01";
const severityForLatency = (seconds: number): Incident["severity"] => seconds >= 30 ? "critical" : "high";
export type DetectionOptions = { emitEvents?: boolean; eventMetadata?: Record<string, unknown> };

function candidates(observation: Observation, detectedAt: string, simulationTimestamp: string | null): Array<Omit<Incident, "id" | "status" | "investigationStatus" | "sessionId">> {
  const base = { reportId: observation.reportId, observationId: observation.id, ruleVersion: RULE_VERSION, detectedAt, simulationTimestamp };
  const evidence = (ruleCode: string, extra: Record<string, unknown>) => JSON.stringify({ observationId: observation.id, reportId: observation.reportId, reportName: observation.reportName, ruleCode, ...extra });
  const results: Array<Omit<Incident, "id" | "status" | "investigationStatus" | "sessionId">> = [];
  if (observation.avgLoadTimeSec > 15) results.push({ ...base, ruleCode: "LATENCY_OVER_15S", severity: severityForLatency(observation.avgLoadTimeSec), observedMetric: observation.avgLoadTimeSec, threshold: "> 15 seconds", evidenceJson: evidence("LATENCY_OVER_15S", { metric: "avg_load_time_sec", observed: observation.avgLoadTimeSec, thresholdSeconds: 15 }) });
  if (observation.refreshStatus === "FAILED") results.push({ ...base, ruleCode: "REFRESH_FAILED", severity: "critical", observedMetric: null, threshold: "last_refresh_status = FAILED", evidenceJson: evidence("REFRESH_FAILED", { metric: "last_refresh_status", observed: "FAILED" }) });
  if (observation.refreshStatus === "TIMED_OUT") results.push({ ...base, ruleCode: "REFRESH_TIMED_OUT", severity: "high", observedMetric: null, threshold: "last_refresh_status = TIMED_OUT", evidenceJson: evidence("REFRESH_TIMED_OUT", { metric: "last_refresh_status", observed: "TIMED_OUT" }) });
  if (observation.refreshStatus === "UNKNOWN") results.push({ ...base, ruleCode: "REFRESH_UNKNOWN", severity: "medium", observedMetric: null, threshold: "last_refresh_status in known states", evidenceJson: evidence("REFRESH_UNKNOWN", { metric: "last_refresh_status", observed: "UNKNOWN" }) });
  if (!observation.ownerNormalized) results.push({ ...base, ruleCode: "ORPHANED_REPORT_OWNER", severity: "high", observedMetric: null, threshold: "owner_email must be a real email", evidenceJson: evidence("ORPHANED_REPORT_OWNER", { metric: "owner_email", observed: observation.ownerEmail, finding: "missing_or_placeholder_owner" }) });
  if (observation.snowflakeCredits < 0) results.push({ ...base, ruleCode: "NEGATIVE_CREDITS", severity: "high", observedMetric: observation.snowflakeCredits, threshold: ">= 0 credits", evidenceJson: evidence("NEGATIVE_CREDITS", { metric: "snowflake_credits_consumed", observed: observation.snowflakeCredits, action: "exclude_from_cost_attribution" }) });
  return results;
}

export function detectObservation(store: Store, broker: EventBroker, observation: Observation, simulationTimestamp: string | null = null, sessionId = "seed", options: DetectionOptions = {}): { inserted: Incident[]; existing: Incident[]; detections: number } {
  const inserted: Incident[] = []; const existing: Incident[] = [];
  const emitEvents = options.emitEvents !== false;
  const emit = (eventType: string, payload: Record<string, unknown>) => {
    const enriched = { ...payload, ...(options.eventMetadata ?? {}) };
    if (emitEvents) broker.publish(eventType, enriched); else broker.record(eventType, enriched);
  };
  if (simulationTimestamp) emit("observation.received", { sessionId, observationId: observation.id, reportId: observation.reportId, simulationTimestamp });
  for (const candidate of candidates(observation, new Date().toISOString(), simulationTimestamp)) {
    const result = store.insertIncident(candidate, sessionId);
    if (!result.incident) continue;
    if (result.detectionInserted) emit("detection.triggered", { sessionId, detectionEventId: result.detectionEventId, observationId: observation.id, reportId: observation.reportId, ruleCode: result.incident.ruleCode, severity: result.incident.severity, observedMetric: result.incident.observedMetric, threshold: result.incident.threshold, simulationTimestamp });
    if (result.inserted) {
      inserted.push(result.incident);
      emit(result.groupInserted ? "incident.detected" : "incident.updated", { incident: result.incident, groupId: result.groupId, evidence: JSON.parse(result.incident.evidenceJson), occurrenceCount: result.groupId ? Number(store.incidentGroup(result.groupId)?.occurrence_count ?? 1) : 1 });
    }
    else existing.push(result.incident);
  }
  return { inserted, existing, detections: inserted.length + existing.length };
}

export function evidenceHash(incident: Incident, observation: Observation): string {
  return createHash("sha256").update(`${incident.ruleCode}|${incident.ruleVersion}|${incident.evidenceJson}|${observation.rawJson}`).digest("hex");
}
