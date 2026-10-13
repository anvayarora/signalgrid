# SignalGrid RBAC and Session Authorization

SignalGrid uses one backend-enforced permission model. React visibility is only a usability aid; every read, mutation, evidence lookup, replay action, export and SSE stream is authorized by Express before aggregation or serialization.

## Roles

| Capability | ADMIN | OWNER | ANALYST |
| --- | --- | --- | --- |
| View all reports, incidents and costs | Yes | Assigned reports only | Assigned reports only |
| Full 2,000-row replay/evaluation | Yes | No | No |
| Assignment-scoped replay | Yes | Yes, own session | Yes, own session |
| Pause/resume/step/reset/restart another principal's session | Yes, within policy | No | No |
| Acknowledge incidents | Yes | Assigned reports only | No |
| Manage report assignments | Yes | No | No |
| Global Costs navigation | Yes | Yes, scoped | No; report-level cost evidence remains available |

The isolated local demo accounts are enabled only with `SIGNALGRID_DEMO_AUTH=true`:

- `admin` / `admin123` → `ADMIN`
- `user` / `user123` → `OWNER`
- `analyst` / `analyst123` → `ANALYST`

Legacy `VIEWER` claims are normalized to least-privilege `OWNER` scope. They never regain platform-wide access.

## Assignment and source ownership

`report_assignments` represents application responsibility and is separate from the CSV's observed owner field. A report may have missing or conflicting recorded owner values while still being assigned to an investigator. Assignment changes are administrator-only and audited.

An empty assignment set is an explicit zero-report scope. It is never interpreted as unrestricted access, and scoped replay configuration fails without creating a session.

## Replay session policy

Replay sessions persist their principal, role, report-scope snapshot, deterministic order and progress. Restricted users may access their own sessions and authorized projections of the completed shared evaluation. A private administrator session is not discoverable through guessed identifiers, and its processing order is never exposed to restricted clients. Session filters are applied before incident grouping, counts, costs, notifications, evidence and SSE serialization.

## SSE policy

Clients obtain a short-lived ticket from `POST /api/events/ticket`, then connect to `GET /api/events`. The server validates the bearer session, ticket, requested session and report scope on initial connection and on every replay/detection/incident event. `Last-Event-ID` recovery is page-aware and cannot be used to cross a private session boundary.

## Verification

The API regression suite covers legacy role normalization, user/analyst assignment filtering, zero-assignment replay denial, private-session isolation, restricted status projections, unauthorized mutations and session-filtered recovery. See `tests/api.test.ts`, `docs/API.md` and `docs/FINAL_VERIFICATION.md`.
