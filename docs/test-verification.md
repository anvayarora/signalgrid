# Verification report

Run from the repository root:

```bash
npm test
npm run build
```

The test suite currently passes 28/28 with temporary localhost binding enabled. It verifies:

- exact 2,000-row ingestion, source hash and anomaly counts;
- idempotent import and session-scoped detection;
- seeded ordering, pause/resume, reset, single-step and full 2,000-row replay;
- curated coverage for latency, failed/timed-out refresh, orphan owner, negative credits and zero views;
- boundary behavior at exactly 15 seconds;
- grouped incident deduplication without losing detection evidence;
- SSE catch-up beyond 100 events;
- bearer/SSE-ticket authentication, isolated three-role demo accounts, expiry/logout, rate-limited sign-in, assignment-filtered SSE, and administrator-only controls;
- established SSE streams closing immediately on logout and after session expiry;
- strict tool arguments, unknown tools, context isolation, multi-turn tool calls and round limits;
- adversarial RCA validation for fabricated numbers, unknown evidence, unsupported causal claims and provider failure fallback;
- restart-demo creation of a fresh session while preserving the previous audit trail.
- evaluator-demo readiness, paused prepare/start subscription handshake, session-filtered SSE stages, grouped incident update, RCA queue events, and restart isolation.
- cost-attribution parity between the API and a direct source-row calculation.
- strict code-only RCA output, unsafe text rejection across every legacy field, invalid policy codes, cross-incident bindings, hostile metadata isolation, AWS validity independence, cost-versus-usage quality flags, active restart behavior, and provider-failure metadata preservation.
- zero-assignment replay denial and cross-session private-admin isolation without exposing restricted playback order.

The live NVIDIA smoke passed with `nvidia/nemotron-3.5-lightning-30b-a3b`: the first request produced an actual structured tool call and the second request accepted the matching `tool_call_id` and returned a final message. The application still treats NVIDIA as optional; missing keys, provider failures, validation rejection, budget exhaustion, and timeouts all emit a fallback status without delaying detection or alert delivery.

The hosted full-RCA harness completed real curated replay lifecycles and persisted the alert/RCA stages. The configured Qwen attempt returned HTTP 410. The bounded Lightning attempt made two provider requests and one real read-only tool call, but its final response failed the controlled RCA schema and was persisted as `rejected_fallback`. It is therefore not reported as a successful NVIDIA RCA. Snowflake SQL was statically reviewed and locally reconciled; no cloud-account execution is claimed.
