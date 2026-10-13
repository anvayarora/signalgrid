# Frontend integration contract

This contract is additive. It documents the backend fields that a future React integration can consume without changing the current UI in this pass.

## Authentication and roles

`GET /api/auth/me` returns the authenticated principal. The supported roles are `ADMIN`, `OWNER`, and `ANALYST`; a legacy `VIEWER` claim is normalized to the least-privileged OWNER scope. The backend, not React state, enforces every permission.

`GET /api/demo/readiness` includes:

```json
{
  "access": {
    "role": "ADMIN|OWNER|ANALYST",
    "assignedReports": ["RPT_200"],
    "canControlReplay": true,
    "canAcknowledge": true
  }
}
```

The UI may hide controls based on these values, but must still handle `401` and `403` responses.

## Ownership semantics

Report summaries keep the legacy `owner`, `ownerConflict`, and `orphanedObservations` fields. New `ownershipQuality` fields distinguish source observations from application responsibility:

- `sourceOwnerState`: `observed_candidate`, `missing_or_placeholder`, or `conflicting_observations`.
- `observedCandidates`, `validOwnerObservationCount`, `missingOrPlaceholderObservationCount`, `conflict`.
- `notVerifiedCurrentOwner`: always true for this timestamp-less case-study dataset.

`assignmentResponsibility` contains `{ username, role, provenance, assignedAt }` and must not be rendered as if it came from the CSV.

## Investigation briefs and RCA

`/api/reports/:reportId/investigation-brief` and `/api/incident-groups/:groupId/investigation-brief` provide deterministic backend facts, measurements, threshold comparisons, approved possible-cause codes, read-only diagnostic codes, missing evidence and source references. Possible causes are hypotheses, never confirmed root causes.

Persisted RCA results expose `provider`, `model`, `toolsUsed`, `toolTrace`, `providerRequestCount`, `analysisDurationMs`, `validationOutcome`, `fallbackStatus`, `validationReason`, and `humanReviewRequired`. Render `generatedBy=ai` only when `validationOutcome=verified`; render `deterministic` or `rejected_fallback` distinctly. Never display unrestricted provider text as a confirmed finding.

## Scoped replay

OWNER/ANALYST users use `/api/replay/scoped/*`. The response includes a session `scopeReportIds` snapshot, so progress is stable if assignments change later. The same observation/detection/incident/RCA event schemas are used as the administrator replay.

## Costs and data quality

`/api/costs` labels Snowflake values as credits and AWS values as USD. Negative Snowflake credits are excluded only from Snowflake allocation; finite AWS hosting cost is evaluated independently. Zero-view ratios are `null`. `costUsageQuality` is a reproducible Q3 + 1.5×IQR review flag and is not an accounting-error verdict.

## SSE

Obtain a short-lived ticket from `POST /api/events/ticket`. Use `Last-Event-ID` for recovery. Explicit OWNER/ANALYST streams receive only events for assigned reports; sessions tied to another principal are rejected. The initial `incident.detected` event is persisted and emitted before asynchronous RCA begins.
