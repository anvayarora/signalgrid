import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Incident, Observation, RcaResult, ReportAssignment, Role } from "./types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, row_number INTEGER NOT NULL, report_id TEXT NOT NULL,
        report_name TEXT NOT NULL, owner_email TEXT NOT NULL, owner_normalized TEXT,
        refresh_status TEXT NOT NULL, monthly_active_views REAL NOT NULL,
        snowflake_credits REAL NOT NULL, avg_load_time_sec REAL NOT NULL,
        aws_hosting_cost_usd REAL NOT NULL, query_count_last_30d INTEGER NOT NULL,
        concurrent_user_peak INTEGER NOT NULL, raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_report ON observations(report_id);
      CREATE TABLE IF NOT EXISTS quality_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id TEXT NOT NULL,
        finding_code TEXT NOT NULL, severity TEXT NOT NULL, detail TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(observation_id, finding_code),
        FOREIGN KEY(observation_id) REFERENCES observations(id)
      );
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, report_id TEXT NOT NULL,
        observation_id TEXT NOT NULL, rule_code TEXT NOT NULL, rule_version TEXT NOT NULL,
        severity TEXT NOT NULL, observed_metric REAL, threshold TEXT NOT NULL,
        evidence_json TEXT NOT NULL, detected_at TEXT NOT NULL, simulation_timestamp TEXT,
        status TEXT NOT NULL DEFAULT 'open', investigation_status TEXT NOT NULL DEFAULT 'pending', group_id TEXT,
        UNIQUE(session_id, observation_id, rule_code, rule_version),
        FOREIGN KEY(observation_id) REFERENCES observations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_detected ON incidents(detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_report ON incidents(report_id);
      CREATE TABLE IF NOT EXISTS incident_groups (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, report_id TEXT NOT NULL, rule_code TEXT NOT NULL,
        severity TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 0,
        evidence_count INTEGER NOT NULL DEFAULT 0, first_detected TEXT NOT NULL,
        last_detected TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        investigation_status TEXT NOT NULL DEFAULT 'pending', signature_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_groups_report ON incident_groups(report_id);
      CREATE TABLE IF NOT EXISTS incident_group_members (
        group_id TEXT NOT NULL, incident_id INTEGER NOT NULL, detection_event_id INTEGER,
        PRIMARY KEY(group_id, incident_id, detection_event_id)
      );
      CREATE TABLE IF NOT EXISTS detection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        observation_id TEXT NOT NULL, report_id TEXT NOT NULL, rule_code TEXT NOT NULL,
        rule_version TEXT NOT NULL, severity TEXT NOT NULL, observed_metric REAL,
        threshold TEXT NOT NULL, evidence_json TEXT NOT NULL, simulation_timestamp TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, observation_id, rule_code, rule_version)
      );
      CREATE TABLE IF NOT EXISTS rca_jobs (
        incident_id INTEGER PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT, evidence_hash TEXT, error TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(incident_id) REFERENCES incidents(id)
      );
      CREATE TABLE IF NOT EXISTS rca_group_jobs (
        group_id TEXT PRIMARY KEY, job_id TEXT UNIQUE, session_id TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, evidence_hash TEXT,
        provider TEXT, model TEXT, error TEXT, tool_trace_json TEXT, provider_request_count INTEGER NOT NULL DEFAULT 0, provider_attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES incident_groups(id)
      );
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL, sha256 TEXT NOT NULL,
        row_count INTEGER NOT NULL, error_count INTEGER NOT NULL, imported_at TEXT NOT NULL,
        UNIQUE(source_path, sha256)
      );
      CREATE TABLE IF NOT EXISTS replay_sessions (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, seed INTEGER NOT NULL, speed REAL NOT NULL,
        ordering TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL,
        total INTEGER NOT NULL, order_json TEXT NOT NULL, started_at TEXT,
        updated_at TEXT NOT NULL, principal_username TEXT, principal_role TEXT, scope_json TEXT,
        shared_evaluation INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS report_assignments (
        username TEXT NOT NULL, report_id TEXT NOT NULL, role TEXT NOT NULL,
        provenance TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(username, report_id)
      );
      CREATE INDEX IF NOT EXISTS idx_report_assignments_user ON report_assignments(username);
      CREATE INDEX IF NOT EXISTS idx_report_assignments_report ON report_assignments(report_id);
      CREATE TABLE IF NOT EXISTS assignment_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, report_id TEXT NOT NULL,
        action TEXT NOT NULL, role TEXT, provenance TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    try { this.db.exec("ALTER TABLE incidents ADD COLUMN group_id TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE incidents ADD COLUMN session_id TEXT NOT NULL DEFAULT 'seed'"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE incident_groups ADD COLUMN session_id TEXT NOT NULL DEFAULT 'seed'"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE rca_group_jobs ADD COLUMN provider_attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE rca_group_jobs ADD COLUMN job_id TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE rca_group_jobs ADD COLUMN tool_trace_json TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE rca_group_jobs ADD COLUMN provider_request_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { this.db.exec("UPDATE rca_group_jobs SET job_id='rca-job:' || group_id WHERE job_id IS NULL"); } catch { /* already exists */ }
    try { this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rca_group_jobs_job_id ON rca_group_jobs(job_id)"); } catch { /* legacy databases may need operator cleanup */ }
    // Older builds enforced one global running replay. Session ownership and the
    // service-level concurrency limit now provide the safe boundary instead.
    try { this.db.exec("DROP INDEX IF EXISTS idx_one_running_replay"); } catch { /* already removed */ }
    try { this.db.exec("ALTER TABLE replay_sessions ADD COLUMN principal_username TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE replay_sessions ADD COLUMN principal_role TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE replay_sessions ADD COLUMN scope_json TEXT"); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE replay_sessions ADD COLUMN shared_evaluation INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    // A short-lived development migration once declared report_assignments as
    // a foreign key to observations.report_id, which is intentionally non-unique
    // because each report has 20 preserved source rows. Rebuild that table in
    // place when encountered, retaining every assignment and its provenance.
    try {
      const foreignKeys = this.db.prepare("PRAGMA foreign_key_list(report_assignments)").all() as unknown[];
      if (foreignKeys.length) {
        this.db.exec("DROP INDEX IF EXISTS idx_report_assignments_user; DROP INDEX IF EXISTS idx_report_assignments_report; ALTER TABLE report_assignments RENAME TO report_assignments_legacy; CREATE TABLE report_assignments (username TEXT NOT NULL, report_id TEXT NOT NULL, role TEXT NOT NULL, provenance TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(username, report_id)); INSERT INTO report_assignments(username,report_id,role,provenance,created_by,created_at,updated_at) SELECT username,report_id,role,provenance,created_by,created_at,updated_at FROM report_assignments_legacy; DROP TABLE report_assignments_legacy; CREATE INDEX IF NOT EXISTS idx_report_assignments_user ON report_assignments(username); CREATE INDEX IF NOT EXISTS idx_report_assignments_report ON report_assignments(report_id);");
      }
    } catch { /* fresh databases already have the corrected schema */ }
  }

  seedObservations(observations: Observation[], sourcePath: string, sha256: string, errors: string[]) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO observations
      (id,row_number,report_id,report_name,owner_email,owner_normalized,refresh_status,monthly_active_views,
       snowflake_credits,avg_load_time_sec,aws_hosting_cost_usd,query_count_last_30d,concurrent_user_peak,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const finding = this.db.prepare(`INSERT OR IGNORE INTO quality_findings
      (observation_id,finding_code,severity,detail,created_at) VALUES (?,?,?,?,?)`);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const o of observations) {
        insert.run(o.id,o.rowNumber,o.reportId,o.reportName,o.ownerEmail,o.ownerNormalized,o.refreshStatus,
          o.monthlyActiveViews,o.snowflakeCredits,o.avgLoadTimeSec,o.awsHostingCostUsd,o.queryCountLast30d,o.concurrentUserPeak,o.rawJson);
        if (!o.ownerNormalized) finding.run(o.id,"ORPHANED_OWNER","high","Owner is missing or a placeholder value",now);
        if (o.snowflakeCredits < 0) finding.run(o.id,"NEGATIVE_CREDITS","high","Snowflake credit value is negative and excluded from cost attribution",now);
        if (o.refreshStatus === "UNKNOWN") finding.run(o.id,"UNKNOWN_REFRESH_STATUS","medium","Refresh status is UNKNOWN",now);
        if (o.monthlyActiveViews === 0) finding.run(o.id,"ZERO_ACTIVE_VIEWS","medium","Zero active views; cost per view is undefined",now);
      }
      this.db.prepare("INSERT OR IGNORE INTO imports(source_path,sha256,row_count,error_count,imported_at) VALUES (?,?,?,?,?)")
        .run(sourcePath,sha256,observations.length,errors.length,now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  observation(id: string): Observation | null {
    const row = this.db.prepare("SELECT * FROM observations WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapObservation(row) : null;
  }

  observations(filters: { reportId?: string; limit?: number } = {}): Observation[] {
    const where = filters.reportId ? " WHERE report_id=?" : "";
    const params = filters.reportId ? [filters.reportId] : [];
    const limit = filters.limit ?? 5000;
    const rows = this.db.prepare(`SELECT * FROM observations${where} ORDER BY row_number LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    return rows.map(row => this.mapObservation(row));
  }

  private mapObservation(row: Record<string, unknown>): Observation {
    return {
      id: String(row.id), rowNumber: Number(row.row_number), reportId: String(row.report_id), reportName: String(row.report_name),
      ownerEmail: String(row.owner_email), ownerNormalized: row.owner_normalized ? String(row.owner_normalized) : null,
      refreshStatus: String(row.refresh_status) as Observation["refreshStatus"], monthlyActiveViews: Number(row.monthly_active_views),
      snowflakeCredits: Number(row.snowflake_credits), avgLoadTimeSec: Number(row.avg_load_time_sec), awsHostingCostUsd: Number(row.aws_hosting_cost_usd),
      queryCountLast30d: Number(row.query_count_last_30d), concurrentUserPeak: Number(row.concurrent_user_peak), rawJson: String(row.raw_json)
    };
  }

  reports() { return this.db.prepare("SELECT report_id AS reportId, report_name AS reportName, COUNT(*) AS observationCount FROM observations GROUP BY report_id ORDER BY report_id").all() as Record<string, unknown>[]; }
  qualityFindings(limit = 500) { return this.db.prepare("SELECT * FROM quality_findings ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]; }
  qualityCounts() { return this.db.prepare("SELECT finding_code AS code, severity, COUNT(*) AS count FROM quality_findings GROUP BY finding_code, severity ORDER BY count DESC").all() as Record<string, unknown>[]; }

  insertIncident(input: Omit<Incident, "id" | "status" | "investigationStatus" | "sessionId">, sessionId = "seed"): { incident: Incident | null; inserted: boolean; detectionInserted: boolean; groupInserted: boolean; groupId: string | null; detectionEventId: number | null } {
    const detection = this.db.prepare(`INSERT OR IGNORE INTO detection_events
      (session_id,observation_id,report_id,rule_code,rule_version,severity,observed_metric,threshold,evidence_json,simulation_timestamp,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,input.observationId,input.reportId,input.ruleCode,input.ruleVersion,input.severity,input.observedMetric,input.threshold,input.evidenceJson,input.simulationTimestamp,input.detectedAt);
    const detectionInserted = Number(detection.changes) > 0;
    const groupId = `group:${sessionId}:${input.reportId}:${input.ruleCode}`;
    const groupInserted = detectionInserted && !this.incidentGroup(groupId);
    if (detectionInserted) {
      this.db.prepare(`INSERT INTO incident_groups(id,session_id,report_id,rule_code,severity,occurrence_count,evidence_count,first_detected,last_detected)
        VALUES(?,?,?,?,?,1,1,?,?) ON CONFLICT(id) DO UPDATE SET occurrence_count=incident_groups.occurrence_count+1, evidence_count=incident_groups.evidence_count+1, last_detected=excluded.last_detected,
        severity=CASE WHEN excluded.severity='critical' OR incident_groups.severity='critical' THEN 'critical' WHEN excluded.severity='high' OR incident_groups.severity='high' THEN 'high' ELSE incident_groups.severity END`).run(groupId,sessionId,input.reportId,input.ruleCode,input.severity,input.detectedAt,input.detectedAt);
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO incidents
      (session_id,report_id,observation_id,rule_code,rule_version,severity,observed_metric,threshold,evidence_json,detected_at,simulation_timestamp,group_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,input.reportId,input.observationId,input.ruleCode,input.ruleVersion,input.severity,input.observedMetric,input.threshold,input.evidenceJson,input.detectedAt,input.simulationTimestamp,groupId);
    const row = this.db.prepare("SELECT * FROM incidents WHERE session_id=? AND observation_id=? AND rule_code=? AND rule_version=?")
      .get(sessionId,input.observationId,input.ruleCode,input.ruleVersion) as Record<string, unknown> | undefined;
    const detectionRow = detectionInserted ? this.db.prepare("SELECT id FROM detection_events WHERE session_id=? AND observation_id=? AND rule_code=? AND rule_version=?").get(sessionId,input.observationId,input.ruleCode,input.ruleVersion) as Record<string, unknown> : undefined;
    if (row && detectionRow) this.db.prepare("INSERT OR IGNORE INTO incident_group_members(group_id,incident_id,detection_event_id) VALUES (?,?,?)").run(groupId, Number(row.id), Number(detectionRow.id));
    return { incident: row ? this.mapIncident(row) : null, inserted: Number(result.changes) > 0, detectionInserted, groupInserted, groupId, detectionEventId: detectionRow ? Number(detectionRow.id) : null };
  }

  mapIncident(row: Record<string, unknown>): Incident {
    return { id: Number(row.id), sessionId: String(row.session_id ?? "seed"), reportId: String(row.report_id), observationId: String(row.observation_id), ruleCode: String(row.rule_code), ruleVersion: String(row.rule_version),
      severity: String(row.severity) as Incident["severity"], observedMetric: row.observed_metric == null ? null : Number(row.observed_metric), threshold: String(row.threshold), evidenceJson: String(row.evidence_json), detectedAt: String(row.detected_at), simulationTimestamp: row.simulation_timestamp ? String(row.simulation_timestamp) : null,
      status: String(row.status) as Incident["status"], investigationStatus: String(row.investigation_status) as Incident["investigationStatus"], groupId: row.group_id ? String(row.group_id) : undefined };
  }
  incident(id: number): Incident | null { const row = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? this.mapIncident(row) : null; }
  incidents(opts: { limit?: number; status?: string; severity?: string; search?: string; sessionId?: string } = {}) {
    const clauses: string[] = []; const params: any[] = [];
    if (opts.status) { clauses.push("status=?"); params.push(opts.status); }
    if (opts.severity) { clauses.push("severity=?"); params.push(opts.severity); }
    if (opts.search) { clauses.push("(report_id LIKE ? OR rule_code LIKE ?)"); params.push(`%${opts.search}%`,`%${opts.search}%`); }
    if (opts.sessionId) { clauses.push("session_id=?"); params.push(opts.sessionId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM incidents ${where} ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, detected_at DESC LIMIT ?`).all(...params, opts.limit ?? 100) as Record<string, unknown>[];
    return rows.map(row => this.mapIncident(row));
  }
  acknowledge(id: number) { this.db.prepare("UPDATE incidents SET status='acknowledged' WHERE id=?").run(id); }
  setIncidentInvestigationStatus(id: number, status: string) { this.db.prepare("UPDATE incidents SET investigation_status=? WHERE id=?").run(status,id); }
  rcaJob(id: number) { return this.db.prepare("SELECT * FROM rca_jobs WHERE incident_id=?").get(id) as Record<string, unknown> | undefined; }
  upsertRcaJob(id: number, status: string, result: RcaResult | null, evidenceHash: string | null, error: string | null = null) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO rca_jobs(incident_id,status,attempts,result_json,evidence_hash,error,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(incident_id) DO UPDATE SET status=excluded.status, attempts=rca_jobs.attempts+1, result_json=excluded.result_json, evidence_hash=excluded.evidence_hash, error=excluded.error, updated_at=excluded.updated_at`)
      .run(id,status,0,result ? JSON.stringify(result) : null,evidenceHash,error,now);
  }
  rcaResult(id: number): RcaResult | null { const row = this.rcaJob(id); return row?.result_json ? JSON.parse(String(row.result_json)) as RcaResult : null; }

  addEvent(eventType: string, payload: unknown): number {
    const result = this.db.prepare("INSERT INTO event_log(event_type,payload_json,created_at) VALUES (?,?,?)").run(eventType,JSON.stringify(payload),new Date().toISOString());
    return Number(result.lastInsertRowid);
  }
  latestEventId() { return Number((this.db.prepare("SELECT COALESCE(MAX(id),0) value FROM event_log").get() as Record<string, unknown>).value); }
  eventsSince(id: number, limit = 100) { return this.db.prepare("SELECT * FROM event_log WHERE id>? ORDER BY id LIMIT ?").all(id,limit) as Record<string, unknown>[]; }
  recentEvents(limit = 50) { return this.db.prepare("SELECT * FROM event_log ORDER BY id DESC LIMIT ?").all(limit).reverse() as Record<string, unknown>[]; }
  incidentGroups(limit = 100) { return this.db.prepare("SELECT * FROM incident_groups ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, last_detected DESC LIMIT ?").all(limit) as Record<string, unknown>[]; }
  actionableIncidentGroups(opts: { limit?: number; status?: string; severity?: string; ruleCode?: string; investigationStatus?: string; search?: string; sessionId?: string } = {}) {
    const clauses: string[] = []; const params: any[] = [];
    if (opts.status) { clauses.push("g.status=?"); params.push(opts.status); }
    if (opts.severity) { clauses.push("g.severity=?"); params.push(opts.severity); }
    if (opts.ruleCode) { clauses.push("g.rule_code=?"); params.push(opts.ruleCode); }
    if (opts.investigationStatus) { clauses.push("COALESCE(j.status, 'not_queued')=?"); params.push(opts.investigationStatus); }
    if (opts.search) { clauses.push("(g.report_id LIKE ? OR g.rule_code LIKE ?)"); params.push(`%${opts.search}%`, `%${opts.search}%`); }
    if (opts.sessionId) { clauses.push("g.session_id=?"); params.push(opts.sessionId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT g.*, COALESCE(j.status, 'not_queued') AS rca_status, j.result_json AS rca_result_json, j.error AS rca_error
      FROM incident_groups g LEFT JOIN rca_group_jobs j ON j.group_id=g.id ${where}
      ORDER BY CASE g.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, g.last_detected DESC LIMIT ?`).all(...params, opts.limit ?? 100) as Record<string, unknown>[];
  }
  detectionEvents(opts: { limit?: number; sessionId?: string } = {}) {
    if (opts.sessionId) return this.db.prepare("SELECT * FROM detection_events WHERE session_id=? ORDER BY id DESC LIMIT ?").all(opts.sessionId, opts.limit ?? 200) as Record<string, unknown>[];
    return this.db.prepare("SELECT * FROM detection_events ORDER BY id DESC LIMIT ?").all(opts.limit ?? 200) as Record<string, unknown>[];
  }
  detectionCount(sessionId?: string) { const row = sessionId ? this.db.prepare("SELECT COUNT(*) value FROM detection_events WHERE session_id=?").get(sessionId) : this.db.prepare("SELECT COUNT(*) value FROM detection_events").get(); return Number((row as Record<string, unknown>).value); }
  saveReplaySession(session: { id: string; mode: string; seed: number; speed: number; ordering: string; state: string; position: number; total: number; order: string[]; startedAt?: string | null; principalUsername?: string | null; principalRole?: Role | null; scopeReportIds?: string[] | null; sharedEvaluation?: boolean }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO replay_sessions(id,mode,seed,speed,ordering,state,position,total,order_json,started_at,updated_at,principal_username,principal_role,scope_json,shared_evaluation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,seed=excluded.seed,speed=excluded.speed,ordering=excluded.ordering,state=excluded.state,position=excluded.position,total=excluded.total,order_json=excluded.order_json,started_at=excluded.started_at,updated_at=excluded.updated_at,principal_username=excluded.principal_username,principal_role=excluded.principal_role,scope_json=excluded.scope_json,shared_evaluation=excluded.shared_evaluation`)
      .run(session.id,session.mode,session.seed,session.speed,session.ordering,session.state,session.position,session.total,JSON.stringify(session.order),session.startedAt ?? null,now,session.principalUsername ?? null,session.principalRole ?? null,session.scopeReportIds ? JSON.stringify(session.scopeReportIds) : null,session.sharedEvaluation ? 1 : 0);
  }
  updateReplaySession(id: string, patch: { state?: string; position?: number; speed?: number; startedAt?: string | null }) {
    const current = this.replaySession(id); if (!current) return;
    this.saveReplaySession({ ...current, ...patch, order: current.order, startedAt: patch.startedAt === undefined ? current.startedAt : patch.startedAt });
  }
  replaySession(id?: string) { const row = id ? this.db.prepare("SELECT * FROM replay_sessions WHERE id=?").get(id) : this.db.prepare("SELECT * FROM replay_sessions ORDER BY updated_at DESC LIMIT 1").get(); if (!row) return null; const r = row as Record<string, unknown>; return { id: String(r.id), mode: String(r.mode) as "full"|"curated", seed: Number(r.seed), speed: Number(r.speed), ordering: String(r.ordering) as "sequential"|"seeded-interleaved", state: String(r.state) as "configured"|"running"|"paused"|"completed"|"reset", position: Number(r.position), total: Number(r.total), order: JSON.parse(String(r.order_json)) as string[], startedAt: r.started_at ? String(r.started_at) : null, updatedAt: String(r.updated_at), principalUsername: r.principal_username ? String(r.principal_username) : null, principalRole: r.principal_role ? String(r.principal_role) as Role : null, scopeReportIds: r.scope_json ? JSON.parse(String(r.scope_json)) as string[] : null, sharedEvaluation: Number(r.shared_evaluation ?? 0) === 1 }; }
  replaySessionsFor(username: string) { const rows = this.db.prepare("SELECT id FROM replay_sessions WHERE principal_username=? ORDER BY updated_at DESC").all(username) as Array<{ id: string }>; return rows.map(row => this.replaySession(String(row.id))).filter((session): session is NonNullable<ReturnType<Store["replaySession"]>> => Boolean(session)); }
  latestReplaySessionFor(username: string) { return this.replaySessionsFor(username)[0] ?? null; }
  latestCompletedFullReplay() { const row = this.db.prepare("SELECT id FROM replay_sessions WHERE mode='full' AND state='completed' AND shared_evaluation=1 AND principal_username IS NULL AND principal_role IS NULL AND scope_json IS NULL AND position=total AND total=(SELECT COUNT(*) FROM observations) ORDER BY updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined; return row?.id ? this.replaySession(String(row.id)) : null; }
  runningReplaySession() { const row = this.db.prepare("SELECT id FROM replay_sessions WHERE state='running' ORDER BY updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined; return row?.id ? String(row.id) : null; }
  runningReplayCount() { return Number((this.db.prepare("SELECT COUNT(*) value FROM replay_sessions WHERE state='running'").get() as Record<string, unknown>).value); }
  runningReplaySessions() { return this.db.prepare("SELECT id FROM replay_sessions WHERE state='running' ORDER BY updated_at DESC").all() as Array<{ id: string }>; }

  seedAssignments(reportIds: string[], actor = "system") {
    const existing = Number((this.db.prepare("SELECT COUNT(*) value FROM report_assignments").get() as Record<string, unknown>).value ?? 0);
    if (existing > 0) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO report_assignments(username,report_id,role,provenance,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
    // Stable, source-backed demo scope: 60 reports for the OWNER, 60 for the
    // ANALYST, with a deterministic 20-report overlap for review handoff.
    const sorted = [...new Set(reportIds)].sort();
    const ownerReports = sorted.slice(0, Math.min(60, sorted.length));
    const analystReports = sorted.slice(Math.max(0, sorted.length - 60));
    for (const reportId of ownerReports) insert.run("user", reportId, "OWNER", "seeded_demo_assignment_v1", actor, now, now);
    for (const reportId of analystReports) insert.run("analyst", reportId, "ANALYST", "seeded_demo_assignment_v1", actor, now, now);
  }
  assignmentsFor(username: string) { return this.db.prepare("SELECT username,report_id AS reportId,role,provenance,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM report_assignments WHERE username=? ORDER BY report_id").all(username) as unknown as ReportAssignment[]; }
  assignedReportIds(username: string) { return this.assignmentsFor(username).map(row => row.reportId); }
  listAssignments() { return this.db.prepare("SELECT username,report_id AS reportId,role,provenance,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM report_assignments ORDER BY username, report_id").all() as unknown as ReportAssignment[]; }
  setAssignment(input: { username: string; reportId: string; role: "OWNER" | "ANALYST"; provenance?: string; actor: string }) {
    if (!this.db.prepare("SELECT 1 FROM observations WHERE report_id=? LIMIT 1").get(input.reportId)) throw new Error("Report not found");
    const now = new Date().toISOString(); const provenance = input.provenance ?? "admin_assignment";
    this.db.prepare(`INSERT INTO report_assignments(username,report_id,role,provenance,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(username,report_id) DO UPDATE SET role=excluded.role,provenance=excluded.provenance,updated_at=excluded.updated_at`).run(input.username,input.reportId,input.role,provenance,input.actor,now,now);
    this.db.prepare("INSERT INTO assignment_audit(username,report_id,action,role,provenance,actor,created_at) VALUES(?,?,?,?,?,?,?)").run(input.username,input.reportId,"upsert",input.role,provenance,input.actor,now);
    return this.assignmentsFor(input.username).find(row => row.reportId === input.reportId) ?? null;
  }
  removeAssignment(username: string, reportId: string, actor: string) {
    const existing = this.db.prepare("SELECT role,provenance FROM report_assignments WHERE username=? AND report_id=?").get(username,reportId) as Record<string,unknown>|undefined;
    if (!existing) return false;
    this.db.prepare("DELETE FROM report_assignments WHERE username=? AND report_id=?").run(username,reportId);
    this.db.prepare("INSERT INTO assignment_audit(username,report_id,action,role,provenance,actor,created_at) VALUES(?,?,?,?,?,?,?)").run(username,reportId,"remove",String(existing.role ?? ""),String(existing.provenance ?? ""),actor,new Date().toISOString());
    return true;
  }
  assignmentAudit(limit = 200) { return this.db.prepare("SELECT * FROM assignment_audit ORDER BY id DESC LIMIT ?").all(limit) as Record<string,unknown>[]; }
  stats() {
    const scalar = (sql: string) => Number((this.db.prepare(sql).get() as Record<string, unknown> | undefined)?.value ?? 0);
    const detections = scalar("SELECT COUNT(*) value FROM detection_events");
    return { observations: scalar("SELECT COUNT(*) value FROM observations"), reports: scalar("SELECT COUNT(DISTINCT report_id) value FROM observations"), incidents: scalar("SELECT COUNT(*) value FROM incidents"), groupedIncidents: scalar("SELECT COUNT(*) value FROM incident_groups"), detections, detectionEvents: detections, openIncidents: scalar("SELECT COUNT(*) value FROM incidents WHERE status='open'"), orphaned: scalar("SELECT COUNT(*) value FROM quality_findings WHERE finding_code='ORPHANED_OWNER'"), invalidCredits: scalar("SELECT COUNT(*) value FROM quality_findings WHERE finding_code='NEGATIVE_CREDITS'") };
  }

  latestImportSha() { const row = this.db.prepare("SELECT sha256 FROM imports ORDER BY imported_at DESC, id DESC LIMIT 1").get() as Record<string, unknown> | undefined; return row?.sha256 ? String(row.sha256) : null; }
  observationCount() { return Number((this.db.prepare("SELECT COUNT(*) value FROM observations").get() as Record<string, unknown>).value); }

  incidentGroup(id: string) { return this.db.prepare("SELECT * FROM incident_groups WHERE id=?").get(id) as Record<string, unknown> | undefined; }
  groupMembers(groupId: string) {
    return this.db.prepare(`SELECT i.*, d.id AS detection_event_id, d.session_id AS detection_session_id,
      d.evidence_json AS detection_evidence_json, d.simulation_timestamp AS detection_simulation_timestamp,
      d.created_at AS detection_created_at
      FROM incident_group_members m JOIN incidents i ON i.id=m.incident_id
      LEFT JOIN detection_events d ON d.id=m.detection_event_id
      WHERE m.group_id=? ORDER BY i.detected_at, i.id`).all(groupId) as Record<string, unknown>[];
  }
  acknowledgeGroup(groupId: string) {
    this.db.prepare("UPDATE incident_groups SET status='acknowledged' WHERE id=?").run(groupId);
    this.db.prepare("UPDATE incidents SET status='acknowledged' WHERE group_id=?").run(groupId);
  }
  setGroupInvestigationStatus(groupId: string, status: string) {
    this.db.prepare("UPDATE incident_groups SET investigation_status=? WHERE id=?").run(status, groupId);
    this.db.prepare("UPDATE incidents SET investigation_status=? WHERE group_id=?").run(status, groupId);
  }
  rcaGroupJob(groupId: string) { return this.db.prepare("SELECT * FROM rca_group_jobs WHERE group_id=?").get(groupId) as Record<string, unknown> | undefined; }
  latestHostedRca(provider: string) { return this.db.prepare("SELECT * FROM rca_group_jobs WHERE provider=? ORDER BY updated_at DESC LIMIT 1").get(provider) as Record<string, unknown> | undefined; }
  pendingRcaGroups() { return this.db.prepare("SELECT group_id AS groupId FROM rca_group_jobs WHERE status IN ('pending','running') ORDER BY updated_at").all() as Array<{ groupId: string }>; }
  hostedRcaCount(sessionId: string) { return Number((this.db.prepare("SELECT COALESCE(SUM(provider_attempts),0) value FROM rca_group_jobs WHERE session_id=?").get(sessionId) as Record<string, unknown>).value); }
  upsertRcaGroupJob(groupId: string, sessionId: string, status: string, result: RcaResult | null, evidenceHash: string | null, provider: string | null = null, model: string | null = null, error: string | null = null) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO rca_group_jobs(group_id,job_id,session_id,status,attempts,result_json,evidence_hash,provider,model,error,tool_trace_json,provider_request_count,provider_attempts,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET status=excluded.status,
      attempts=rca_group_jobs.attempts+1,result_json=excluded.result_json,evidence_hash=excluded.evidence_hash,
      provider=excluded.provider,model=excluded.model,error=excluded.error,tool_trace_json=excluded.tool_trace_json,provider_request_count=excluded.provider_request_count,updated_at=excluded.updated_at,
      provider_attempts=rca_group_jobs.provider_attempts + CASE WHEN excluded.status IN ('completed','insufficient_evidence') AND excluded.provider IN ('nvidia','ollama') THEN 1 ELSE 0 END,
      started_at=CASE WHEN excluded.status='running' THEN excluded.updated_at ELSE rca_group_jobs.started_at END,
      completed_at=CASE WHEN excluded.status IN ('completed','insufficient_evidence') THEN excluded.updated_at ELSE rca_group_jobs.completed_at END`)
      .run(groupId,`rca-job:${groupId}`,sessionId,status,0,result ? JSON.stringify(result) : null,evidenceHash,provider,model,error,result ? JSON.stringify(result.toolTrace ?? []) : null,result?.providerRequestCount ?? 0,0,now,now);
  }
  markRunningRcaJobsPending() { this.db.prepare("UPDATE rca_group_jobs SET status='pending', error='Recovered after process restart', updated_at=? WHERE status='running'").run(new Date().toISOString()); }
  rcaGroupResult(groupId: string): RcaResult | null { const row = this.rcaGroupJob(groupId); return row?.result_json ? JSON.parse(String(row.result_json)) as RcaResult : null; }
}
