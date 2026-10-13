# Final verification record

Verification was run from the repository root on 2026-10-14.

## Automated checks

| Check | Result | Notes |
|---|---|---|
| `npm test` | Passed 34/34 | Includes strict RCA schema/policy diagnostics, tool-free JSON-mode finalization, accepted-vs-fallback persistence, explicit-only hosted RCA replay gating, replay lookahead protection, shared-evaluation selection, incident-group session authorization, prior replay/RCA/cost regressions, and three-role assignment scoping. |
| `npm run build` | Passed | API TypeScript and Vite production build completed, including bundled Onest font assets. |
| Dataset integrity | Passed | 2,000 rows; 100 reports; 20 observations per report; 245 orphan/placeholder owners; 24 negative-credit rows; 1,490 latency rows over 15 seconds; four zero-view rows. SHA-256: `bee8b5a451167aab11add9c6c2fc959f37d0c93b6ebc2560a93254849c8f4d50`. |
| Cost parity and quality review | Passed | API and tool attribution match direct source-row calculations; Snowflake-credit validity is independent from AWS validity; zero-view ratios are null-safe; Q3 + 1.5×IQR review flags are deterministic and non-destructive. |
| Production startup smoke | Passed | Built server started with `.env.public.example`; health/readiness returned ready with 2,000 observations and deterministic provider mode. |
| Production API role smoke | Passed | On an isolated built-server port, ADMIN listed 100 reports, OWNER listed 60 assigned reports, ANALYST listed 60 assigned reports, and OWNER/ANALYST full-evaluation attempts returned HTTP 403. No bearer token was written to the repository or verification artifacts. |
| Browser walkthrough | Passed | Public one-section landing page, premium `/signin` form with clearly labelled demo accounts, Administrator workspace choice, live full replay with progress and pause, completed Admin View at 2,000/2,000, Owner/Analyst assignment-scoped entry, connected stream status, live event bus, grouped incidents, logout, role badges, password visibility, and no-horizontal-overflow checks were verified through the UI. Stabilized screenshots are in `docs/screenshots/`. |
| Deterministic end-to-end RCA harness | Passed | `scripts/nvidia-real-integration.mjs` verified alert-before-RCA, persisted job/result, replay/SSE lifecycle, evidence linkage, and validator output. |
| NVIDIA structured-tool smoke | Passed | `SIGNALGRID_ENV_FILE=.env.example npm run nvidia:smoke` completed against `nvidia/nemotron-3.5-lightning-30b-a3b` without exposing the key. |
| Hosted NVIDIA full RCA | Passed | `RUN_LIVE_NVIDIA=1 SIGNALGRID_ENV_FILE=.env.example RCA_PROVIDER=nvidia npm run nvidia:integration` completed one persisted `RPT_200` latency investigation with the alert first, replay paused before explicit RCA, two provider requests, one read-only tool call, verified controlled output, current evidence bindings, SSE lifecycle, and authorized API retrieval. |
| Snowflake execution | **Not verified** | SQL was statically reviewed and local numerical reconciliation passed. No Snowflake account or `ACCOUNT_USAGE` execution was available, so cloud query results are not claimed. |

## Acceptance interpretation

The backend lifecycle is verified locally as:

```text
observation.received -> detection.triggered -> incident.detected/updated
  -> immediate SSE alert -> rca.queued -> rca.running
  -> validated persisted result -> rca.completed
```

Every detection stores a stable source observation ID and remains queryable even when its incident is grouped. Replayed rows are never presented as a verified chronology. A latency breach is described as a validation finding or supported hypothesis, not as proof of a Snowflake infrastructure failure.

The hosted-provider safety boundary is also verified: a replay configured for NVIDIA creates the incident and alert without creating an RCA job; a subsequent explicit RCA request creates the job and falls back safely when credentials are unavailable.

## Remaining limitations

- The supplied CSV has no reliable observation timestamps.
- The dataset is not a genuine Snowflake `ACCOUNT_USAGE` extract; the fifth SQL file is a clearly labelled reference path.
- The hosted NVIDIA path is verified for one real latency incident. Hosted results still remain subject to the normal evidence freshness and human-review rules if the underlying replay prefix changes during a later investigation.
- Explicit OWNER/ANALYST report assignments are persisted independently of the observed CSV owner field. The `user` demo is OWNER-scoped, the `analyst` demo is ANALYST-scoped, and any legacy `VIEWER` claim is normalized to OWNER scope rather than receiving broad access.
- No public deployment or final PDF artifact was created.

## Review archive

`SignalGrid-review-sanitized.zip` is generated at the repository root after verification. It includes source, tests, documentation, SQL, the supplied non-secret CSV, and `.env.public.example`. It excludes `.env.example`, private environment files, `node_modules`, build output, SQLite databases, the assessment PDF, macOS metadata, and the archive itself.

