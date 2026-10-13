import { z } from "zod";
import type { Store } from "./db.js";
import { buildEvidencePacket } from "./evidence.js";

const groupArgs = z.object({ incident_group_id: z.string().min(1).max(200) }).strict();
const reportArgs = z.object({ report_id: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(20) }).strict();
const ruleArgs = z.object({ rule_id: z.string().min(1).max(100) }).strict();

export type ToolName = "get_incident_evidence" | "get_report_observations" | "get_report_cost_breakdown" | "get_related_detections" | "get_rule_definition";
export type ToolCall = { id: string; name: string; arguments: string };
export type ToolTraceEntry = { id: string; name: string; round: number; argumentsHash: string; ok: boolean };

export const TOOL_SCHEMAS = [
  { type: "function", function: { name: "get_incident_evidence", description: "Read compact source-backed evidence for the current incident group.", parameters: { type: "object", additionalProperties: false, required: ["incident_group_id"], properties: { incident_group_id: { type: "string" } } } } },
  { type: "function", function: { name: "get_report_observations", description: "Read bounded observation metrics for the report in the current incident context. Rows have no authoritative chronology.", parameters: { type: "object", additionalProperties: false, required: ["report_id"], properties: { report_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } } } } },
  { type: "function", function: { name: "get_report_cost_breakdown", description: "Read valid and invalid source cost metrics for the report, including zero-view handling.", parameters: { type: "object", additionalProperties: false, required: ["report_id"], properties: { report_id: { type: "string" } } } } },
  { type: "function", function: { name: "get_related_detections", description: "Read all preserved detection references for the current incident group.", parameters: { type: "object", additionalProperties: false, required: ["incident_group_id"], properties: { incident_group_id: { type: "string" } } } } },
  { type: "function", function: { name: "get_rule_definition", description: "Read the deterministic rule definition and its limitations.", parameters: { type: "object", additionalProperties: false, required: ["rule_id"], properties: { rule_id: { type: "string" } } } } }
] as const;

const RULES: Record<string, unknown> = {
  LATENCY_OVER_15S: { ruleId: "LATENCY_OVER_15S", condition: "avg_load_time_sec > 15", severity: "high; critical when >= 30", measuredField: "avg_load_time_sec", limitation: "A latency breach does not prove a Snowflake or infrastructure root cause." },
  REFRESH_FAILED: { ruleId: "REFRESH_FAILED", condition: "last_refresh_status = FAILED", severity: "critical", measuredField: "last_refresh_status", limitation: "The status does not identify the underlying dependency." },
  REFRESH_TIMED_OUT: { ruleId: "REFRESH_TIMED_OUT", condition: "last_refresh_status = TIMED_OUT", severity: "high", measuredField: "last_refresh_status", limitation: "The status does not identify the query or dependency cause." },
  REFRESH_UNKNOWN: { ruleId: "REFRESH_UNKNOWN", condition: "last_refresh_status = UNKNOWN", severity: "medium", measuredField: "last_refresh_status", limitation: "Unknown is not classified as failure." },
  ORPHANED_REPORT_OWNER: { ruleId: "ORPHANED_REPORT_OWNER", condition: "owner is missing or placeholder", severity: "high", measuredField: "owner_email", limitation: "The record does not explain why ownership is missing." },
  NEGATIVE_CREDITS: { ruleId: "NEGATIVE_CREDITS", condition: "snowflake_credits < 0", severity: "high", measuredField: "snowflake_credits", limitation: "The CSV does not prove an infrastructure failure." }
};

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export class ToolValidationError extends Error { constructor(message: string) { super(message); this.name = "ToolValidationError"; } }

export class IncidentToolRegistry {
  constructor(private readonly store: Store, private readonly groupId: string) {}

  schemas() { return TOOL_SCHEMAS; }

  private context() {
    const group = this.store.incidentGroup(this.groupId);
    if (!group) throw new ToolValidationError("Incident group is not accessible");
    return { group, reportId: String(group.report_id), session: this.store.replaySession(String(group.session_id)) };
  }

  /**
   * During an active simulation, expose only rows whose replay cursor has
   * already processed them. A completed evaluation intentionally exposes the
   * full authorized report history. This prevents RCA lookahead into future
   * source rows while preserving the timestamp-less source semantics.
   */
  private scopedObservations(reportId: string) {
    const { session } = this.context();
    const rows = this.store.observations({ reportId });
    if (!session || session.state === "completed") return rows;
    const processed = new Set(session.order.slice(0, Math.max(0, session.position)));
    return rows.filter(row => processed.has(row.id));
  }

