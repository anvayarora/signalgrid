# SignalGrid Submission Checklist

This checklist tracks repository readiness for the Everpure case study. The final single-PDF submission package is intentionally deferred in the current engineering pass, as requested.

## Repository readiness

- [x] React/Vite frontend and Express/TypeScript backend remain in the existing repository.
- [x] Three-role backend RBAC: ADMIN, OWNER and ANALYST.
- [x] Assignment-scoped reports, incidents, evidence, costs, notifications and SSE.
- [x] Deterministic 2,000-row CSV replay with persisted sessions and scoped replay.
- [x] Pause, resume, reset, single-step and active restart behavior.
- [x] Immediate persisted incident detection before asynchronous RCA.
- [x] Controlled RCA contract, five read-only tools and deterministic fallback.
- [x] Independent Snowflake/AWS validity rules and independently ranked cost collections.
- [x] REST and SSE contracts documented in `docs/API.md` and `docs/FRONTEND_INTEGRATION_CONTRACT.md`.
- [x] Dataset counts and limitations documented in `docs/data-quality.md`.
- [x] Automated regression suite passes and production build passes.

## Required verification evidence

- [x] `npm test` — 28/28 passing in the latest run.
- [x] `npm run build` — API TypeScript build and Vite production build pass.
- [x] Hosted NVIDIA behavior is reported honestly; structured tool-call smoke coverage and deterministic fallback are retained.
- [ ] One accepted hosted NVIDIA investigation — only mark complete after a real provider result passes the controlled contract.
- [ ] Live Snowflake execution — intentionally not required and remains unverified.
- [ ] Public repository URL — excluded from this task; do not invent one.

## Deferred submission artifact

The eventual PDF must be created at `submission/SignalGrid_Everpure_Case_Study.pdf` with editable source at `submission/SignalGrid_Everpure_Case_Study.md`, remain below 1 MB, contain searchable text, and exclude credentials, private paths, SQLite databases and generated build output. It must not claim GitHub publication or live Snowflake execution before those activities are actually verified.
