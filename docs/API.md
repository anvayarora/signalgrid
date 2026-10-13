# REST and SSE specification

Base URL: `http://localhost:4000`. Login returns a short-lived random bearer token; send it as `Authorization: Bearer <token>`. The API returns `{ "error": string, "code"?: string }` for errors.

## Authentication

- `GET /api/auth/config` -> `{ demoAuthEnabled }`; this public flag contains no credentials.
- `POST /api/auth/login` body `{ "username": "admin|user|analyst", "password": "..." }` -> `{ token, user: { username, role: "ADMIN"|"OWNER"|"ANALYST" }, expiresAt }`. In isolated demo mode (`SIGNALGRID_DEMO_AUTH=true`), the exact accounts are `admin` / `admin123`, `user` / `user123` and `analyst` / `analyst123`. Outside demo mode, only private environment credentials are accepted; old `VIEWER` claims are normalized to least-privileged OWNER scope.
- `GET /api/auth/me` -> current user.
- `POST /api/auth/logout` -> revokes the bearer session and all SSE tickets issued from it; any established SSE stream tied to that session is closed immediately.
- `POST /api/events/ticket` -> a short-lived SSE ticket. The ticket is the only credential accepted in the EventSource URL; bearer tokens are never placed in query strings.

Login failures use one generic `401` response. Sign-in is rate-limited per client address. Expired or revoked bearer tokens return `401`; an authenticated OWNER or ANALYST calling an administrator-only operation returns `403` with `{ "code": "FORBIDDEN" }`.

## Read endpoints

- `GET /health`
- `GET /api/demo/readiness` -> authenticated readiness, dataset provenance, active session, no-autoplay state, and provider availability (never the NVIDIA key). `rca` includes `providerConfigured`, `providerReachable`, `lastVerifiedSuccess`, `lastCompletedOutcome`, `lastCompletedAt`, `deterministicFallbackAvailable`, and `model`; configured means a key/model is present, reachable means a persisted hosted job completed without provider error, and verified success additionally requires an accepted AI result.
- `GET /api/overview`
- `GET /api/analytics` -> authenticated source-backed chart aggregates for the latency distribution, refresh health, report review priorities, finding categories, and persisted replay activity. Values are derived from the preserved observations; no frontend-generated metrics are returned.
- `GET /api/notifications?limit=60` -> persisted incident/RCA/replay lifecycle notifications scoped to the current replay session, used to restore the authenticated notification menu after refresh.
- `GET /api/reports?page=1&pageSize=25&search=&orphaned=false`
- `GET /api/reports/:reportId`
- `GET /api/data-quality?limit=200` -> importer findings plus deterministic `costUsageQuality` review metadata.
- `GET /api/incidents?severity=&status=&search=&limit=100`
- `GET /api/incidents?sessionId=...` -> optionally scopes the actionable queue to one replay session.
- `GET /api/incidents/occurrences?sessionId=&limit=100` -> row-level audit records.
- `GET /api/incidents/:id` -> one row-level occurrence.
- `GET /api/incident-groups/:groupId` -> group lifecycle, all members, source evidence and RCA.
- `POST /api/incident-groups/:groupId/rca` -> authorized, idempotent RCA request; returns the persisted `jobId`, current status, session ID and evidence hash. Opening an incident alone does not require a hosted provider call.
- `GET /api/costs` -> independent Snowflake-credit and AWS hosting-cost validity, null-safe ratios, and `costUsageQuality` outlier review metadata.
- `GET /api/assignments` -> the caller's report assignments; administrators also receive the assignment audit trail.
- `GET /api/reports/:reportId/ownership` -> observed source-owner candidates, missing/placeholder counts, conflict state, and separate application assignment responsibility.
- `GET /api/reports/:reportId/investigation-brief` and `GET /api/incident-groups/:groupId/investigation-brief` -> deterministic, source-backed measurements, rule thresholds, permitted possible-cause codes, read-only checks, and missing evidence. These briefs never claim an infrastructure root cause.

Incident responses include deterministic `evidence`, `rca`, and durable `rcaJob` fields. Report numeric summaries use medians across timestamp-less observations. Provider-generated RCA results use the strict `controlled-v1` code contract (`hypothesisCodes`, `diagnosticActionCodes`, `missingEvidenceCodes`, `evidenceBindings`, `priorityCode`); backend templates render all displayed text. The provider receives a serialized rule-specific policy containing only permitted codes and the packet's exact evidence-reference options. `validationOutcome=verified` means the policy contract passed, not that a causal root cause was proven. `analyzedEvidenceHash` identifies the packet used, and `evidenceStale=true` means replay evidence changed during inference and the result must not be treated as current. Rejected provider output is persisted as deterministic fallback with `validationReason`, `fallbackStatus=validation_rejected`, human-review metadata, and bounded `providerDiagnostics` (finish reason, content kind, tool-call count, token counts, parse stage/outcome, sanitized failure category and safe issue paths where available). `parseOutcome=accepted` means JSON parsing only; it is not schema or policy acceptance.

## Administrator endpoints (`ADMIN` only)

