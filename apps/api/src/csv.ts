import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Observation, RefreshStatus } from "./types.js";

const header = [
  "report_id", "report_name", "owner_email", "last_refresh_status",
  "monthly_active_views", "snowflake_credits_consumed", "avg_load_time_sec",
  "aws_hosting_cost_usd", "query_count_last_30d", "concurrent_user_peak"
] as const;

const statuses = ["SUCCESS", "FAILED", "TIMED_OUT", "UNKNOWN"] as const;
const rowSchema = z.object({
  report_id: z.string().min(1),
  report_name: z.string().min(1),
  owner_email: z.string(),
  last_refresh_status: z.enum(statuses),
  monthly_active_views: z.coerce.number().finite().nonnegative(),
  snowflake_credits_consumed: z.coerce.number().finite(),
  avg_load_time_sec: z.coerce.number().finite().nonnegative(),
  aws_hosting_cost_usd: z.coerce.number().finite().nonnegative(),
  query_count_last_30d: z.coerce.number().int().nonnegative(),
  concurrent_user_peak: z.coerce.number().int().nonnegative()
});

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { values.push(current); current = ""; continue; }
    current += char;
  }
  values.push(current);
  return values;
}

function normalizeOwner(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || ["nan", "null", "none", "n/a", "orphaned_report", "unknown"].includes(normalized)) return null;
  return normalized;
}

export function loadDataset(path: string): { observations: Observation[]; sha256: string; header: string[]; errors: string[] } {
  const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  const actualHeader = parseCsvLine(lines[0] ?? "");
  const errors: string[] = [];
  if (actualHeader.join(",") !== header.join(",")) errors.push(`Schema header mismatch: expected ${header.join(",")}`);
  const observations: Observation[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const record = Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""]));
    const parsed = rowSchema.safeParse(record);
    if (!parsed.success) { errors.push(`Row ${i + 1}: ${parsed.error.issues.map(issue => issue.message).join("; ")}`); continue; }
    const row = parsed.data;
    observations.push({
      id: `obs-${String(i).padStart(5, "0")}`,
      rowNumber: i + 1,
      reportId: row.report_id,
      reportName: row.report_name,
      ownerEmail: row.owner_email,
      ownerNormalized: normalizeOwner(row.owner_email),
      refreshStatus: row.last_refresh_status as RefreshStatus,
      monthlyActiveViews: row.monthly_active_views,
      snowflakeCredits: row.snowflake_credits_consumed,
      avgLoadTimeSec: row.avg_load_time_sec,
      awsHostingCostUsd: row.aws_hosting_cost_usd,
      queryCountLast30d: row.query_count_last_30d,
      concurrentUserPeak: row.concurrent_user_peak,
      rawJson: JSON.stringify(record)
    });
  }
  return { observations, sha256: createHash("sha256").update(content).digest("hex"), header: actualHeader, errors };
}

export function isOrphan(owner: string | null): boolean { return owner === null; }
