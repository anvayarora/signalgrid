# Demonstration guide

1. Install dependencies with `npm install` and start the API and UI with `npm run dev`.
2. Open `http://localhost:5173`. With `SIGNALGRID_DEMO_AUTH=true`, sign in as `admin` / `admin123`, `user` / `user123`, or `analyst` / `analyst123`. These credentials are for local demonstration only; private deployments must use their own environment credentials.
3. Administrator entry: choose **Replay** to configure and start the full 2,000-row sequential replay, or choose **Admin View** to open the latest completed full evaluation. Replay returns to the same Overview dashboard and reports its actual processed position through SSE. Owner and Analyst sign-ins are assignment-scoped and never trigger the platform-wide evaluation.
4. Review Overview. The KPIs are loaded from the validated CSV, not hardcoded frontend fixtures. During an active replay they are scoped to the rows processed so far; after completion they converge to all 2,000 observations.
5. Open Reports and search for an `RPT_` ID. The owner, refresh distribution, latency, and credit values are observation-level summaries.
6. Open Incidents and select a latency, refresh, orphan-owner, or negative-credit incident. Evidence is shown before the RCA result.
7. Use the **Telemetry Replay** panel when in Administrator mode. Curated mode remains available for the compact incident demonstration: it uses eight real rows at a default 1.5-second cadence and exercises latency, failed refresh, timed-out refresh, missing owner, negative credits, zero views, grouping, and a normal control row. Full Dataset mode processes all 2,000 rows through the same rules, persistence, grouping, alerts, and RCA queue. Pause/resume/reset/step and **Restart** preserve source data and prior audit history; all playback timestamps are simulation timestamps.
8. Inspect a grouped incident. Occurrence counts and evidence links remain visible while one RCA job is reused for materially unchanged evidence. With `RCA_PROVIDER=nvidia` or `ollama`, the optional provider is attempted asynchronously; NVIDIA uses the read-only tool registry and falls back safely on missing keys, retired models, timeouts, budget limits, or validation failure. See [ai-rca.md](ai-rca.md) and [FINAL_VERIFICATION.md](FINAL_VERIFICATION.md) for the live-provider verification result.
9. Open Cloud Costs to review credits per active view, invalid-record exclusions, and zero-view handling.
10. Review `scripts/snowflake/` for the schema, staging, attribution, and validation SQL.

Owner and Analyst sessions are assignment-scoped. They can replay only their assigned reports; administrator-only full replay controls and platform-wide evaluation remain unavailable.
