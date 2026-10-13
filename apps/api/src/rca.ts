import type { Incident, RcaResult } from "./types.js";
import type { Store } from "./db.js";
import { EventBroker } from "./events.js";
import { buildEvidencePacket, evidencePacketHash, type EvidencePacket } from "./evidence.js";
import { NvidiaProvider, OllamaProvider, RcaProviderExecutionError, type ProviderDiagnosticCategory, type ProviderDiagnostics } from "./providers.js";
import { IncidentToolRegistry, type ToolTraceEntry } from "./tools.js";
import {
  controlledRcaOutputSchema,
  DIAGNOSTIC_ACTION_DESCRIPTIONS,
  HYPOTHESIS_DESCRIPTIONS,
  MISSING_EVIDENCE_DESCRIPTIONS,
  policyForRule,
  RCA_CONTRACT_VERSION,
  type ControlledRcaOutput
} from "./rca-contract.js";

type ProviderMetadata = { toolsUsed?: string[]; toolTrace?: ToolTraceEntry[]; providerRequestCount?: number; analysisDurationMs?: number; diagnostics?: ProviderDiagnostics };

function rejectedFallback(fallback: RcaResult, provider: "ollama" | "nvidia", model: string, reason: string, metadata: ProviderMetadata): RcaResult {
  return {
    ...fallback,
    provider: "deterministic",
    model: null,
    generatedBy: "deterministic",
    validationOutcome: "rejected_fallback",
    fallbackStatus: "validation_rejected",
    validationReason: reason,
    humanReviewRequired: true,
    aiContractVersion: RCA_CONTRACT_VERSION,
    attemptedProvider: provider,
    attemptedModel: model,
    toolsUsed: metadata.toolsUsed ?? fallback.toolsUsed,
    toolTrace: metadata.toolTrace ?? fallback.toolTrace,
    providerRequestCount: metadata.providerRequestCount ?? fallback.providerRequestCount,
    analysisDurationMs: metadata.analysisDurationMs ?? fallback.analysisDurationMs,
    providerDiagnostics: metadata.diagnostics
  };
}

function duplicate(values: readonly string[]) { return new Set(values).size !== values.length; }
function sanitizedProviderError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240); }
function rejectProviderRca(fallback: RcaResult, provider: "ollama" | "nvidia", model: string, reason: string, metadata: ProviderMetadata, stage: NonNullable<ProviderDiagnostics["stage"]>, category: ProviderDiagnosticCategory, issuePaths: string[] = []) {
  const diagnostics = metadata.diagnostics ?? {};
  diagnostics.stage = stage;
  diagnostics.failureCategory = category;
  diagnostics.issuePaths = issuePaths.slice(0, 8).map(path => path.replace(/[^A-Za-z0-9.[\]_]/g, "").slice(0, 80));
  return rejectedFallback(fallback, provider, model, reason, { ...metadata, diagnostics });
}

/**
 * Accept only a backend-controlled RCA selection. Provider text is never used
 * to create displayed facts, causal claims, or executable recommendations.
 */
