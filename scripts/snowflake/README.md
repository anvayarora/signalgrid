# Snowflake execution guide

This SQL suite demonstrates source-backed report monitoring and cloud-credit attribution without pretending that the supplied CSV is a live Snowflake billing export.

## Purpose

The scripts cover the cost-attribution requirement in three clearly separated paths:

1. **Source-supported attribution** from the 2,000-row CSV.
2. **Synthetic query-log attribution** using a small, reproducible fixture with explicit report labels.
3. **ACCOUNT_USAGE reference SQL** for a real Snowflake account, including query-attributed compute, Query Acceleration, warehouse idle/unattributed compute, and cloud-services credits.

## Required files and order

Upload `data/raw/monitoring.csv` to a Snowflake stage, then run:

1. `01_schema.sql` — creates the observation, simulated-query, and optional credit-rate tables.
2. `02_stage_and_quality.sql` — defines the file format, stages the CSV, preserves source metadata, and merges validated rows idempotently.
3. `03_simulated_query_fixture.sql` — inserts six explicitly synthetic, report-labelled queries. Re-running it replaces only rows marked `SIMULATED_QUERY_FIXTURE`.
4. `03_attribution.sql` — creates observation, report-median, and simulated query-history attribution views.
5. `04_validation.sql` — runs dataset, quality, ratio, and fixture reconciliation checks.

`05_account_usage_reference.sql` is optional reference SQL. Run it only with suitable `SNOWFLAKE.ACCOUNT_USAGE` access and real query tags such as `{"signalgrid_report_id":"RPT_001"}`.

## Expected results

The source validation queries should report 2,000 observations, 100 reports, 20 rows per report, 245 placeholder/missing owners, 24 negative-credit rows, 1,490 observations above 15 seconds, four zero-view rows, and the documented refresh-status counts. The fixture should report six rows and non-empty attribution for `RPT_200`, `RPT_201`, and `RPT_202`.

Observation ratios are calculated only when the denominator is positive. Report summaries use the median of eligible row-level ratios because the repeated report rows have no reliable timestamps.

## Financial assumptions

- Snowflake credits are consumption units; the CSV supplies no credit-to-USD rate.
- AWS hosting amounts are USD and are validated independently from Snowflake-credit validity.
- Negative Snowflake credits remain visible but are excluded from credit ratios.
- Zero active views produce `NULL` per-view ratios rather than an invented value.
- Repeated observations are not verified monthly totals and are never silently summed into a bill.
- Outlier flags use a deterministic Q3 + 1.5×IQR review rule; they are review signals, not confirmed billing errors.
- The synthetic query fixture is illustrative only. Its fixed timestamps, warehouse name, query IDs, and credit amounts are not production measurements.
- Its `ACTIVE_VIEW_COUNT` values are intentionally non-overlapping per-query counts, so the simulated attribution view may add them for the fixture denominator. Do not use that additive denominator for production snapshots or distinct-view metrics without separately proving that the counts are disjoint.

## Live Snowflake requirements

The ACCOUNT_USAGE reference requires a real account, appropriate usage-view privileges, query-tag adoption, and allowance for Snowflake metadata latency. It keeps query-attributed warehouse compute separate from Query Acceleration, warehouse idle/unattributed compute, and cloud-services credits; it does not force those categories into a zero-remainder reconciliation. Live Snowflake execution is not claimed by the local application verification.
