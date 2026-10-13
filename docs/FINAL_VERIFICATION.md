# Final verification record

This record describes the current SignalGrid repository and the checks that are safe to reproduce from a clean checkout. It does not claim a live Snowflake account or a public deployment.

## Automated checks

| Check | Result | Notes |
| --- | --- | --- |
| `npm ci` | Passed | Dependencies install from the lockfile on Node.js 22+. |
| `npm test` | Passed 34/34 | Covers three-role authentication, assignment scoping, replay lifecycle, SSE recovery, strict RCA validation/tool protocol, fallback behavior, cost parity, and authorization boundaries. |
| `npm run build` | Passed | API TypeScript compilation and Vite production build complete. |
| Source dataset integrity | Passed | 2,000 rows, 100 reports, 20 observations per report, 245 placeholder owners, 24 negative-credit rows, 1,490 latency observations above 15 seconds, and four zero-view rows. SHA-256: `bee8b5a451167aab11add9c6c2fc959f37d0c93b6ebc2560a93254849c8f4d50`. |
| Production-style startup | Passed | Built server initializes SQLite, imports the preserved CSV, serves `/health`, and exposes the built frontend on port 4000 with deterministic RCA. |
| Role smoke test | Passed | Administrator sees the full source population; Owner and Analyst remain assignment-scoped; restricted full-evaluation and mutation requests return `403`. |
| Deterministic replay/RCA | Passed | Curated and full replay preserve source observation IDs, emit SSE events, group incidents, and persist deterministic findings without a provider key. |
| Real NVIDIA structured smoke | Passed | A private-key run completed a genuine two-request Nemotron tool-call cycle with matching tool-call IDs. No key is stored in this repository. |
| Real hosted NVIDIA investigation | Passed | One explicit `RPT_200` latency investigation completed with persisted `provider=nvidia`, a read-only evidence-tool trace, controlled-schema validation, and `validationOutcome=verified`. Replay emitted the alert before RCA was requested. |
| Snowflake execution | **Not verified** | SQL was statically reviewed and source calculations were reconciled locally. No Snowflake account or `ACCOUNT_USAGE` query was available. |

## RCA safety boundary

The backend remains authoritative for measured values, thresholds, source references, incident identity, severity, and cost calculations. A provider may select only approved hypothesis, diagnostic-action, missing-evidence, evidence-binding, and priority codes. Unsupported causal claims, destructive recommendations, unknown evidence references, cross-incident bindings, prompt injection in source metadata, and malformed output are rejected. Rejected or unavailable provider results are persisted as clearly labelled deterministic fallback and never presented as verified AI findings.

Hosted RCA is explicit-only: configuring NVIDIA does not make replay enqueue paid work. A replay creates the detection and alert first; an authenticated user must request an investigation. Pending hosted work is not resumed automatically after a restart.

## Cost and Snowflake verification

The API and SQL use independent validity rules. Negative Snowflake credits are retained as quality defects and excluded from credit ratios only. Finite AWS hosting amounts remain independently usable. Zero active views produce `NULL` per-view ratios. Report-level values are medians of eligible observation-row ratios because the repeated source rows have no reliable timestamps.

The Snowflake suite now includes `03_simulated_query_fixture.sql`, a six-row synthetic query-history demonstration with fixed fixture timestamps, valid report labels, explicit `SIMULATED_QUERY_FIXTURE` provenance, and reproducible non-empty attribution. It is illustrative, not recovered production history. `05_account_usage_reference.sql` keeps query-attributed warehouse compute separate from Query Acceleration, cloud services, and idle/unattributed warehouse compute.

## Browser and product evidence

The current light public journey is represented by:

- `docs/screenshots/landing-light-final.png` — public landing page.
- `docs/screenshots/signin-light-final.png` — real sign-in form with demo accounts shown only when enabled.
- `docs/screenshots/dashboard-light-overview.png` — authenticated overview.
- `docs/screenshots/dashboard-light-alerts.png` — alerts and investigation workspace.
- `docs/screenshots/dashboard-light-costs.png` — cloud-cost review.
- `docs/screenshots/dashboard-light-standard-user-final.png` — assignment-scoped restricted role.
- `docs/screenshots/report-detail-modal.png` — report evidence modal.
- `docs/screenshots/overview-analysis-modal-final.png` — analysis modal.

The browser walkthrough verified landing → sign-in → authenticated Overview, logout, role badges, assignment scoping, replay controls, modal detail views, SSE connection state, and no horizontal overflow at the captured viewport. The frontend remains the existing light operational workspace; this maintenance pass does not redesign it.

## Security and publication

The public repository contains no credential-bearing environment file, private runtime environment, SQLite database, WAL file, `node_modules`, build output, generated archive, or API key. The checked-in `.env.example` is sanitized; the pre-existing local credential-bearing `.env.example` was preserved byte-for-byte and never staged. The included CSV is unchanged.

The original assessment PDF and obsolete planning/checklist material are intentionally absent from the current repository tree. Prior Git history was not rewritten; any historical exposure would require a separate, explicit history-cleanup decision.

## Known limitations

- The CSV contains repeated observations without authoritative event timestamps.
- The dataset is not a genuine Snowflake `ACCOUNT_USAGE` extract.
- The ACCOUNT_USAGE reference requires a real account, usage-view privileges, query-tag adoption, and allowance for metadata latency.
- NVIDIA remains optional. Deterministic fallback is the supported no-key path.
- No Vercel deployment or final PDF submission artifact is part of this repository pass.
