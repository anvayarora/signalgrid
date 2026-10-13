import { z } from "zod";

export const RCA_CONTRACT_VERSION = "controlled-v1" as const;

export const hypothesisCodeSchema = z.enum([
  "QUERY_EXECUTION_DELAY",
  "ELEVATED_WORKLOAD_OR_CONCURRENCY",
  "APPLICATION_RENDERING_DELAY",
  "REFRESH_DEPENDENCY_FAILURE",
  "REFRESH_UPSTREAM_DELAY",
  "REFRESH_STATUS_MAPPING",
  "OWNERSHIP_DATA_QUALITY_PROCESS",
  "NEGATIVE_CREDIT_SOURCE_DATA_DEFECT",
  "UNKNOWN_UNDERLYING_CAUSE"
]);
export type HypothesisCode = z.infer<typeof hypothesisCodeSchema>;

export const diagnosticActionCodeSchema = z.enum([
  "INSPECT_QUERY_EXECUTION_PROFILE",
  "EXAMINE_WAREHOUSE_CONCURRENCY",
  "COMPARE_APPLICATION_LATENCY_BREAKDOWN",
  "REVIEW_REFRESH_LOGS",
  "INSPECT_UPSTREAM_DEPENDENCY_LOGS",
  "NORMALIZE_REFRESH_STATUS",
  "VALIDATE_SOURCE_OWNERSHIP",
  "CHECK_UPSTREAM_USAGE_RECORD"
]);
export type DiagnosticActionCode = z.infer<typeof diagnosticActionCodeSchema>;

export const missingEvidenceCodeSchema = z.enum([
  "QUERY_EXECUTION_PROFILE",
  "WAREHOUSE_CONCURRENCY_METRICS",
  "APPLICATION_LATENCY_BREAKDOWN",
  "REFRESH_ERROR_DETAILS",
  "JOB_RUN_IDENTIFIER",
  "UPSTREAM_DEPENDENCY_LOGS",
  "SOURCE_STATUS_MAPPING",
  "AUTHORITATIVE_OWNERSHIP_DIRECTORY",
  "AUTHORITATIVE_ACCOUNT_USAGE_RECORD",
  "SOURCE_USAGE_LINEAGE"
]);
export type MissingEvidenceCode = z.infer<typeof missingEvidenceCodeSchema>;

export const priorityCodeSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type PriorityCode = z.infer<typeof priorityCodeSchema>;

const evidenceBindingSchema = z.object({
  hypothesisCode: hypothesisCodeSchema,
  evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(10)
}).strict();

/** The only shape accepted from an inference provider. It intentionally has no free-text fields. */
export const controlledRcaOutputSchema = z.object({
  hypothesisCodes: z.array(hypothesisCodeSchema).max(4),
  diagnosticActionCodes: z.array(diagnosticActionCodeSchema).max(4),
  missingEvidenceCodes: z.array(missingEvidenceCodeSchema).max(5),
  evidenceBindings: z.array(evidenceBindingSchema).max(4),
  priorityCode: priorityCodeSchema
}).strict();
export type ControlledRcaOutput = z.infer<typeof controlledRcaOutputSchema>;

export type RcaPolicy = {
  ruleCode: string;
  hypotheses: readonly HypothesisCode[];
  diagnostics: readonly DiagnosticActionCode[];
  missingEvidence: readonly MissingEvidenceCode[];
};

