# SignalGrid architecture

SignalGrid is a local-first operational intelligence application. The mandatory path is deterministic and remains functional with AI disabled.

```text
CSV -> immutable observations + quality findings
  -> replay session -> deterministic rules -> detection events
  -> session/report/rule incident group -> persisted SSE event log
  -> asynchronous group RCA -> allowlisted evidence packet -> validated explanation
React UI <- REST API + SSE ticket <- Express/SQLite
```

## Data integrity

The importer preserves the raw row JSON, source row number, and file SHA-256. Placeholder owners (`nan`, `ORPHANED_REPORT`, and equivalent empty values) are normalized to `NULL`, while the original value remains in `owner_email`. Negative credits are preserved and flagged; they are excluded from cost attribution rather than corrected. The absence of a timestamp is explicit: repeated rows are observations, not chronology.

## Detection, grouping, and diagnosis

Rules run only when a replay session emits an observation; the historical import is never treated as live telemetry. Every qualifying rule violation is preserved as a detection event keyed by replay session, source observation, rule code, and rule version. Actionable incident groups use report ID, rule category, and replay session, so the queue is not flooded by 1,490 slow observations while the audit trail remains complete. Detection persists before publishing an SSE event: the first group occurrence emits `incident.detected`, while later evidence emits `incident.updated` and increments the group without discarding the row-level record. RCA is queued once per group after persistence, survives restarts, and can be re-run only when the evidence hash changes. Providers receive a compact allowlisted packet only; the NVIDIA path can call five strict read-only backend tools within bounded rounds and executions, and schema, evidence-reference, and numeric-fact validation protects the deterministic fallback. NVIDIA Build (OpenAI-compatible chat completions) and Ollama are optional providers. Model failures leave the original incident intact.

## Replay and event delivery

`POST /api/replay/config` creates a persisted full or curated session with a stable seeded order. The evaluator path uses `POST /api/demo/prepare`, subscribes with its returned event cursor, and then calls `POST /api/demo/start`; no replay auto-starts at process boot. Start/pause/resume/reset/step operate in a background loop; curated playback defaults to a realistic 1.5-second cadence (`REPLAY_CURATED_CADENCE_MS`) while full replay uses the selected 1×/5×/20× speed. A restart safely pauses an in-flight demo, creates a new session, and preserves the prior audit trail. Reset never deletes source rows, detection events, or incidents. The event log is persisted with monotonically increasing IDs. SSE clients receive paged, optionally session-filtered catch-up after `Last-Event-ID` and periodic heartbeats.

## Security boundary

Authentication issues random in-memory bearer tokens and short-lived SSE tickets linked to the parent session. Every API handler is protected by server-side role checks; expired or logged-out sessions are rejected, and sign-in attempts are rate-limited. Administrators can acknowledge incidents and replay the full dataset; OWNER and ANALYST principals can replay only their explicit report assignments and may acknowledge only assigned incidents where permitted. The isolated evaluator accounts (`admin` / `admin123`, `user` / `user123`, `analyst` / `analyst123`) exist only when `SIGNALGRID_DEMO_AUTH=true`; private deployments use local environment credentials and never expose them to the frontend.
