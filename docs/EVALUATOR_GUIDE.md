# SignalGrid evaluator guide

SignalGrid is a local-first monitoring demonstration built around the supplied 2,000-row CSV. The backend preserves every source row, validates observations with deterministic rules, emits live SSE events, groups related detections into incidents, and queues evidence-first RCA asynchronously.

## Two-minute walkthrough

1. Install Node.js 22+ dependencies: `npm install`.
2. For a fresh local checkout, the API automatically falls back to the sanitized `.env.public.example` template when no private `.env` is present. Alternatively, copy `.env.public.example` to a private environment file or set `SIGNALGRID_ENV_FILE` explicitly. The public template enables isolated demo authentication and deterministic RCA.
3. Build and start the production-like server:

   ```bash
   npm run build
   SIGNALGRID_ENV_FILE=/path/to/private.env npm start
   ```

   Open `http://localhost:4000` (or run the Vite UI with `npm run dev` and open `http://localhost:5173`).
4. On the public hero, choose **Sign In**. Use `admin` / `admin123` for **Administrator**, `user` / `user123` for **Owner**, or `analyst` / `analyst123` for **Analyst**. All enter the same Overview dashboard; the role badge, assignment scope, navigation and backend permissions differ.
5. As Administrator, confirm **DEMO READY**, 100 reports, and 2,000 observations on Overview.
6. As Administrator, in **Telemetry Replay**, leave **Curated demo** selected and press **Start Demo**. The backend prepares a fresh paused session, subscribes the event stream using the returned cursor, and starts the background loop.
7. Watch the event bus and incident queue. The eight real source rows cover latency, failed refresh, timed-out refresh, missing owner, negative credits, zero views, a second latency occurrence for grouping, and a normal control row. The queue shows `incident.updated`, preserved occurrence counts, source-row IDs, and completed deterministic RCA.
8. Open **Cloud Costs** to verify 1,976 valid credit rows, 24 invalid-credit rows, four zero-view rows, and null-safe cost-per-view handling.
9. Sign out and sign in as Owner (`user` / `user123`) or Analyst (`analyst` / `analyst123`). Each restricted role sees only its assigned reports and may use its own assignment-scoped replay; administrator-only replay endpoints remain `403 Forbidden` without changing database state. Analysts do not receive a global Costs navigation item, while report-level cost evidence remains available through authorized report details.

Choose **Full dataset** when comprehensive replay is required. It processes all 2,000 observations through the same validation, detection, grouping, alerting, persistence, and RCA code. Playback timestamps are simulation metadata; the CSV contains no reliable observation chronology.

## Optional NVIDIA verification

The application does not require an inference provider for detection or alert delivery. With a private environment containing `NVIDIA_KEY`, run:

```bash
npm run nvidia:smoke
```

This performs a real two-request structured tool-call cycle and prints metadata only. The controlled end-to-end hosted RCA harness is `RUN_LIVE_NVIDIA=1 npm run nvidia:integration`; its acceptance status is recorded in `docs/FINAL_VERIFICATION.md`. Never commit or print a key.

## Verification and SQL

Run `npm test` for the API/replay/RCA/RBAC suite and `npm run build` for both TypeScript applications. The Snowflake-compatible scripts are in `scripts/snowflake/`; execute them in order in a Snowflake worksheet. `scripts/snowflake/05_account_usage_reference.sql` is an optional reference path and requires an actual Snowflake `ACCOUNT_USAGE` environment; local tests do not claim cloud execution.

See [FINAL_VERIFICATION.md](FINAL_VERIFICATION.md) for exact observed results and [INTERVIEW_TECHNICAL_NOTES.md](INTERVIEW_TECHNICAL_NOTES.md) for design rationale and limitations.
