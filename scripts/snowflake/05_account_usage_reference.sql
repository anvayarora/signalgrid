-- Reference implementation for a real Snowflake ACCOUNT_USAGE path.
-- The supplied CSV remains a separate validation/replay source: it cannot prove
-- warehouse, query, cloud-service, or infrastructure causality.
-- Required tagging convention: QUERY_TAG contains JSON such as
-- {"signalgrid_report_id":"RPT_001"} (or signalgrid_report_id=RPT_001).

-- QUERY_ATTRIBUTION_HISTORY is the authoritative per-query compute facility.
-- It includes query execution cost, not warehouse idle time, cloud services,
-- storage, data transfer, or serverless charges.
CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_QUERY_ATTRIBUTION AS
SELECT
  a.QUERY_ID,
  a.START_TIME,
  a.END_TIME,
  a.WAREHOUSE_NAME,
  a.QUERY_TAG,
  COALESCE(
    TRY_PARSE_JSON(a.QUERY_TAG):signalgrid_report_id::VARCHAR,
    REGEXP_SUBSTR(a.QUERY_TAG, 'signalgrid_report_id[=:]([A-Za-z0-9_-]+)', 1, 1, 'e', 1)
  ) AS REPORT_ID,
  a.CREDITS_ATTRIBUTED_COMPUTE,
  COALESCE(a.CREDITS_USED_QUERY_ACCELERATION, 0) AS QUERY_ACCELERATION_CREDITS,
  a.CREDITS_ATTRIBUTED_COMPUTE + COALESCE(a.CREDITS_USED_QUERY_ACCELERATION, 0) AS QUERY_ATTRIBUTED_COMPUTE_CREDITS
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY a
WHERE a.START_TIME >= DATEADD('day', -30, CURRENT_TIMESTAMP());

-- Warehouse metering is the reconciliation total. Snowflake exposes the amount
-- attributed to query execution separately, so idle/unattributed compute is
-- retained rather than proportionally assigned to tagged reports.
CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_WAREHOUSE_HOURS AS
SELECT
  WAREHOUSE_NAME,
  START_TIME AS USAGE_HOUR,
  END_TIME,
  CREDITS_USED_COMPUTE AS WAREHOUSE_COMPUTE_CREDITS,
  COALESCE(CREDITS_ATTRIBUTED_COMPUTE_QUERIES, 0) AS QUERY_ATTRIBUTED_COMPUTE_CREDITS,
  GREATEST(COALESCE(CREDITS_USED_COMPUTE, 0) - COALESCE(CREDITS_ATTRIBUTED_COMPUTE_QUERIES, 0), 0) AS IDLE_OR_UNATTRIBUTED_COMPUTE_CREDITS,
  COALESCE(CREDITS_USED_CLOUD_SERVICES, 0) AS CLOUD_SERVICES_CREDITS
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD('day', -30, CURRENT_TIMESTAMP());

-- A query can cross a warehouse-hour boundary. Allocate each query's compute
-- attribution by overlap duration so reconciliation does not count the full
-- query once per overlapping hour. A zero-duration query is assigned to its
-- first matching hour only.
CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_QUERY_HOUR_ALLOCATION AS
WITH overlapping AS (
  SELECT
    q.QUERY_ID, q.REPORT_ID, q.WAREHOUSE_NAME, q.START_TIME, q.END_TIME,
    q.QUERY_ATTRIBUTED_COMPUTE_CREDITS, h.USAGE_HOUR, h.END_TIME AS HOUR_END,
    DATEDIFF('millisecond', GREATEST(q.START_TIME, h.USAGE_HOUR), LEAST(q.END_TIME, h.END_TIME)) / 1000.0 AS OVERLAP_SECONDS,
    DATEDIFF('millisecond', q.START_TIME, q.END_TIME) / 1000.0 AS QUERY_SECONDS
  FROM SIGNALGRID_ACCOUNT_USAGE_QUERY_ATTRIBUTION q
  JOIN SIGNALGRID_ACCOUNT_USAGE_WAREHOUSE_HOURS h
    ON q.WAREHOUSE_NAME = h.WAREHOUSE_NAME
   AND q.START_TIME < h.END_TIME
   AND q.END_TIME > h.USAGE_HOUR
), weighted AS (
  SELECT *,
    IFF(QUERY_SECONDS > 0,
        QUERY_ATTRIBUTED_COMPUTE_CREDITS * OVERLAP_SECONDS / QUERY_SECONDS,
        QUERY_ATTRIBUTED_COMPUTE_CREDITS) AS ALLOCATED_QUERY_CREDITS,
    ROW_NUMBER() OVER (PARTITION BY QUERY_ID ORDER BY USAGE_HOUR) AS HOUR_RANK
  FROM overlapping
)
SELECT QUERY_ID, REPORT_ID, WAREHOUSE_NAME, USAGE_HOUR,
       IFF(QUERY_SECONDS > 0, ALLOCATED_QUERY_CREDITS,
           IFF(HOUR_RANK = 1, QUERY_ATTRIBUTED_COMPUTE_CREDITS, 0)) AS ALLOCATED_QUERY_CREDITS