export function validateProviderRca(raw: unknown, packet: EvidencePacket, fallback: RcaResult, provider: "ollama" | "nvidia", model: string, metadata: ProviderMetadata = {}): RcaResult {
  const parsed = controlledRcaOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const paths = issues.map(issue => issue.path.join("."));
    const first = issues[0];
    const category: ProviderDiagnosticCategory = first?.code === "unrecognized_keys" ? "unexpected_field" : first?.code === "invalid_enum_value" ? "invalid_enum" : first?.code === "invalid_type" && first.expected === "object" ? "wrong_top_level_shape" : first?.code === "invalid_type" && first.received === "undefined" ? "missing_required_field" : "wrong_top_level_shape";
    const reason = category === "unexpected_field" ? "Controlled schema rejected an unexpected field." : category === "missing_required_field" ? "Controlled schema rejected a missing required field." : category === "invalid_enum" ? "Controlled schema rejected an invalid enum value." : "Controlled schema rejected the provider response shape.";
    return rejectProviderRca(fallback, provider, model, reason, metadata, "schema", category, paths);
  }
  const value: ControlledRcaOutput = parsed.data;
  const policy = policyForRule(packet.ruleCode);
  if (!policy) return rejectProviderRca(fallback, provider, model, "No controlled RCA policy exists for this incident rule.", metadata, "policy", "unsupported_rule");
  const allowedHypotheses = new Set(policy.hypotheses);
  const allowedDiagnostics = new Set(policy.diagnostics);
  const allowedMissingEvidence = new Set(policy.missingEvidence);
  if (duplicate(value.hypothesisCodes) || value.hypothesisCodes.some(code => !allowedHypotheses.has(code))) return rejectProviderRca(fallback, provider, model, "Provider selected a hypothesis code outside the incident rule policy.", metadata, "policy", "disallowed_hypothesis", ["hypothesisCodes"]);
  if (duplicate(value.diagnosticActionCodes) || value.diagnosticActionCodes.some(code => !allowedDiagnostics.has(code))) return rejectProviderRca(fallback, provider, model, "Provider selected a diagnostic action outside the incident rule policy.", metadata, "policy", "disallowed_diagnostic", ["diagnosticActionCodes"]);
  if (duplicate(value.missingEvidenceCodes) || value.missingEvidenceCodes.some(code => !allowedMissingEvidence.has(code))) return rejectProviderRca(fallback, provider, model, "Provider selected missing evidence outside the incident rule policy.", metadata, "policy", "disallowed_missing_evidence", ["missingEvidenceCodes"]);
  if (duplicate(value.evidenceBindings.map(binding => binding.hypothesisCode))) return rejectProviderRca(fallback, provider, model, "Provider supplied duplicate evidence bindings.", metadata, "evidence_binding", "duplicate_binding", ["evidenceBindings"]);
  const selectedHypotheses = new Set(value.hypothesisCodes);
  const refs = new Set(packet.evidenceRefs);
  for (const binding of value.evidenceBindings) {
    if (!selectedHypotheses.has(binding.hypothesisCode)) return rejectProviderRca(fallback, provider, model, "Provider bound evidence to an unselected hypothesis.", metadata, "evidence_binding", "missing_evidence_binding", ["evidenceBindings"]);
    if (binding.evidenceRefs.some(ref => !refs.has(ref))) return rejectProviderRca(fallback, provider, model, "Provider referenced evidence outside the incident packet.", metadata, "evidence_binding", "outside_evidence_packet", ["evidenceBindings"]);
    if (!binding.evidenceRefs.some(ref => ref.startsWith("observation:") || ref.startsWith("detection:") || ref.startsWith("incident:"))) return rejectProviderRca(fallback, provider, model, "Provider evidence binding was not source-backed.", metadata, "evidence_binding", "missing_evidence_binding", ["evidenceBindings"]);
  }
  if (value.evidenceBindings.length !== value.hypothesisCodes.length) return rejectProviderRca(fallback, provider, model, "Every selected hypothesis must have a source-backed evidence binding.", metadata, "evidence_binding", "missing_evidence_binding", ["evidenceBindings"]);
  const evidenceRefs = [...new Set(value.evidenceBindings.flatMap(binding => binding.evidenceRefs))];
  const supportedHypotheses = value.hypothesisCodes.map(code => HYPOTHESIS_DESCRIPTIONS[code]);
  const diagnosticActions = value.diagnosticActionCodes.map(code => DIAGNOSTIC_ACTION_DESCRIPTIONS[code]);
  const missingEvidence = value.missingEvidenceCodes.map(code => MISSING_EVIDENCE_DESCRIPTIONS[code]);
  const category = value.hypothesisCodes.length ? "supported_hypothesis" : "insufficient_evidence";
  return {
    ...fallback,
    category,
    // Summary, facts, severity, and limitations remain backend-controlled.
    evidenceRefs: evidenceRefs.length ? evidenceRefs : fallback.evidenceRefs,
    supportedHypotheses,
    potentialCauses: supportedHypotheses,
    recommendedNextSteps: diagnosticActions,
    missingEvidence,
    provider,
    model,
    generatedBy: "ai",
    validationOutcome: "verified",
    validationReason: "Controlled hypothesis, diagnostic, missing-evidence, and source-binding contract accepted; no causal root cause was proven.",
    humanReviewRequired: value.hypothesisCodes.length > 0,
    aiContractVersion: RCA_CONTRACT_VERSION,
    hypothesisCodes: value.hypothesisCodes,
    diagnosticActionCodes: value.diagnosticActionCodes,
    missingEvidenceCodes: value.missingEvidenceCodes,
    evidenceBindings: value.evidenceBindings,
    aiPriorityCode: value.priorityCode,
    analyzedEvidenceHash: evidencePacketHash(packet),
    evidenceStale: false,
    analyzedAt: new Date().toISOString(),
    toolsUsed: metadata.toolsUsed ?? [],
    toolTrace: metadata.toolTrace ?? [],
    providerRequestCount: metadata.providerRequestCount ?? 0,
    analysisDurationMs: metadata.analysisDurationMs ?? 0,
    fallbackStatus: "none",
    providerDiagnostics: metadata.diagnostics
  };
}

