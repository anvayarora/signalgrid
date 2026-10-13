/** VIEWER remains as a wire-compatible legacy alias for OWNER. */
export type Role = "ADMIN" | "OWNER" | "ANALYST" | "VIEWER";
export type RefreshStatus = "SUCCESS" | "FAILED" | "TIMED_OUT" | "UNKNOWN";
export type IncidentStatus = "open" | "acknowledged";
export type InvestigationStatus = "pending" | "running" | "completed" | "failed" | "insufficient_evidence";

export interface Observation {
  id: string;
  rowNumber: number;
  reportId: string;
  reportName: string;
  ownerEmail: string;
  ownerNormalized: string | null;
  refreshStatus: RefreshStatus;
  monthlyActiveViews: number;
  snowflakeCredits: number;
  avgLoadTimeSec: number;
  awsHostingCostUsd: number;
  queryCountLast30d: number;
  concurrentUserPeak: number;
  rawJson: string;
}

export interface Incident {
  id: number;
  sessionId: string;
  reportId: string;
  observationId: string;
  ruleCode: string;
  ruleVersion: string;
  severity: "low" | "medium" | "high" | "critical";
  observedMetric: number | null;
  threshold: string;
  evidenceJson: string;
  detectedAt: string;
  simulationTimestamp: string | null;
  status: IncidentStatus;
  investigationStatus: InvestigationStatus;
  groupId?: string;
}

export interface ReplaySession {
  id: string;
  mode: "full" | "curated";
  seed: number;
  speed: number;
  ordering: "sequential" | "seeded-interleaved";
  state: "configured" | "running" | "paused" | "completed" | "reset";
  position: number;
  total: number;
  /** Internal playback order. Never expose this to restricted clients. */
  order: string[];
  startedAt: string | null;
  updatedAt: string;
  principalUsername?: string | null;
  principalRole?: Role | null;
  scopeReportIds?: string[] | null;
  /** True only for the shared, completed full-dataset evaluation. */
  sharedEvaluation?: boolean;
}

export interface ReportAssignment {
  username: string;
  reportId: string;
  role: "OWNER" | "ANALYST";
  provenance: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RcaResult {
  incidentId: string;
  groupId: string;
  evidencePacketVersion: string;
  /** Hash of the exact packet supplied to the provider or deterministic analyzer. */
  analyzedEvidenceHash?: string;
  /** True when replay evidence changed while this analysis was running. */
  evidenceStale?: boolean;
  category: "confirmed_cause" | "supported_hypothesis" | "insufficient_evidence";
  summary: string;
  triggeringFacts: string[];
  evidenceRefs: string[];
  confirmedFindings: string[];
  supportedHypotheses: string[];
  potentialCauses: string[];
  investigationPriority: "low" | "medium" | "high" | "critical";
  recommendedNextSteps: string[];
  missingEvidence: string[];
  limitations: string[];
  provider: "deterministic" | "ollama" | "nvidia";
  model: string | null;
  analyzedAt: string;
  validationOutcome: "verified" | "rejected_fallback" | "provider_failed";
  generatedBy: "deterministic" | "ai";
  /** `verified` means the controlled provider contract and evidence policy passed; it never proves an infrastructure root cause. */
  validationReason?: string;
  humanReviewRequired?: boolean;
  aiContractVersion?: string;
  attemptedProvider?: "ollama" | "nvidia";
  attemptedModel?: string | null;
  hypothesisCodes?: string[];
  diagnosticActionCodes?: string[];
  missingEvidenceCodes?: string[];
  evidenceBindings?: Array<{ hypothesisCode: string; evidenceRefs: string[] }>;
  aiPriorityCode?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  toolsUsed: string[];
  toolTrace: Array<{ id: string; name: string; round: number; argumentsHash: string; ok: boolean }>;
  providerRequestCount: number;
  analysisDurationMs: number;
  fallbackStatus: "none" | "budget_exhausted" | "provider_failed" | "validation_rejected";
  providerDiagnostics?: {
    httpStatus?: number;
    finishReason?: string | null;
    contentKind?: "null" | "empty" | "text" | "parts" | "unsupported";
    toolCallCount?: number;
    outputTruncated?: boolean;
    parseOutcome?: "accepted" | "empty" | "malformed_json" | "truncated" | "unsupported";
    stage?: "transport" | "evidence_acquisition" | "finalization" | "parse" | "schema" | "policy" | "evidence_binding";
    failureCategory?: string;
    issuePaths?: string[];
    policyRule?: string;
    finalizationMode?: "json_mode" | "tool_free";
    toolChoice?: "required" | "auto" | "none";
    responseFormat?: "json_object";
    reasoningDisabled?: boolean;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}