## Light dashboard refinement pass

The authenticated dashboard now uses the approved light operational direction without changing the public dark landing/sign-in composition or backend contracts. It includes a retractable sidebar, source-backed metric cards, a React Flow Report Health Map with map/list drill-down, shared report and incident inspectors, Recharts cost/latency views, live SSE activity, and role-aware replay controls. The new /api/analytics endpoint exposes only deterministic aggregates derived from the preserved observation set.

Browser verification covered the 1,280 × 720 in-app viewport without horizontal overflow: Reports / Alerts / Costs navigation loaded real API data for authorized roles, the Administrator workspace choice opened both live full replay and completed evaluation, the live run advanced to a visible processed subset before pause, the completed view showed 2,000/2,000 source observations, Owner and Analyst entry remained assignment-scoped, and logout returned to the public landing route. Screenshots from this refinement are docs/screenshots/dashboard-light-overview.png, dashboard-light-alerts.png, dashboard-light-costs.png, and dashboard-light-standard-user.png. Responsive CSS breakpoints remain included for narrower viewports.

The external light-dashboard references informed spacing and interaction patterns only; the SignalGrid source-backed data model, RBAC, replay, SSE, RCA, and Snowflake scope remain authoritative.

## Backend RBAC and ownership pass

The backend-only follow-up added persistent `report_assignments` with provenance and audit records, deterministic demo scopes (60 reports for `user`, 60 for `analyst`, with a 20-report overlap), explicit ownership-quality fields, and scoped investigation briefs. Explicit OWNER/ANALYST sessions are filtered before aggregation, pagination, evidence, costs, notifications and SSE. Replay sessions now persist principal/scope snapshots, pause all orphaned timers after process restart, allow bounded non-overlapping concurrency, reject overlapping report scopes while running, and reject zero-assignment scopes without creating sessions.

The production-style localhost check passed after migrating an existing SQLite file that contained the invalid legacy assignment foreign key. The final local state is a completed 2,000/2,000 full evaluation and the API remains available at `http://localhost:4000`; the web dev server is available at `http://localhost:5173` and the current LAN address is `http://10.29.2.251:5173`.

The final integration pass adds two explicit authorization safeguards. A completed shared evaluation is now persisted with `shared_evaluation=1` and must be a completed, position-at-total 2,000-row full session with no principal or scope; private Admin, Owner and Analyst full sessions are never selected for shared visibility. Incident acknowledgment now applies both report and replay-session authorization to numeric incident IDs and incident-group IDs. The regression suite covers both boundaries.

## Visual evidence

The browser walkthrough captured the implemented public and authenticated surfaces in `docs/screenshots/`:

- `landing-stabilized.png` — public premium landing page using the supplied horizon and network artwork, with the requested slight lift and negative-X tilt.
- `signin-stabilized.png` — working demo-enabled sign-in page with the clearly labelled administrator and standard-user accounts.
- `administrator-dashboard-stabilized.png` — authenticated Administrator Overview with connected stream and replay controls.
- `standard-user-dashboard-stabilized.png` — authenticated restricted-role Overview with assignment-scoped data and replay controls visible only where permitted.
- `admin-completed-local.png` — current localhost Administrator Overview after the completed 2,000-row evaluation.

The stabilized screenshots were captured from the local browser viewport (1,280 × 720 CSS pixels); the layout includes responsive breakpoints for the requested desktop, tablet, and mobile ranges. The supplied visual reference remains the composition source of truth; the implementation uses its constituent assets as separate responsive elements rather than flattening the page into a screenshot.

## Approved light public experience pass

The public experience was refined to the approved light reference: a near-white single-hero landing page with the exact “Every Report. Every Risk. In View.” mission, a restrained animated SVG signal timeline, an orange Sign In pill and a reusable inline document-chart logo. `/signin` now uses the same mission and signal timeline in a genuine two-column light-glass layout while retaining real Express authentication and the clearly labelled demo accounts. The new logo is also used in the authenticated sidebar and loading state, with an SVG favicon at `apps/web/public/assets/signalgrid-logo.svg`.

Browser verification confirmed the landing route, sign-in navigation, invalid-login feedback, Administrator login, restricted-role assignment scope, logout, no console errors and no horizontal overflow at 1,280 × 720. Evidence is in `docs/screenshots/landing-light-final.png`, `signin-light-final.png`, `dashboard-light-brand-final.png`, and `dashboard-light-standard-user-final.png`. Responsive CSS covers the requested tablet/mobile stacking behavior; the browser harness used for this pass exposes a fixed 1,280 × 720 viewport.