function representativeIncident(store: Store, groupId: string): Incident | null {
  const member = store.groupMembers(groupId)[0];
  return member ? store.mapIncident(member) : null;
}

export function deterministicGroupRca(store: Store, packet: EvidencePacket, validationOutcome: RcaResult["validationOutcome"] = "verified", provider: RcaResult["provider"] = "deterministic", metadata: { toolsUsed?: string[]; toolTrace?: ToolTraceEntry[]; providerRequestCount?: number; analysisDurationMs?: number; fallbackStatus?: RcaResult["fallbackStatus"]; diagnostics?: ProviderDiagnostics } = {}): RcaResult {
  const incident = representativeIncident(store, packet.groupId);
  const first = packet.observations[0];
  const refs = packet.evidenceRefs.slice(0, Math.min(packet.evidenceRefs.length, 6));
  const common = { incidentId: String(incident?.id ?? 0), groupId: packet.groupId, evidencePacketVersion: packet.packetVersion, analyzedEvidenceHash: evidencePacketHash(packet), evidenceStale: false, evidenceRefs: refs, investigationPriority: packet.severity as RcaResult["investigationPriority"], provider, model: provider === "deterministic" ? null : (provider === "nvidia" ? process.env.NVIDIA_MODEL ?? null : process.env.OLLAMA_MODEL ?? null), analyzedAt: new Date().toISOString(), validationOutcome, generatedBy: "deterministic" as const, toolsUsed: metadata.toolsUsed ?? [], toolTrace: metadata.toolTrace ?? [], providerRequestCount: metadata.providerRequestCount ?? 0, analysisDurationMs: metadata.analysisDurationMs ?? 0, fallbackStatus: metadata.fallbackStatus ?? (validationOutcome === "provider_failed" ? "provider_failed" : "none"), providerDiagnostics: metadata.diagnostics };
  const report = packet.reportId;
  switch (packet.ruleCode) {
    case "ORPHANED_REPORT_OWNER": return { ...common, category: "confirmed_cause", summary: `Report ${report} has a missing or placeholder owner in the source observation.`, triggeringFacts: packet.validationFindings.filter(f => f.includes("owner")), confirmedFindings: ["Ownership validation failed for the source record."], supportedHypotheses: [], potentialCauses: [], recommendedNextSteps: ["Assign a valid accountable owner and re-run validation."], missingEvidence: ["Authoritative ownership directory"], limitations: [...packet.limitations, "This validates data quality; it does not identify why ownership was lost."] };
    case "NEGATIVE_CREDITS": return { ...common, category: "confirmed_cause", summary: "The source observation contains a negative Snowflake credit value and is excluded from cost attribution.", triggeringFacts: first ? [`snowflake_credits=${first.snowflakeCredits}`] : [], confirmedFindings: ["Negative credits are a confirmed validation defect."], supportedHypotheses: [], potentialCauses: [], recommendedNextSteps: ["Correct the upstream usage record before reporting cost."], missingEvidence: ["Authoritative ACCOUNT_USAGE record"], limitations: [...packet.limitations, "The CSV does not prove an infrastructure failure."] };
    case "REFRESH_FAILED": return { ...common, category: "confirmed_cause", summary: `The refresh status is FAILED for report ${report}.`, triggeringFacts: ["last_refresh_status=FAILED"], confirmedFindings: ["The source explicitly reports a failed refresh."], supportedHypotheses: [], potentialCauses: [], recommendedNextSteps: ["Inspect the refresh job and source connector logs."], missingEvidence: ["Refresh error message", "Job run identifier"], limitations: [...packet.limitations, "A failed status alone does not identify the underlying dependency."] };
    case "REFRESH_TIMED_OUT": return { ...common, category: "confirmed_cause", summary: `The refresh status is TIMED_OUT for report ${report}.`, triggeringFacts: ["last_refresh_status=TIMED_OUT"], confirmedFindings: ["The source explicitly reports a timed-out refresh."], supportedHypotheses: [], potentialCauses: [], recommendedNextSteps: ["Review refresh duration and upstream query execution details."], missingEvidence: ["Refresh elapsed time", "Query execution plan"], limitations: [...packet.limitations, "A timeout status does not prove a specific database cause."] };
    case "REFRESH_UNKNOWN": return { ...common, category: "insufficient_evidence", summary: `Refresh state for report ${report} is UNKNOWN and cannot be classified as success or failure.`, triggeringFacts: ["last_refresh_status=UNKNOWN"], confirmedFindings: [], supportedHypotheses: [], potentialCauses: [], recommendedNextSteps: ["Normalize the upstream refresh status vocabulary."], missingEvidence: ["Source-system status mapping"], limitations: [...packet.limitations, "No causal conclusion is supported."] };
    default: return { ...common, category: "supported_hypothesis", summary: `Report ${report} exceeded the 15 second load-time threshold.`, triggeringFacts: first ? [`avg_load_time_sec=${first.avgLoadTimeSec}`, "threshold=15 seconds"] : ["threshold=15 seconds"], confirmedFindings: ["The latency threshold was exceeded."], supportedHypotheses: ["Slow query execution, concurrency, or application rendering may contribute."], potentialCauses: ["Slow query execution, concurrency, or application rendering may contribute."], recommendedNextSteps: ["Inspect query timings and application traces for the report execution."], missingEvidence: ["Query duration", "Application trace", "Warehouse concurrency metrics"], limitations: [...packet.limitations, "Latency alone does not prove Snowflake contention or any other root cause."] };
  }
}