  execute(name: string, rawArguments: string): { name: string; ok: true; data: unknown } {
    if (!(TOOL_SCHEMAS as readonly unknown[]).some(schema => (schema as { function: { name: string } }).function.name === name)) throw new ToolValidationError(`Unknown tool: ${name}`);
    let args: unknown;
    try { args = JSON.parse(rawArguments || "{}"); } catch { throw new ToolValidationError("Tool arguments must be valid JSON"); }
    const { group, reportId } = this.context();
    let data: unknown;
    if (name === "get_incident_evidence") {
      const parsed = groupArgs.parse(args); if (parsed.incident_group_id !== this.groupId) throw new ToolValidationError("Incident group is outside the authorized context");
      const packet = buildEvidencePacket(this.store, this.groupId); if (!packet) throw new ToolValidationError("Incident evidence is unavailable");
      data = { groupId: packet.groupId, sessionId: packet.sessionId, reportId: packet.reportId, ruleCode: packet.ruleCode, severity: packet.severity, evidenceRefs: packet.evidenceRefs, observations: packet.observations, thresholds: packet.thresholds, validationFindings: packet.validationFindings, limitations: packet.limitations };
    } else if (name === "get_related_detections") {
      const parsed = groupArgs.parse(args); if (parsed.incident_group_id !== this.groupId) throw new ToolValidationError("Incident group is outside the authorized context");
      data = { groupId: this.groupId, detections: this.store.groupMembers(this.groupId).map(row => ({ incidentId: Number(row.id), detectionEventId: row.detection_event_id == null ? null : Number(row.detection_event_id), observationId: String(row.observation_id), sourceRowNumber: this.store.observation(String(row.observation_id))?.rowNumber ?? null, reportId: String(row.report_id), ruleCode: String(row.rule_code), severity: String(row.severity), observedMetric: row.observed_metric == null ? null : Number(row.observed_metric), threshold: String(row.threshold), simulationTimestamp: row.simulation_timestamp ? String(row.simulation_timestamp) : null })) };
    } else if (name === "get_report_observations") {
      const parsed = reportArgs.parse(args); if (parsed.report_id !== reportId) throw new ToolValidationError("Report is outside the authorized incident context");
      data = { reportId, evidenceScope: "processed observations in the incident replay session", chronology: "not available; source rows have no authoritative observation timestamps", observations: this.scopedObservations(reportId).slice(0, parsed.limit).map(row => ({ observationId: row.id, sourceRowNumber: row.rowNumber, reportId: row.reportId, refreshStatus: row.refreshStatus, monthlyActiveViews: row.monthlyActiveViews, snowflakeCredits: row.snowflakeCredits, avgLoadTimeSec: row.avgLoadTimeSec, awsHostingCostUsd: row.awsHostingCostUsd, queryCountLast30d: row.queryCountLast30d, concurrentUserPeak: row.concurrentUserPeak })) };
    } else if (name === "get_report_cost_breakdown") {
      const parsed = z.object({ report_id: z.string().min(1).max(200) }).strict().parse(args); if (parsed.report_id !== reportId) throw new ToolValidationError("Report is outside the authorized incident context");
      const rows = this.scopedObservations(reportId); const valid = rows.filter(row => row.snowflakeCredits >= 0); const perView = valid.filter(row => row.monthlyActiveViews > 0).map(row => row.snowflakeCredits / row.monthlyActiveViews); const awsValid = rows.filter(row => row.monthlyActiveViews > 0 && Number.isFinite(row.awsHostingCostUsd)); const awsPerView = awsValid.map(row => row.awsHostingCostUsd / row.monthlyActiveViews);
      const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
      data = { reportId, evidenceScope: "processed observations in the incident replay session", observationCount: rows.length, validCreditObservations: valid.length, invalidCreditObservations: rows.length - valid.length, validAwsHostingCostObservations: rows.filter(row => Number.isFinite(row.awsHostingCostUsd)).length, zeroViewObservations: rows.filter(row => row.monthlyActiveViews === 0).length, medianCreditsPerActiveView: median(perView), medianAwsCostPerActiveViewUsd: median(awsPerView), methodology: "Median of valid source-row ratios; negative credits are excluded only from Snowflake-credit calculations, AWS hosting costs are evaluated independently, and zero views are undefined." };
    } else {
      const parsed = ruleArgs.parse(args); if (!RULES[parsed.rule_id]) throw new ToolValidationError("Unknown rule definition"); data = RULES[parsed.rule_id];
    }
    const serialized = JSON.stringify(data); if (serialized.length > 32 * 1024) throw new ToolValidationError("Tool result exceeded the compact response limit");
    return { name, ok: true, data };
  }

  trace(name: string, id: string, round: number, rawArguments: string, ok = true): ToolTraceEntry { return { id, name, round, argumentsHash: hash(rawArguments), ok }; }
}
