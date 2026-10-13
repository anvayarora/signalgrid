import { createHash } from "node:crypto";
import type { Store } from "./db.js";

export const EVIDENCE_PACKET_VERSION = "1.0";

export type EvidenceObservation = {
  observationId: string;
  sourceRowNumber: number;
  reportId: string;
  refreshStatus: string;
  monthlyActiveViews: number;
  snowflakeCredits: number;
  avgLoadTimeSec: number;
  awsHostingCostUsd: number;
  queryCountLast30d: number;
  concurrentUserPeak: number;
  detectionIds: string[];
  incidentIds: number[];
  ruleCodes: string[];
};

export type EvidencePacket = {
  packetVersion: string;
  groupId: string;
  sessionId: string;
  reportId: string;
  ruleCode: string;
  ruleVersion: string;
  severity: string;
  evidenceRefs: string[];
  observations: EvidenceObservation[];
  thresholds: string[];
  validationFindings: string[];
  limitations: string[];
};

/**
 * Build the only payload that may be sent to an RCA provider. It deliberately
 * excludes owner email, report names, raw CSV JSON, filesystem paths and secrets.
 */
export function buildEvidencePacket(store: Store, groupId: string): EvidencePacket | null {
  const group = store.incidentGroup(groupId);
  if (!group) return null;
  const members = store.groupMembers(groupId);
  const evidenceRefs: string[] = [];
  const observations = new Map<string, EvidenceObservation>();
  const thresholds: string[] = [];
  const validationFindings: string[] = [];
  for (const member of members) {
    const observationId = String(member.observation_id);
    const observation = store.observation(observationId);
    if (!observation) continue;
    const incidentId = Number(member.id);
    const detectionId = member.detection_event_id == null ? null : Number(member.detection_event_id);
    const refs = [`observation:${observationId}`, `incident:${incidentId}`];
    if (detectionId != null) refs.push(`detection:${detectionId}`);
    evidenceRefs.push(...refs);
    thresholds.push(String(member.threshold));
    if (observation.ownerNormalized == null) validationFindings.push(`source row ${observation.rowNumber}: missing_or_placeholder_owner`);
    if (observation.snowflakeCredits < 0) validationFindings.push(`source row ${observation.rowNumber}: negative_credits_excluded`);
    if (observation.monthlyActiveViews === 0) validationFindings.push(`source row ${observation.rowNumber}: zero_views_cost_per_view_undefined`);
    if (observation.refreshStatus === "UNKNOWN") validationFindings.push(`source row ${observation.rowNumber}: unknown_refresh_state`);
    const current = observations.get(observationId);
    if (current) {
      current.detectionIds = detectionId == null ? current.detectionIds : [...current.detectionIds, `detection:${detectionId}`];
      current.incidentIds = [...current.incidentIds, incidentId];
      current.ruleCodes = [...new Set([...current.ruleCodes, String(member.rule_code)])];
    } else {
      observations.set(observationId, {
        observationId,
        sourceRowNumber: observation.rowNumber,
        reportId: observation.reportId,
        refreshStatus: observation.refreshStatus,
        monthlyActiveViews: observation.monthlyActiveViews,
        snowflakeCredits: observation.snowflakeCredits,
        avgLoadTimeSec: observation.avgLoadTimeSec,
        awsHostingCostUsd: observation.awsHostingCostUsd,
        queryCountLast30d: observation.queryCountLast30d,
        concurrentUserPeak: observation.concurrentUserPeak,
        detectionIds: detectionId == null ? [] : [`detection:${detectionId}`],
        incidentIds: [incidentId],
        ruleCodes: [String(member.rule_code)]
      });
    }
  }
  return {
    packetVersion: EVIDENCE_PACKET_VERSION,
    groupId,
    sessionId: String(group.session_id ?? "seed"),
    reportId: String(group.report_id),
    ruleCode: String(group.rule_code),
    ruleVersion: String(members[0]?.rule_version ?? "unknown"),
    severity: String(group.severity),
    evidenceRefs: [...new Set(evidenceRefs)],
    observations: [...observations.values()],
    thresholds: [...new Set(thresholds)],
    validationFindings: [...new Set(validationFindings)],
    limitations: ["CSV observations have no authoritative event timestamp.", "A threshold breach does not by itself prove a Snowflake or infrastructure root cause."]
  };
}

export function evidencePacketHash(packet: EvidencePacket): string {
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