function markEvidenceFreshness(store: Store, groupId: string, analyzedHash: string, result: RcaResult): RcaResult {
  const latest = buildEvidencePacket(store, groupId);
  const stale = Boolean(latest && evidencePacketHash(latest) !== analyzedHash);
  return {
    ...result,
    analyzedEvidenceHash: analyzedHash,
    evidenceStale: stale,
    humanReviewRequired: Boolean(result.humanReviewRequired || stale),
    validationReason: stale
      ? `${result.validationReason ?? "RCA result generated."} Evidence changed during inference; refresh is required before treating this result as current.`
      : result.validationReason
  };
}

export class RcaManager {
  private active = 0;
  private readonly maxConcurrency = (() => { const value = Number(process.env.RCA_MAX_CONCURRENCY ?? 1); return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1; })();
  private queue: string[] = [];
  private queued = new Set<string>();
  constructor(private store: Store, private broker: EventBroker) {
    this.store.markRunningRcaJobsPending();
    for (const job of this.store.pendingRcaGroups()) this.enqueueGroup(job.groupId);
  }

  enqueue(incident: Incident) { if (incident.groupId) this.enqueueGroup(incident.groupId); }
  async whenIdle() { while (this.active > 0 || this.queue.length > 0) await new Promise(resolve => setTimeout(resolve, 5)); }
  enqueueGroup(groupId: string) {
    const packet = buildEvidencePacket(this.store, groupId);
    if (!packet) return;
    const hash = evidencePacketHash(packet);
    const current = this.store.rcaGroupJob(groupId);
    // A repeated detection can arrive while inference is in flight. Do not
    // enqueue a second job that races the active one or consumes the hosted
    // budget; the current job remains the source of truth for this lifecycle.
    if (current?.status === "running" || (current?.status === "pending" && this.queued.has(groupId))) return;
    if ((current?.status === "completed" || current?.status === "insufficient_evidence") && current.evidence_hash === hash) return;
    if (!this.queued.has(groupId)) {
      this.store.upsertRcaGroupJob(groupId, packet.sessionId, "pending", null, hash);
      this.store.setGroupInvestigationStatus(groupId, "pending");
      this.broker.publish("rca.queued", { jobId: `rca-job:${groupId}`, groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "pending", evidenceHash: hash });
      this.queue.push(groupId); this.queued.add(groupId); this.drain();
    }
  }
  private drain() { while (this.active < this.maxConcurrency && this.queue.length) { const groupId = this.queue.shift()!; this.queued.delete(groupId); this.active += 1; void this.run(groupId).finally(() => { this.active -= 1; this.drain(); }); } }
  private async run(groupId: string) {
    const packet = buildEvidencePacket(this.store, groupId); if (!packet) return;
    const hash = evidencePacketHash(packet); const incident = representativeIncident(this.store, groupId); if (!incident) return;
    this.store.upsertRcaGroupJob(groupId, packet.sessionId, "running", null, hash);
    this.store.setGroupInvestigationStatus(groupId, "running");
    this.broker.publish("rca.status", { groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "running" });
    this.broker.publish("rca.running", { jobId: `rca-job:${groupId}`, groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "running" });
    const requested = String(process.env.RCA_PROVIDER ?? "deterministic").toLowerCase();
    let result: RcaResult; let jobProvider: string | null = "deterministic"; let model: string | null = null;
    const fallback = deterministicGroupRca(this.store, packet);
    try {
      const hosted = requested === "nvidia" || requested === "ollama";
      const configuredBudget = Number(process.env.RCA_MAX_HOSTED_ANALYSES ?? 5); const budget = Number.isFinite(configuredBudget) && configuredBudget >= 0 ? Math.floor(configuredBudget) : 5;
      if (!hosted || this.store.hostedRcaCount(packet.sessionId) >= budget) {
        result = deterministicGroupRca(this.store, packet, "verified", "deterministic", { fallbackStatus: hosted ? "budget_exhausted" : "none" });
        if (hosted) result = { ...result, validationReason: "Hosted RCA analysis budget exhausted; deterministic result retained.", humanReviewRequired: true };
      } else {
        const provider = requested === "nvidia" ? new NvidiaProvider() : new OllamaProvider();
        const response = requested === "nvidia"
          ? await (provider as NvidiaProvider).analyzeWithTools(packet, new IncidentToolRegistry(this.store, groupId), { maxRounds: 3, maxExecutions: 5 })
          : await provider.analyze(packet);
        result = validateProviderRca(response.raw, packet, fallback, response.provider, response.model, { toolsUsed: response.toolsUsed, toolTrace: response.toolTrace, providerRequestCount: response.providerRequestCount, analysisDurationMs: response.analysisDurationMs, diagnostics: response.diagnostics });
        jobProvider = response.provider; model = response.model;
      }
    } catch (error) {
      const metadata = error instanceof RcaProviderExecutionError ? error.metadata : { toolsUsed: [], toolTrace: [], providerRequestCount: 0, analysisDurationMs: 0, diagnostics: undefined };
      result = {
        ...deterministicGroupRca(this.store, packet, "provider_failed", "deterministic", { fallbackStatus: "provider_failed", ...metadata }),
        validationReason: `Hosted provider failed: ${sanitizedProviderError(error)}`,
        humanReviewRequired: true,
        aiContractVersion: RCA_CONTRACT_VERSION,
        attemptedProvider: requested === "nvidia" || requested === "ollama" ? requested : undefined,
        attemptedModel: requested === "nvidia" ? process.env.NVIDIA_MODEL ?? null : requested === "ollama" ? process.env.OLLAMA_MODEL ?? null : null
      };
      result = markEvidenceFreshness(this.store, groupId, hash, result);
      jobProvider = requested === "nvidia" || requested === "ollama" ? requested : "deterministic";
      model = jobProvider === "nvidia" ? process.env.NVIDIA_MODEL ?? null : jobProvider === "ollama" ? process.env.OLLAMA_MODEL ?? null : null;
      this.store.upsertRcaGroupJob(groupId, packet.sessionId, "completed", result, hash, jobProvider, model, result.validationReason);
      this.store.setGroupInvestigationStatus(groupId, result.category === "insufficient_evidence" ? "insufficient_evidence" : "completed");
      this.broker.publish("rca.fallback", { jobId: `rca-job:${groupId}`, groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "fallback", fallbackStatus: result.fallbackStatus, provider: jobProvider, error: result.validationReason });
      this.broker.publish("rca.completed", { groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "completed", result, providerFailed: true });
      return;
    }
    result = markEvidenceFreshness(this.store, groupId, hash, result);
    const status = result.category === "insufficient_evidence" ? "insufficient_evidence" : "completed";
    this.store.upsertRcaGroupJob(groupId, packet.sessionId, status, result, hash, jobProvider, model, result.validationOutcome === "rejected_fallback" ? result.validationReason ?? "Provider output rejected by the controlled RCA validator." : null);
    this.store.setGroupInvestigationStatus(groupId, status);
    if (result.fallbackStatus !== "none") this.broker.publish("rca.fallback", { jobId: `rca-job:${groupId}`, groupId, reportId: packet.reportId, sessionId: packet.sessionId, status: "fallback", fallbackStatus: result.fallbackStatus, provider: jobProvider, validationOutcome: result.validationOutcome, validationReason: result.validationReason });
    this.broker.publish("rca.completed", { groupId, reportId: packet.reportId, sessionId: packet.sessionId, status, result });
  }
}

