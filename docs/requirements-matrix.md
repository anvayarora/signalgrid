# Case Study 3 requirements matrix

| Mandatory requirement | Implementation | Verification | Status |
|---|---|---|---|
| React frontend + Node/Express backend | `apps/web`, `apps/api` | `npm run build`, browser walkthrough | Implemented |
| RBAC and demo authentication | `apps/api/src/auth.ts`, `apps/api/src/server.ts` | 25-test suite: demo accounts, analyst login, assignment-scoped reads/replay, expiry/logout, active SSE closure, rate limiting, backend 401/403 enforcement | Implemented |
| Report health and orphaned reports | `/api/reports`, report UI, quality findings | CSV import assertions + UI | Implemented |
| Live alert when latency > 15s | `apps/api/src/detection.ts`, SSE | Detection test and replay | Implemented |
| Live alert when refresh fails | `REFRESH_FAILED` rule + SSE | Detection test and replay | Implemented |
| Snowflake cost attribution SQL | `scripts/snowflake/01-04` | SQL validation queries | Implemented |
| Invalid credits and zero views | importer, cost engine, SQL | expected counts and null-safe formulas | Implemented |
| AWS cost-versus-usage discrepancy review | report-level median AWS cost/view, Q3 + 1.5×IQR review flag, independent Snowflake-credit validity | cost API parity test and `/api/data-quality` methodology | Implemented |
| REST and SSE specification | `docs/API.md` | schema documented | Implemented |
| Backend telemetry replay and evaluator demo | persisted full/curated sessions, seeded ordering, prepare/start cursor handshake, session-filtered SSE, pause/resume/reset/step/restart, administrator entry modes, idempotent completed full evaluation, active-session scoped metrics | `tests/api.test.ts` evaluator-demo + all-2,000-row evaluation tests; browser walkthrough | Implemented |
| Supplied CSV integrity and deterministic anomaly counts | immutable 2,000-row source, stable observation IDs, content hash, expected anomaly counters | ingestion and cost-parity tests; browser readiness metrics | Implemented |
| Actionable aggregation without evidence loss | report/rule/session grouping with occurrence counts and source references | grouped incident and curated `incident.updated` tests | Implemented |
| Persistent report responsibility and scoped access | `report_assignments`, assignment audit, ownership-quality DTOs, report/incident/cost/evidence/SSE filtering before aggregation | assignment-scope and assignment-audit regression tests; API contract | Implemented |
| Evaluator documentation and review handoff | evaluator guide, final verification record, interview notes, sanitized archive procedure | docs and archive inventory | Implemented |
| Premium authenticated operational dashboard | light glass workspace, retractable sidebar, source-backed metric cards, React Flow health map, Recharts cost/latency views, shared report/incident inspectors, responsive layout | docs/dashboard-design.md, browser walkthrough, npm run build | Implemented |
| Approved light landing, sign-in and unified brand | `/` mission hero, animated SVG signal timeline, `/signin` two-column real authentication, reusable SVG logo, Onest typography, dashboard logo reuse | docs/public-experience.md, public/authenticated screenshots, browser role walkthrough, npm run build | Implemented |
| AI enhancement | asynchronous persisted group RCA with five strict read-only tools, evidence hash/cache reuse, bounded multi-turn NVIDIA loop, controlled code-only output contract, strict validation, deterministic fallback, optional NVIDIA/Ollama providers | mocked tool-call cycle, 21-test regression suite, live hosted attempt metadata and fallback outcome documented | Optional, implemented; full hosted investigation remains provider-limited |

## Role permission matrix

| Capability | `ADMIN` | `OWNER` | `ANALYST` |
|---|---:|---:|---:|
| Overview, reports, incidents, evidence, RCA, Cloud Costs | All | Assigned reports | Assigned reports |
| Replay SSE stream | All sessions | Assigned sessions/reports | Assigned sessions/reports |
| Configure/start/pause/resume/step/reset/restart replay | Full | Scoped endpoints | Scoped endpoints |
| Acknowledge incidents | Allow | Assigned incidents | Deny (`403`) |
| Direct access to another principal's replay session | Allow | Deny (`403`) | Deny (`403`) |

Demo credentials are enabled only when `SIGNALGRID_DEMO_AUTH=true`: `admin` / `admin123`, `user` / `user123`, and `analyst` / `analyst123`. Outside demo mode, those predictable credentials are rejected. Legacy `VIEWER` claims are normalized to OWNER scope and never regain broad access.

## Explicitly unverified integrations

- Full backend-to-hosted-NVIDIA RCA completion is **not verified**: the real curated lifecycle with Lightning completed two requests and one read-only tool call, but the final model output failed the controlled schema and was persisted as `rejected_fallback`. The separate structured tool-call smoke is verified.
- Snowflake execution, including `ACCOUNT_USAGE`, is **not verified** because no Snowflake account was available. The SQL is runnable reference code and local formula parity is verified.

The PDF assessment remains the source of mandatory scope; the pasted SignalGrid mandate adds engineering quality and documentation expectations.
