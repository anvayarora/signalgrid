# SignalGrid dashboard refinement

The authenticated dashboard was refined into a light operational workspace while preserving the approved dark landing page, sign-in experience, Express RBAC, replay service, SSE transport, incident grouping, and RCA lifecycle.

## Component inventory

- DashboardShell — retractable sidebar, role badge, stream status, search affordance, and the existing Overview / Reports / Alerts / Costs information architecture.
- Overview — four source-backed metric cards, replay controls, health map, attention queue, review list, live activity, and refresh-health chart.
- HealthMap — React Flow map/list toggle. Category nodes are generated from the report summaries returned by the backend; expanding a category shows real report identities and opens the shared report inspector.
- ReportInspector — shared drawer used from the Overview map and Reports table. It retrieves the report-level endpoint before showing observation evidence.
- InvestigationDrawer — shared Alerts drawer that separates measured facts, possible explanations, read-only diagnostic actions, RCA status, and provider metadata. Rejected provider output is never rendered as confirmed text.
- Costs — Recharts views for report-level AWS cost-per-active-view and latency context, plus the deterministic Q3 + 1.5×IQR review list.
- ReplayControls — administrator full-dataset controls and assignment-scoped OWNER/ANALYST controls. The control calls the existing replay APIs rather than inventing client-side telemetry.

## Visual primitives

The surface uses local, React 18-compatible primitives inspired by the supplied references: frosted panels, a segmented map/list control, compact filter toolbar, drawers, status chips, live activity timeline, and restrained responsive motion. The current Arc source package targets React 19, so the implementation intentionally does not introduce an incompatible runtime dependency.

The dashboard uses the existing Onest font, a pale teal canvas, semantic teal/orange/red/violet accents, and no hero background image. The public landing and sign-in styles remain separately scoped.

## Data and endpoint contract

The frontend calls:

- /api/overview for persisted summary counts and provenance.
- /api/analytics for deterministic chart aggregates and persisted replay activity.
- /api/reports and /api/reports/:reportId for report health and evidence.
- /api/incidents and /api/incident-groups/:groupId for grouped alerts and investigation detail.
- /api/costs for independent Snowflake/AWS validity, null-safe ratios, and quality flags.
- /api/replay/* and /api/demo/* for authenticated replay controls.
- /api/events/ticket followed by SSE /api/events for live observation, alert, replay, and RCA events.

No chart or metric is generated from placeholder frontend data. Replayed telemetry is labelled simulated, while source observations preserve their original row identifiers and provenance.
