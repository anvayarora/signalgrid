# NVIDIA RCA and tool-call contract

SignalGrid keeps alerting independent of inference:

```text
observation -> validation -> detection event -> incident group
  -> persisted SSE alert -> queued RCA job -> NVIDIA tool calls
  -> backend tool results -> final JSON -> validator -> stored RCA event
```

The RCA worker uses `POST /v1/chat/completions` with `stream: false`, a configurable model, a 45-second request timeout (bounded to 60 seconds), a configurable investigation timeout (`RCA_TOTAL_TIMEOUT_MS`, default 150 seconds), at most five tool executions, one bounded retry with capped backoff for transient transport/rate-limit/server errors, and hosted-investigation budget `RCA_MAX_HOSTED_ANALYSES`. Evidence acquisition and finalization are separate phases: the first request can select only the five read-only tools, then the final request has no tools, `tool_choice: "none"`, `response_format: {"type":"json_object"}`, and `chat_template_kwargs: {"enable_thinking": false}` for the Lightning endpoint. If a compatible gateway rejects those optional final controls, one bounded tool-free retry omits only those optional fields. A provider error, unavailable model, budget exhaustion, malformed/null/truncated response, unsupported evidence reference, fabricated number, or causal claim without validation evidence produces a deterministic result and never delays the initial alert.

Hosted RCA is explicit-only. Replay auto-queues deterministic RCA for the local demo, but when `RCA_PROVIDER=nvidia` or `RCA_PROVIDER=ollama` is configured, replay does not enqueue provider work unless the caller explicitly enables `autoRca` or requests an investigation through the authorized RCA action. This keeps the first alert/SSE event independent of provider latency and prevents a replay from silently consuming hosted inference budget.

## Read-only tool registry

Tool arguments are strict objects (`additionalProperties: false`). The worker executes only these backend-owned tools, and all report-scoped tools must match the report in the current incident group:

| Tool | Required input | Returned evidence |
| --- | --- | --- |
| `get_incident_evidence` | `incident_group_id` | Compact packet, thresholds, findings, source/evidence references |
| `get_report_observations` | `report_id`, optional `limit` 1–100 | Bounded metrics and stable source-row identifiers; explicitly no chronology |
| `get_report_cost_breakdown` | `report_id` | Valid/invalid credit counts, zero-view count, median valid row ratios |
| `get_related_detections` | `incident_group_id` | Every preserved detection and source-row reference in the group |
| `get_rule_definition` | `rule_id` | Deterministic threshold, severity, measured field, limitations |

Tool results never contain owner emails, authentication material, environment variables, SQL, shell commands, raw CSV JSON, or filesystem paths. Unknown tools, malformed JSON, extra parameters, out-of-context group/report IDs, repeated identical calls, and oversized results are rejected. During active replay, report observations and cost breakdowns are limited to the processed prefix of that session's order; a completed evaluation may expose the full authorized report history. This prevents an RCA from looking ahead into future source rows.

The persisted `rca_group_jobs` record has a stable job ID, evidence hash, provider/model, status, attempts, timestamps, error, and tool trace. A completed result is reused while its evidence hash is unchanged; a materially changed packet queues a new analysis.

## Output and validation

Inference providers now return the strict `controlled-v1` contract only:

```json
{
  "hypothesisCodes": [],
  "diagnosticActionCodes": [],
  "missingEvidenceCodes": [],
  "evidenceBindings": [{ "hypothesisCode": "...", "evidenceRefs": [] }],
  "priorityCode": "LOW|MEDIUM|HIGH|CRITICAL"
}
```

The backend rejects extra fields and free text, checks each enum against the incident-rule policy, requires one source-backed evidence binding per selected hypothesis, and renders descriptions from backend templates. Provider output never supplies confirmed measurements, thresholds, identifiers, severities, causal summaries, or executable commands.

Stored results distinguish:

- confirmed validation defects, such as a negative credit value or an explicitly failed refresh;
- supported hypotheses, which are clearly labelled as hypotheses; and
- insufficient evidence or unknown root causes.

The validator checks the controlled schema, rule/code relationships, evidence bindings, and source-reference scope. The model receives a serialized policy generated from `policyForRule(ruleCode)`, including only codes and evidence references valid for that incident. Unknown rules have no provider policy and fail closed. `validationOutcome=verified` means the controlled selection contract passed; it does not mean that a hypothesis is a causally proven root cause. Rejected output produces deterministic fallback with `fallbackStatus=validation_rejected`, a sanitized `validationReason`, and `humanReviewRequired=true`. Results expose `provider`, `model`, `toolsUsed`, `toolTrace`, `analysisDurationMs`, `validationOutcome`, `fallbackStatus`, `aiContractVersion`, and human-review metadata for evaluator inspection.

Provider failures also preserve the attempted provider/model separately from the deterministic result and retain bounded request-count, duration, tool trace, finish reason, content representation, token counts, parse outcome, validation stage, sanitized failure category, and safe issue paths where available. JSON parsing is recorded separately from schema, policy, and evidence-binding acceptance: `parseOutcome=accepted` means only that JSON parsing succeeded. Null, multipart, fenced, malformed, and truncated response variants are handled explicitly; an output ending because of a token limit is never treated as a valid final answer. The failure reason is sanitized before persistence; no authorization material, raw provider response, private identifier or source transcript is stored.

## Live-provider verification

`npm run nvidia:smoke` performs a real non-streaming two-request structured tool-call cycle when a private environment file contains `NVIDIA_KEY`. The documented candidates were checked against the configured endpoint: `nvidia/nemotron-3.5-lightning-30b-a3b` returned HTTP 200 with a structured `tool_calls` response and completed the follow-up cycle; `nvidia/nemotron-3-super-120b-a12b` also returned structured tool calls; `nvidia/nemotron-3-ultra-550b-a55b` returned a plain completion without a tool call. SignalGrid therefore selects Lightning 30B as the default documented tool-capable model while allowing an explicit override. The smoke run passed with Lightning 30B. Mocked multi-turn, malformed, unknown-tool, isolation, evidence, and budget tests remain in `tests/api.test.ts`; the deterministic pipeline stays fully functional with AI disabled.

The separate full backend-to-hosted-RCA harness is intentionally stricter: it requires a persisted NVIDIA result, verified controlled-contract outcome, at least two provider requests, and a tool trace. The prior Lightning run reached HTTP 200 and called all five tools, but its unconstrained final response failed the controlled schema and was correctly persisted as `rejected_fallback`. The repaired harness reports connection, structured tool call, tool-result delivery, JSON parsing, controlled schema, rule policy, evidence bindings, persistence, SSE lifecycle, and authorized API retrieval as separate stages, and exits nonzero unless the final persisted result is accepted NVIDIA analysis. An earlier private smoke record is retained as historical evidence of structured tool calling; this checkout's current full run has not been executed because no private `NVIDIA_KEY`/`SIGNALGRID_ENV_FILE` was present in the execution environment. The current `npm run nvidia:smoke` therefore stopped before contacting NVIDIA. Do not treat the deterministic fallback or the isolated mocked integration test as hosted proof. Run `RUN_LIVE_NVIDIA=1 SIGNALGRID_ENV_FILE=/path/to/private.env npm run nvidia:integration` once a private environment is available.
