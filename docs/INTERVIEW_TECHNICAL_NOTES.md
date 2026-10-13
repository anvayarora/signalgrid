# Interview technical notes

## Why the replay is backend-first

The CSV is treated as an immutable source extract. Import assigns stable observation IDs and records a content hash. Replay adds a seeded ordering and simulation timestamp without mutating the source row or pretending that repeated report rows form a chronological history. Sequential and seeded-interleaved playback share the same processing loop, so the curated evaluator path and the 2,000-row path exercise the same rules.

## Why detection and incidents are separate

Detection events are an audit ledger: every latency breach, failed or timed-out refresh, orphan owner, negative credit, and explicit unknown status is retained. Incidents are actionable report/rule/session groups. Grouping prevents 1,490 latency breaches from becoming 1,490 repeated dashboard notifications while preserving occurrence counts and every evidence link. A meaningful state or severity change can update a group without deleting detections.

## Why zero views and unknown states are special

Zero views are valid source observations but produce a null cost-per-view rather than an operational alert or divide-by-zero value. Negative credits are validation defects and are excluded from attribution. `UNKNOWN` refresh status is explicit data-quality state; it is not silently treated as `FAILED`.

## Why RCA is asynchronous

The incident event is persisted and published before the RCA worker runs. Evidence is compact, source-backed, and hash-addressed. A completed result is reused while the packet hash is unchanged, so repeated observations do not cause a fresh model call. New evidence changes the hash and permits re-analysis. NVIDIA/Ollama are optional; deterministic RCA keeps the workflow functional when a provider is unavailable.

## Tool-calling safety boundary

The NVIDIA path is backend-owned and allowlisted to five read-only tools: incident evidence, bounded report observations, cost breakdown, related detections, and rule definition. Tool arguments are strict and report/group scoped. The validator rejects unknown evidence references, fabricated numbers, unsupported confirmed-cause claims, malformed output, and over-budget investigations. Stored results distinguish confirmed validation defects, supported hypotheses, and insufficient evidence.

## Cost attribution boundary

The API and Snowflake SQL use the same row-level semantics: valid credits only, null-safe zero-view handling, and report-level median of valid row ratios rather than a ratio of medians. The Snowflake reference file allocates query-attributed credits across overlapping hour buckets to avoid double counting. That path remains an integration template until executed against a real account.

## Honest demo language

The demo proves deterministic backend monitoring over real source observations. It does not prove that a Snowflake outage occurred, that CSV row order is historical chronology, or that an external model completed a full RCA unless the run records `provider=nvidia`, `generatedBy=ai`, `validationOutcome=verified`, provider request metadata, and a persisted tool trace. The latest hosted full-RCA attempt is not verified: Lightning completed tool calling but its final response failed the controlled schema and SignalGrid persisted a deterministic `rejected_fallback` rather than overstating an AI success.