const policyByRule: Record<string, Omit<RcaPolicy, "ruleCode">> = {
  LATENCY_OVER_15S: {
    hypotheses: ["QUERY_EXECUTION_DELAY", "ELEVATED_WORKLOAD_OR_CONCURRENCY", "APPLICATION_RENDERING_DELAY", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["INSPECT_QUERY_EXECUTION_PROFILE", "EXAMINE_WAREHOUSE_CONCURRENCY", "COMPARE_APPLICATION_LATENCY_BREAKDOWN"],
    missingEvidence: ["QUERY_EXECUTION_PROFILE", "WAREHOUSE_CONCURRENCY_METRICS", "APPLICATION_LATENCY_BREAKDOWN"]
  },
  REFRESH_FAILED: {
    hypotheses: ["REFRESH_DEPENDENCY_FAILURE", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["REVIEW_REFRESH_LOGS", "INSPECT_UPSTREAM_DEPENDENCY_LOGS"],
    missingEvidence: ["REFRESH_ERROR_DETAILS", "JOB_RUN_IDENTIFIER", "UPSTREAM_DEPENDENCY_LOGS"]
  },
  REFRESH_TIMED_OUT: {
    hypotheses: ["REFRESH_UPSTREAM_DELAY", "ELEVATED_WORKLOAD_OR_CONCURRENCY", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["REVIEW_REFRESH_LOGS", "INSPECT_QUERY_EXECUTION_PROFILE", "EXAMINE_WAREHOUSE_CONCURRENCY"],
    missingEvidence: ["REFRESH_ERROR_DETAILS", "QUERY_EXECUTION_PROFILE", "UPSTREAM_DEPENDENCY_LOGS"]
  },
  REFRESH_UNKNOWN: {
    hypotheses: ["REFRESH_STATUS_MAPPING", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["NORMALIZE_REFRESH_STATUS"],
    missingEvidence: ["SOURCE_STATUS_MAPPING"]
  },
  ORPHANED_REPORT_OWNER: {
    hypotheses: ["OWNERSHIP_DATA_QUALITY_PROCESS", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["VALIDATE_SOURCE_OWNERSHIP"],
    missingEvidence: ["AUTHORITATIVE_OWNERSHIP_DIRECTORY"]
  },
  NEGATIVE_CREDITS: {
    hypotheses: ["NEGATIVE_CREDIT_SOURCE_DATA_DEFECT", "UNKNOWN_UNDERLYING_CAUSE"],
    diagnostics: ["CHECK_UPSTREAM_USAGE_RECORD"],
    missingEvidence: ["AUTHORITATIVE_ACCOUNT_USAGE_RECORD", "SOURCE_USAGE_LINEAGE"]
  }
};

export function policyForRule(ruleCode: string): RcaPolicy | null {
  const policy = policyByRule[ruleCode];
  return policy ? { ruleCode, ...policy } : null;
}

export type SerializedRcaPolicy = {
  contractVersion: typeof RCA_CONTRACT_VERSION;
  supported: boolean;
  ruleCode: string;
  allowedHypothesisCodes: readonly HypothesisCode[];
  allowedDiagnosticActionCodes: readonly DiagnosticActionCode[];
  allowedMissingEvidenceCodes: readonly MissingEvidenceCode[];
  allowedPriorityCodes: readonly PriorityCode[];
  permissibleEvidenceRefs: readonly string[];
  evidenceBindingRequirements: {
    oneBindingPerSelectedHypothesis: true;
    evidenceRefsPerBinding: { min: 1; max: 10 };
    allowedPrefixes: readonly ["observation:", "detection:", "incident:"];
  };
  arrayLimits: { hypothesisCodes: 4; diagnosticActionCodes: 4; missingEvidenceCodes: 5; evidenceBindings: 4 };
  requiredJsonShape: {
    hypothesisCodes: "string[]";
    diagnosticActionCodes: "string[]";
    missingEvidenceCodes: "string[]";
    evidenceBindings: "{hypothesisCode:string,evidenceRefs:string[]}[]";
    priorityCode: "LOW|MEDIUM|HIGH|CRITICAL";
  };
  sourceDataLimitations: readonly string[];
};

/**
 * Serialize the complete, backend-owned finalization policy. The model gets
 * only enum values and evidence references already present in this packet;
 * client input cannot widen this policy.
 */
export function serializeRcaPolicy(ruleCode: string, evidenceRefs: readonly string[]): SerializedRcaPolicy {
  const policy = policyForRule(ruleCode);
  const base = {
    contractVersion: RCA_CONTRACT_VERSION,
    supported: Boolean(policy),
    ruleCode,
    allowedPriorityCodes: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const,
    permissibleEvidenceRefs: [...new Set(evidenceRefs)].slice(0, 200),
    evidenceBindingRequirements: {
      oneBindingPerSelectedHypothesis: true as const,
      evidenceRefsPerBinding: { min: 1 as const, max: 10 as const },
      allowedPrefixes: ["observation:", "detection:", "incident:"] as const
    },
    arrayLimits: { hypothesisCodes: 4 as const, diagnosticActionCodes: 4 as const, missingEvidenceCodes: 5 as const, evidenceBindings: 4 as const },
    requiredJsonShape: {
      hypothesisCodes: "string[]" as const,
      diagnosticActionCodes: "string[]" as const,
      missingEvidenceCodes: "string[]" as const,
      evidenceBindings: "{hypothesisCode:string,evidenceRefs:string[]}[]" as const,
      priorityCode: "LOW|MEDIUM|HIGH|CRITICAL" as const
    },
    sourceDataLimitations: [
      "Source observations have no authoritative event timestamp.",
      "A deterministic threshold breach does not prove an infrastructure root cause.",
      "Selected hypotheses are possible explanations for investigation, not confirmed causes."
    ] as const
  };
  return policy ? { ...base, allowedHypothesisCodes: policy.hypotheses, allowedDiagnosticActionCodes: policy.diagnostics, allowedMissingEvidenceCodes: policy.missingEvidence } : {
    ...base,
    allowedHypothesisCodes: [],
    allowedDiagnosticActionCodes: [],
    allowedMissingEvidenceCodes: []
  };
}

export const HYPOTHESIS_DESCRIPTIONS: Record<HypothesisCode, string> = {
  QUERY_EXECUTION_DELAY: "Possible query execution delay.",
  ELEVATED_WORKLOAD_OR_CONCURRENCY: "Elevated workload or concurrency might contribute.",
  APPLICATION_RENDERING_DELAY: "Application-side rendering delay might contribute.",
  REFRESH_DEPENDENCY_FAILURE: "An upstream refresh dependency might have failed.",
  REFRESH_UPSTREAM_DELAY: "An upstream refresh dependency might be delayed.",
  REFRESH_STATUS_MAPPING: "The refresh status vocabulary might be incomplete or inconsistently mapped.",
  OWNERSHIP_DATA_QUALITY_PROCESS: "An ownership-data quality process issue might contribute.",
  NEGATIVE_CREDIT_SOURCE_DATA_DEFECT: "An upstream usage-data defect might contribute to the negative value.",
  UNKNOWN_UNDERLYING_CAUSE: "The underlying cause is unknown from the available evidence."
};

export const DIAGNOSTIC_ACTION_DESCRIPTIONS: Record<DiagnosticActionCode, string> = {
  INSPECT_QUERY_EXECUTION_PROFILE: "Inspect query execution profiles.",
  EXAMINE_WAREHOUSE_CONCURRENCY: "Examine warehouse concurrency metrics.",
  COMPARE_APPLICATION_LATENCY_BREAKDOWN: "Compare application latency breakdowns.",
  REVIEW_REFRESH_LOGS: "Review report-refresh logs.",
  INSPECT_UPSTREAM_DEPENDENCY_LOGS: "Inspect upstream dependency logs.",
  NORMALIZE_REFRESH_STATUS: "Normalize the source refresh-status vocabulary.",
  VALIDATE_SOURCE_OWNERSHIP: "Validate source ownership information.",
  CHECK_UPSTREAM_USAGE_RECORD: "Check the upstream usage record."
};

export const MISSING_EVIDENCE_DESCRIPTIONS: Record<MissingEvidenceCode, string> = {
  QUERY_EXECUTION_PROFILE: "Query execution profile",
  WAREHOUSE_CONCURRENCY_METRICS: "Warehouse concurrency metrics",
  APPLICATION_LATENCY_BREAKDOWN: "Application latency breakdown",
  REFRESH_ERROR_DETAILS: "Refresh error details",
  JOB_RUN_IDENTIFIER: "Refresh job run identifier",
  UPSTREAM_DEPENDENCY_LOGS: "Upstream dependency logs",
  SOURCE_STATUS_MAPPING: "Authoritative source-status mapping",
  AUTHORITATIVE_OWNERSHIP_DIRECTORY: "Authoritative ownership directory",
  AUTHORITATIVE_ACCOUNT_USAGE_RECORD: "Authoritative ACCOUNT_USAGE record",
  SOURCE_USAGE_LINEAGE: "Source usage lineage"
};