FROM weighted;

-- Report costs use only actual query-attributed compute. Tagged, untagged, idle,
-- and cloud-service amounts remain distinguishable. Hour-crossing query costs
-- are allocated by overlap duration only for hourly reconciliation; report
-- totals still come directly from QUERY_ATTRIBUTION_HISTORY.
CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_REPORT_COSTS AS
SELECT
  REPORT_ID,
  COUNT(*) AS TAGGED_QUERY_COUNT,
  SUM(QUERY_ATTRIBUTED_COMPUTE_CREDITS) AS QUERY_ATTRIBUTED_COMPUTE_CREDITS,
  'QUERY_ATTRIBUTION_HISTORY; exact query-attributed compute' AS COMPUTE_METHODOLOGY
FROM SIGNALGRID_ACCOUNT_USAGE_QUERY_ATTRIBUTION
WHERE REPORT_ID IS NOT NULL
GROUP BY REPORT_ID;

CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_RECONCILIATION AS
SELECT
  h.WAREHOUSE_NAME,
  h.USAGE_HOUR,
  h.WAREHOUSE_COMPUTE_CREDITS,
  h.QUERY_ATTRIBUTED_COMPUTE_CREDITS,
  h.IDLE_OR_UNATTRIBUTED_COMPUTE_CREDITS,
  h.CLOUD_SERVICES_CREDITS,
  COALESCE(SUM(IFF(q.REPORT_ID IS NULL, q.ALLOCATED_QUERY_CREDITS, 0)), 0) AS UNTAGGED_QUERY_ATTRIBUTED_COMPUTE_CREDITS,
  COALESCE(SUM(IFF(q.REPORT_ID IS NOT NULL, q.ALLOCATED_QUERY_CREDITS, 0)), 0) AS TAGGED_QUERY_ATTRIBUTED_COMPUTE_CREDITS,
  h.QUERY_ATTRIBUTED_COMPUTE_CREDITS - COALESCE(SUM(q.ALLOCATED_QUERY_CREDITS), 0) AS ALLOCATION_REMAINDER_CREDITS,
  'Tagged/untagged query attribution allocated by overlap duration plus warehouse idle and cloud-service remainder' AS METHODOLOGY
FROM SIGNALGRID_ACCOUNT_USAGE_WAREHOUSE_HOURS h
LEFT JOIN SIGNALGRID_ACCOUNT_USAGE_QUERY_HOUR_ALLOCATION q
  ON q.WAREHOUSE_NAME = h.WAREHOUSE_NAME AND q.USAGE_HOUR = h.USAGE_HOUR
GROUP BY ALL;

-- Join to validated report observations only for reporting context. Active views
-- are observation medians, not a monthly total because source timestamps are absent.
CREATE OR REPLACE VIEW SIGNALGRID_ACCOUNT_USAGE_COST_PER_VIEW AS
SELECT c.REPORT_ID,
       c.QUERY_ATTRIBUTED_COMPUTE_CREDITS,
       s.MEDIAN_ACTIVE_VIEWS,
       IFF(s.MEDIAN_ACTIVE_VIEWS > 0,
           c.QUERY_ATTRIBUTED_COMPUTE_CREDITS / s.MEDIAN_ACTIVE_VIEWS, NULL) AS QUERY_ATTRIBUTED_CREDITS_PER_ACTIVE_VIEW,
       'Median of valid observation-row views; query-attributed compute only; cloud/idle/unattributed excluded' AS METHODOLOGY
FROM SIGNALGRID_ACCOUNT_USAGE_REPORT_COSTS c
LEFT JOIN SIGNALGRID_REPORT_COST_SUMMARY s USING (REPORT_ID);

-- Operational notes:
-- * ACCOUNT_USAGE is delayed (the query-attribution view may lag several hours).
-- * QUERY_ATTRIBUTION_HISTORY does not include cloud services, storage, transfer,
--   serverless or warehouse idle time; those remain explicitly unallocated here.
-- * Missing or malformed query tags are untagged, never guessed into a report.
-- * The reconciliation view is for finance review, not a fabricated per-report
--   charge for costs Snowflake cannot attribute to a query.
