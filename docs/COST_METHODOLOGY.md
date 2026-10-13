# SignalGrid Cost Methodology

SignalGrid reports simulated attribution from the supplied CSV. It does not claim a verified Snowflake bill or live `ACCOUNT_USAGE` execution. Snowflake credits remain consumption units; AWS values remain USD.

## Observation-level formulas

For each source observation with a positive active-view denominator:

```text
Snowflake credits per view = valid Snowflake credits / monthly active views
AWS cost per view          = valid AWS hosting USD / monthly active views
```

Negative Snowflake credits are preserved as invalid source records and excluded only from Snowflake-credit ratios. AWS hosting cost validity is evaluated independently, so a row with valid AWS cost and negative Snowflake credits can still contribute to AWS cost per view. Zero-view rows are preserved and return `null` for both per-view calculations because division has no valid denominator.

## Report-level aggregation

Report summaries use the median of valid observation-level ratios. They do not use a ratio of totals, a ratio of medians, or a silently summed repeated-row value. The API exposes independently ranked collections:

- `topReports`: highest median Snowflake credits per active view.
- `topAwsReports`: highest median AWS hosting cost per active view.

The Costs page uses `topAwsReports` for its AWS chart and labels the unit as cost per active view. Snowflake values are never rendered as dollars.

## Cost-versus-usage review

The data-quality check applies the documented `Q3 + 1.5 × IQR` rule to report-level AWS cost-per-view medians when enough valid reports exist. A flagged report is an observed statistical outlier relative to this dataset, not proof of overbilling or an accounting error; the CSV supplies no contractual hosting-cost benchmark.

The response includes the method, flagged report IDs, measured ratios, valid observation counts and source-row references. Invalid-credit and zero-view rows remain available from the Costs page for inspection.

## Scope and reconciliation

`/api/costs`, report detail and completed/replay-scoped views apply the same authorized observation set before calculating summaries. The five Snowflake SQL scripts in `scripts/snowflake/` preserve the corresponding staged-data, quality, attribution, validation and `ACCOUNT_USAGE` reference methodology. Live Snowflake execution remains explicitly unverified.

The additional `scripts/snowflake/03_simulated_query_fixture.sql` file provides six fixed, report-labelled query rows so the simulated query-history view is non-empty on a fresh worksheet run. They are synthetic inputs with explicit provenance, not recovered production query history. The ACCOUNT_USAGE reference keeps `CREDITS_ATTRIBUTED_COMPUTE` and `CREDITS_USED_QUERY_ACCELERATION` separate and leaves warehouse idle/unattributed and cloud-services categories visible rather than forcing them into report costs.