- `POST /api/incidents/:id/acknowledge` -> `{ ok, incident }`.
- `GET /api/replay/status` -> persisted session state, position, total, seed, ordering, and simulation marker.
- `POST /api/replay/evaluate` -> administrator-owned idempotent full evaluation. OWNER and ANALYST sessions cannot trigger a platform-wide evaluation.
- `POST /api/replay/config` body `{ mode: "full|curated", seed: 42, speed: 1|5|20, ordering: "sequential|seeded-interleaved" }`.
- `POST /api/replay/start`, `/api/replay/pause`, `/api/replay/resume`, `/api/replay/reset`, `/api/replay/step` -> authenticated control operations. Reset moves the cursor to zero but never deletes source rows or incidents.
- `POST /api/replay/restart` body `{ "start": true }` -> creates a fresh session using the same deterministic configuration, preserves the prior audit trail, and optionally starts it immediately.
- `POST /api/demo/prepare` (administrator) body `{ seed?: 42, speed?: 1|5|20 }` -> creates a fresh paused curated session and returns `{ session, cursor }`.
- Connect `GET /api/events?ticket=...&lastEventId=<cursor>&sessionId=<session.id>` before calling `POST /api/demo/start` (administrator) with `{ sessionId, cursor }`. The start operation validates the current session/cursor, emits `replay.started`, and begins background playback without blocking the request.
- `POST /api/demo/restart` (administrator) -> safely pauses an in-flight demo, creates a new curated session, and returns a new cursor; previous session history remains queryable.
- `POST /api/replay` -> backward-compatible curated configure-and-start shortcut.
- `GET /api/detection-events?sessionId=&limit=200` -> underlying rule violations, each linked to a source observation.
- `GET /api/incident-groups` -> grouped actionable incidents and occurrence/evidence counts. The dashboard queue uses the same grouped representation returned by `/api/incidents`.
- `GET /api/incident-stats` -> detection, group, and persistence counts.
- `POST /api/assignments` / `DELETE /api/assignments/:username/:reportId` -> create or remove a report assignment with provenance and audit metadata.

## Assignment-scoped replay (`OWNER` or `ANALYST`)

- `POST /api/replay/scoped/config` body `{ mode, seed, speed, ordering }` snapshots only the caller's assigned report IDs into a new session.
- `POST /api/replay/scoped/start`, `/pause`, `/resume`, `/step` body `{ sessionId }` operate only on a session owned by the caller. `GET /api/replay/scoped/status?sessionId=...` returns the persisted cursor and scope snapshot.
- Scoped sessions use the same deterministic detection, grouping, persistence and RCA pipeline as the full replay. The service permits multiple configured sessions, enforces `REPLAY_MAX_CONCURRENT` (default three), and rejects overlapping report scopes while running; source rows are never modified.

All read endpoints above require authentication. ADMIN sees all source-backed data. Explicit OWNER/ANALYST responses are filtered by assignment and accessible replay session before aggregation, pagination, counts, evidence serialization, cost summaries, RCA/tool traces, notifications or SSE delivery. Unknown or unassigned report detail uses a generic `404`; authenticated but disallowed mutations use `403`. Legacy `VIEWER` claims are normalized to OWNER scope and never regain platform-wide access.

## Server-sent events

First call `POST /api/events/ticket` with the bearer token, then connect to `GET /api/events?ticket=<ticket>&lastEventId=<cursor>&sessionId=<optional-session>`. A session filter only delivers events whose payload belongs to that replay session; the persisted global cursor still advances over other sessions, making reconnects gap-free. Events are:

- `demo.ready`: `{ sessionId, cursor, total, simulated, requiresSubscription }`
- `replay.started`: `{ sessionId, mode, position, total, speed }`
- `incident.detected`: `{ incident, evidence }`
- `incident.updated`: `{ incident, groupId, occurrenceCount, evidence }` for a new preserved detection added to an existing active group; dashboards should use the grouped incident rather than notify again as a new incident.
- `detection.triggered`: one display-safe event for each newly persisted rule violation; use `/api/detection-events` for the complete audit record.
- `observation.received`: `{ sessionId, observationId, reportId, simulationTimestamp }`
- `replay.configured`: `{ sessionId, mode, seed, speed, ordering, total }`
- `replay.progress`: `{ sessionId, position, total, observationId, reportId, detections, simulationTimestamp }`
- `replay.configured`, `replay.paused`, `replay.reset`, `replay.completed`: lifecycle payloads with `sessionId` and progress metadata.
- `incident.acknowledged`: `{ incidentId, by }`
- `rca.queued`: `{ jobId, groupId, sessionId, status, evidenceHash }`
- `rca.status` / `rca.running`: `{ groupId, sessionId, status }`
- `rca.fallback`: `{ jobId, groupId, sessionId, fallbackStatus, validationOutcome? }`
- `rca.completed`: `{ groupId, sessionId, status, result }`

`rca.queued` and `rca.running` are persisted notification lifecycle entries as well as SSE events. The UI must treat the returned job and the canonical `GET /api/incident-groups/:groupId` response as authoritative; a completed deterministic fallback is not an accepted NVIDIA result.

RCA `result` includes `provider`, `model`, `toolsUsed`, `toolTrace`, `analysisDurationMs`, `validationOutcome`, and `fallbackStatus`. The read-only tool schemas and access rules are documented in [ai-rca.md](ai-rca.md).

Each event has an integer SSE `id`. Reconnect with `Last-Event-ID`; the server replays persisted events after that ID and sends heartbeat comments every five seconds by default (`SSE_HEARTBEAT_MS` may raise this value). Established streams re-check the bearer session on heartbeat and close after expiry; logout closes them immediately. Clients should treat event IDs as idempotency keys.
