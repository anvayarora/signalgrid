# Data quality report

The source file contains 2,000 observations and 100 report IDs. Each report appears 20 times, but no reliable timestamp is provided.

| Finding | Observed | Handling |
|---|---:|---|
| Placeholder or missing owner (`nan` / `ORPHANED_REPORT`) | 245 | Normalize to null, retain raw value, create `ORPHANED_OWNER` finding; a detection/incident is created only when that row is replayed |
| Negative Snowflake credits | 24 | Preserve value, create `NEGATIVE_CREDITS` finding, exclude from attribution; replay creates the detection |
| Load time over 15 seconds | 1,490 | Deterministic latency detections when replayed; 30 seconds or more is critical |
| Load time exactly 15 seconds | 7 | Not an incident because the rule is strictly greater than 15 |
| Zero active views | 4 | Cost per view is null, not divided by zero |
| Refresh `FAILED` | 382 | Critical detection when replayed |
| Refresh `TIMED_OUT` | 182 | High detection when replayed |
| Refresh `UNKNOWN` | 100 | Explicit medium data-quality detection when replayed; never silently treated as failure |

The report table uses median numeric values and status distributions. It does not invent an owner from conflicting rows, choose a latest row, or sum repeated monthly metrics.

## AWS cost-versus-usage review

SignalGrid also exposes a deterministic review flag as the `costUsageQuality` field in `/api/costs` and `/api/data-quality`. It computes each report's median valid row-level `AWS_HOSTING_COST_USD / MONTHLY_ACTIVE_VIEWS` ratio, excludes zero-view rows, then flags ratios above `Q3 + 1.5 × IQR` across reports. The threshold and flagged report IDs are returned with the response so the result is reproducible and auditable. This is a review signal only: the dataset contains no contractual AWS benchmark, so a flagged outlier is not classified as an accounting error.

AWS hosting-cost validity is independent of Snowflake-credit validity. A row with negative Snowflake credits is excluded from credit attribution but can still contribute its finite, positive-view AWS cost to the AWS ratio.

## Ownership quality and application responsibility

The CSV owner field is an observed source value, not a verified current organizational assignment. The backend reports observed owner candidates, valid-owner observation counts, missing/placeholder counts and conflicts without selecting a “latest” row because the source has no reliable timestamps. Separately, `report_assignments` records application responsibility for OWNER/ANALYST access, including provenance and an administrator audit trail. Assignment responsibility never overwrites the preserved source owner value.
