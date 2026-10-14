# SignalGrid

<p align="center">
  <img src="apps/web/public/assets/signalgrid-logo.svg" alt="SignalGrid" width="100" />
</p>

<p align="center">
  <strong>Every report. Every risk. In view.</strong><br />
  A calm, source-backed workspace for report health, alerts, investigations, and cloud cost visibility.
</p>

<p align="center">
  <a href="#run-locally">Run locally</a> ·
  <a href="#demo-access">Demo access</a> ·
  <a href="#what-you-can-explore">Explore SignalGrid</a>
</p>

<p align="center">
  <img src="docs/screenshots/landing-light-final.png" alt="SignalGrid landing page" width="92%" />
</p>

## A focused operational view

SignalGrid turns a preserved monitoring dataset into a practical, explorable workspace. It keeps the important things close together: the report that needs attention, the observation that triggered it, the incident evidence behind it, and the financial context around it.

The experience is designed to be useful at a glance and trustworthy under inspection:

- a bright, restrained landing and sign-in experience;
- live replay with deterministic threshold and data-quality findings;
- role-aware workspaces for administrators, owners, and analysts;
- paginated reports and alerts with search and filters;
- evidence-first incident investigations with optional AI analysis;
- explainable Snowflake-credit and AWS-cost views;
- resilient sessions, SSE notifications, and a safe deterministic fallback.

<p align="center">
  <img src="docs/screenshots/overview-premium-final1.png" alt="SignalGrid overview" width="49%" />
  <img src="docs/screenshots/reports1.png" alt="SignalGrid reports workspace" width="49%" />
</p>

## Run locally

Requirements: Node.js 22 or newer.

Environment setup is required before starting the application. The checked-in `.env.example` is a sanitized template; copy it to a private `.env` for every local or evaluator checkout, and never commit that private file:

```bash
git clone https://github.com/anvayarora/signalgrid.git
cd signalgrid
npm ci
cp .env.example .env
npm run dev
```

Keep `SIGNALGRID_DEMO_AUTH=true` in `.env` for the local demonstration accounts below. For any shared, hosted, or assessment environment, set `SIGNALGRID_DEMO_AUTH=false` and replace the administrator, owner, and analyst password placeholders with strong private values. If the environment file lives outside the repository, set `SIGNALGRID_ENV_FILE` to its path before starting the API. The application will not require an NVIDIA key or a Snowflake account for the standard deterministic experience.

Open **http://localhost:5173** on the same computer or device. To view it from another device on the same network, start the frontend bound to your local interface and open the displayed network URL:

```bash
npm run dev -w apps/web -- --host 0.0.0.0
```

The API runs on port `4000` and the Vite frontend on port `5173`. If those ports are busy, update `PORT` in your private `.env` and the proxy target in `apps/web/vite.config.ts` together.

For a production-style local run:

```bash
npm run build
npm start
```

The server serves the built frontend and API together at **http://localhost:4000**.

## Demo access

Demo authentication is enabled by the sanitized local template for local use only. A bare local checkout also enables these accounts when no private password variables are configured, so `npm run dev` remains recoverable even before creating `.env`; copying and configuring `.env` is still the required setup for a repeatable run:

| Account | Username | Password | Workspace |
| --- | --- | --- | --- |
| Administrator | `admin` | `admin123` | Full monitoring and replay controls |
| Owner | `user` | `user123` | Assigned reports, alerts, investigations, and costs |
| Analyst | `analyst` | `analyst123` | Assigned monitoring and report-level financial evidence |

The credentials are intentionally local-demo credentials. Use a private environment file with strong passwords for any shared or hosted environment. Never publish private environment files or API keys.

For a private deployment, set `SIGNALGRID_DEMO_AUTH=false` and provide the private administrator, owner, and analyst passwords explicitly.

## What you can explore

### Overview

See the current report population, threshold breaches, refresh health, ownership quality, prioritized reports, recent alerts, and cost-quality signals in one quiet command centre.

### Reports and alerts

Search and filter the preserved records, move through compact pages, and open a single modal to inspect the exact source observations, ownership quality, thresholds, incident history, and cost-per-view context.

### Investigations

Open an alert from the notification bell or from its table row. The investigation keeps measured facts separate from policy-approved hypotheses, safe diagnostic checks, missing evidence, provider status, and fallback state. Optional NVIDIA analysis stays behind the authenticated API and never exposes a private key in the browser.

### Optional AI-driven RCA

Deterministic, evidence-backed RCA works without an external provider. If you want the optional AI-driven analysis, create an API key in [NVIDIA Build](https://build.nvidia.com/), add it as `NVIDIA_KEY` in a private environment file, and select a Nemotron model such as `nvidia/nemotron-3.5-lightning-30b-a3b` with `NVIDIA_MODEL`. Keep the key out of Git and run an investigation explicitly from an authenticated incident; replay never calls NVIDIA automatically.

### Replay

Administrators can choose a curated demonstration or a complete 2,000-row replay. Owners and analysts receive isolated replay sessions derived from their actual assignments. Progress, detections, incident grouping, and notifications are persisted and scoped to the current session.

### Costs

Review valid and excluded rows, zero-view handling, Snowflake credits per view, AWS dollars per view, and the evidence behind each quality flag. Snowflake credits remain credits; AWS values remain USD.

<p align="center">
  <img src="docs/screenshots/signin-light-final.png" alt="SignalGrid sign-in" width="49%" />
  <img src="docs/screenshots/costs1.png" alt="SignalGrid costs workspace" width="49%" />
</p>

## Source and project map

```text
apps/api/                 Server-side application code
apps/web/                 Browser application and visual system
data/raw/monitoring.csv   Preserved 2,000-row source dataset
scripts/snowflake/        Schema, quality, attribution, validation, and reference SQL
docs/                     Product, usage, data-quality, and verification notes
```

## Verification

```bash
npm test
npm run build
npm start
```

The current regression suite covers authentication, three-role and session scoping, replay lifecycle, SSE recovery, deterministic detection, report ownership, cost aggregation, RCA tool-call ordering, strict controlled output validation, fallback behavior, and replay/incident authorization boundaries. A clean checkout requires no NVIDIA key or Snowflake account.

The optional hosted NVIDIA acceptance path is intentionally separate from the regular suite. It requires a private `NVIDIA_KEY`; without one, SignalGrid remains fully usable with deterministic evidence-backed investigations and clearly labeled fallback state. The Snowflake scripts are statically reviewed and runnable reference SQL; live cloud execution is not claimed.

## Data notes

The included CSV is a preserved demonstration dataset. It contains repeated observations without reliable event timestamps, so the interface does not present derived costs as a verified monthly bill or claim a live cloud-account connection. The Snowflake suite documents source-backed attribution, a clearly synthetic query-history fixture, and the limits of the available source data. See [the Snowflake execution guide](scripts/snowflake/README.md).

## License

This repository is provided as a demonstration project. No open-source license is granted by this repository.
