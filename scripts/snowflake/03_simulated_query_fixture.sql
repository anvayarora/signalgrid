-- Reproducible, synthetic query-history fixture.
--
-- This is deliberately separate from the CSV observation path and from a real
-- SNOWFLAKE.ACCOUNT_USAGE extract. It demonstrates the shape of a query-tagged
-- cost allocation when every query has an explicit report label. The timestamps
-- are fixed fixture metadata, not claimed production execution times.
-- Execute after 02_stage_and_quality.sql and before 03_attribution.sql.

DELETE FROM SIGNALGRID_SIMULATED_QUERY_HISTORY
WHERE SOURCE_LABEL = 'SIMULATED_QUERY_FIXTURE';

INSERT INTO SIGNALGRID_SIMULATED_QUERY_HISTORY (
  QUERY_ID,
  QUERY_START_TIME,
  WAREHOUSE_NAME,
  REPORT_ID,
  CREDITS_USED_CLOUD_SERVICES,
  CREDITS_USED_COMPUTE,
  ACTIVE_VIEW_COUNT,
  SOURCE_LABEL
)
VALUES
  ('fixture-q-200-01', TO_TIMESTAMP_NTZ('2025-01-15 10:00:00'), 'SIM_WH', 'RPT_200', 0.10, 1.20, 30, 'SIMULATED_QUERY_FIXTURE'),
  ('fixture-q-200-02', TO_TIMESTAMP_NTZ('2025-01-15 10:05:00'), 'SIM_WH', 'RPT_200', 0.05, 0.80, 20, 'SIMULATED_QUERY_FIXTURE'),
  ('fixture-q-201-01', TO_TIMESTAMP_NTZ('2025-01-15 10:10:00'), 'SIM_WH', 'RPT_201', 0.10, 0.60, 15, 'SIMULATED_QUERY_FIXTURE'),
  ('fixture-q-201-02', TO_TIMESTAMP_NTZ('2025-01-15 10:15:00'), 'SIM_WH', 'RPT_201', 0.05, 0.40, 10, 'SIMULATED_QUERY_FIXTURE'),
  ('fixture-q-202-01', TO_TIMESTAMP_NTZ('2025-01-15 10:20:00'), 'SIM_WH', 'RPT_202', 0.20, 1.50, 40, 'SIMULATED_QUERY_FIXTURE'),
  ('fixture-q-202-02', TO_TIMESTAMP_NTZ('2025-01-15 10:25:00'), 'SIM_WH', 'RPT_202', 0.05, 0.50, 10, 'SIMULATED_QUERY_FIXTURE');

-- The fixture is intentionally small and deterministic. These checks make an
-- empty or accidentally duplicated fixture visible before attribution review.
SELECT 'simulated_fixture_rows' AS CHECK_NAME,
       COUNT(*) AS ACTUAL,
       6 AS EXPECTED,
       IFF(COUNT(*) = 6, 'PASS', 'FAIL') AS STATUS
FROM SIGNALGRID_SIMULATED_QUERY_HISTORY
WHERE SOURCE_LABEL = 'SIMULATED_QUERY_FIXTURE';

SELECT 'simulated_fixture_valid_reports' AS CHECK_NAME,
       COUNT_IF(o.REPORT_ID IS NOT NULL) AS ACTUAL,
       COUNT(*) AS EXPECTED,
       IFF(COUNT(*) = COUNT_IF(o.REPORT_ID IS NOT NULL), 'PASS', 'FAIL') AS STATUS
FROM SIGNALGRID_SIMULATED_QUERY_HISTORY r
LEFT JOIN (SELECT DISTINCT REPORT_ID FROM SIGNALGRID_REPORT_OBSERVATIONS) o
  ON o.REPORT_ID = r.REPORT_ID
WHERE r.SOURCE_LABEL = 'SIMULATED_QUERY_FIXTURE';
