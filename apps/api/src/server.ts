import "./config.js";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { loadDataset, isOrphan } from "./csv.js";
import { Store } from "./db.js";
import { EventBroker } from "./events.js";
import { RcaManager } from "./rca.js";
import { ReplayService } from "./replay.js";
import type { Role, Observation, ReplaySession } from "./types.js";
import { AuthService, type AuthUser } from "./auth.js";

const port = Number(process.env.PORT ?? 4000);
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const configuredPath = (value: string) => resolve(repoRoot, value);
const dbPath = process.env.DATABASE_PATH ? configuredPath(process.env.DATABASE_PATH) : resolve(repoRoot, "data/signalgrid.db");
const datasetPath = process.env.DATASET_PATH ? configuredPath(process.env.DATASET_PATH) : resolve(repoRoot, "data/raw/monitoring.csv");

declare global { namespace Express { interface Request { user?: AuthUser; authToken?: string } } }

function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2; }
function mode(values: string[]) { const counts = new Map<string, number>(); for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1); return [...counts.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] ?? null; }
function percentile(sorted: number[], fraction: number) { if (!sorted.length) return null; const index = (sorted.length - 1) * fraction; const lower = Math.floor(index); const upper = Math.ceil(index); return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower); }
function awsCostUsageQuality(observations: Observation[]) {
  const reportRatios = [...new Set(observations.map(row => row.reportId))].map(reportId => {
    const rows = observations.filter(row => row.reportId === reportId);
    const ratios = rows.filter(row => row.monthlyActiveViews > 0 && Number.isFinite(row.awsHostingCostUsd)).map(row => row.awsHostingCostUsd / row.monthlyActiveViews);
    return { reportId, medianAwsCostPerActiveViewUsd: median(ratios), medianActiveViews: median(rows.map(row => row.monthlyActiveViews)) };
  }).filter(row => row.medianAwsCostPerActiveViewUsd != null) as Array<{ reportId: string; medianAwsCostPerActiveViewUsd: number; medianActiveViews: number | null }>;
  const values = reportRatios.map(row => row.medianAwsCostPerActiveViewUsd).sort((a, b) => a - b);
  const q1 = percentile(values, 0.25); const q3 = percentile(values, 0.75); const iqr = q1 == null || q3 == null ? null : q3 - q1; const threshold = q3 == null || iqr == null ? null : q3 + (1.5 * iqr);
  const flaggedReports = threshold == null ? [] : reportRatios.filter(row => row.medianAwsCostPerActiveViewUsd > threshold).map(row => ({ ...row, reason: "report median AWS cost per active view exceeds Q3 + 1.5×IQR; review only" }));
  return { method: "Report-level median AWS hosting cost per active view; flag values above Q3 + 1.5×IQR across reports. Zero-view rows are excluded from ratios and no contractual AWS baseline is assumed.", reportCount: reportRatios.length, q1, q3, iqr, threshold, flaggedReports };
}
function reportSummary(reportId: string, observations: Observation[], incidents: ReturnType<Store["incidents"]>) {
  const rows = observations.filter(row => row.reportId === reportId);
  const owners = [...new Set(rows.map(row => row.ownerNormalized).filter(Boolean))];
  const statuses = rows.map(row => row.refreshStatus);
  const invalid = rows.filter(row => row.snowflakeCredits < 0).length;
  const views = rows.map(row => row.monthlyActiveViews);
  const credits = rows.filter(row => row.snowflakeCredits >= 0).map(row => row.snowflakeCredits);
  const latency = rows.map(row => row.avgLoadTimeSec);
  const aws = rows.map(row => row.awsHostingCostUsd);
  const sourceOwnerState = rows.some(row => isOrphan(row.ownerNormalized)) ? "missing_or_placeholder" : owners.length > 1 ? "conflicting_observations" : "observed_candidate";
  return {
    reportId, reportName: rows[0]?.reportName ?? reportId, observationCount: rows.length,
    owner: owners.length === 1 && rows.every(row => row.ownerNormalized) ? owners[0] : rows.some(row => isOrphan(row.ownerNormalized)) ? "ORPHANED / CONFLICTING" : "CONFLICTING OBSERVATIONS",
    ownerConflict: owners.length > 1, orphanedObservations: rows.filter(row => isOrphan(row.ownerNormalized)).length,
    refreshStatusMode: mode(statuses), refreshStatusCounts: statuses.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] ?? 0) + 1; return out; }, {}),
    medianActiveViews: median(views), medianCredits: median(credits), medianCreditsPerActiveView: median(rows.filter(row => row.snowflakeCredits >= 0 && row.monthlyActiveViews > 0).map(row => row.snowflakeCredits / row.monthlyActiveViews)), medianLatencySec: median(latency), maxLatencySec: Math.max(...latency), medianAwsCostUsd: median(aws.filter(Number.isFinite)), medianAwsCostPerActiveViewUsd: median(rows.filter(row => row.monthlyActiveViews > 0 && Number.isFinite(row.awsHostingCostUsd)).map(row => row.awsHostingCostUsd / row.monthlyActiveViews)),
    invalidCreditObservations: invalid, zeroViewObservations: rows.filter(row => row.monthlyActiveViews === 0).length,
    incidents: incidents.filter(incident => incident.reportId === reportId).length,
    methodology: "Report-level numeric values are medians across observations because repeated report IDs have no timestamp. Cost-per-view fields are medians of valid row-level ratios; they are not ratios of medians or monthly totals."
    , ownershipQuality: { sourceOwnerState, observedCandidates: owners, validOwnerObservationCount: rows.filter(row => Boolean(row.ownerNormalized)).length, missingOrPlaceholderObservationCount: rows.filter(row => isOrphan(row.ownerNormalized)).length, conflict: owners.length > 1, notVerifiedCurrentOwner: true }
  };
}

function buildInvestigationBrief(reportId: string, observations: Observation[], incidents: ReturnType<Store["incidents"]>) {
  const rows = observations.filter(row => row.reportId === reportId);
  const slow = rows.filter(row => row.avgLoadTimeSec > 15);
  const failed = rows.filter(row => row.refreshStatus === "FAILED");
  const timedOut = rows.filter(row => row.refreshStatus === "TIMED_OUT");
  const unknown = rows.filter(row => row.refreshStatus === "UNKNOWN");
  const orphaned = rows.filter(row => isOrphan(row.ownerNormalized));
  const negative = rows.filter(row => row.snowflakeCredits < 0);
  const zeroViews = rows.filter(row => row.monthlyActiveViews === 0);
  return {
    reportId,
    sourceObservationCount: rows.length,
    confirmedFindings: [
      slow.length ? `${slow.length} observation(s) exceeded the 15 second load-latency threshold.` : null,
      failed.length ? `${failed.length} observation(s) reported FAILED refresh.` : null,
      timedOut.length ? `${timedOut.length} observation(s) reported TIMED_OUT refresh.` : null,
      unknown.length ? `${unknown.length} observation(s) have an UNKNOWN refresh state.` : null,
      orphaned.length ? `${orphaned.length} observation(s) have missing or placeholder ownership.` : null,
      negative.length ? `${negative.length} observation(s) contain negative Snowflake credits and are excluded from Snowflake allocation.` : null,
      zeroViews.length ? `${zeroViews.length} observation(s) have zero active views; cost-per-view is null.` : null
    ].filter((value): value is string => Boolean(value)),
    measurements: { latencyThresholdSeconds: 15, slowObservations: slow.length, failedRefreshes: failed.length, timedOutRefreshes: timedOut.length, unknownRefreshes: unknown.length, missingOwnerObservations: orphaned.length, negativeCreditObservations: negative.length, zeroViewObservations: zeroViews.length },
    possibleCauses: ["QUERY_EXECUTION_DELAY", "ELEVATED_WORKLOAD_OR_CONCURRENCY", "APPLICATION_RENDERING_DELAY", "UNKNOWN_UNDERLYING_CAUSE"],
    recommendedChecks: ["INSPECT_QUERY_EXECUTION_PROFILE", "REVIEW_REPORT_REFRESH_LOGS", "COMPARE_APPLICATION_LATENCY_BREAKDOWN", "EXAMINE_WAREHOUSE_CONCURRENCY_METRICS", "VALIDATE_SOURCE_OWNERSHIP_INFORMATION"],
    missingEvidence: ["QUERY_EXECUTION_PROFILE", "WAREHOUSE_CONCURRENCY_METRICS", "APPLICATION_TRACE", "UPSTREAM_REFRESH_LOG"],
    sourceReferences: rows.map(row => row.id),
    relatedDetectionCount: incidents.filter(row => row.reportId === reportId).length,
    certainty: "Backend observations are confirmed; possible causes are policy-approved hypotheses and are not causal proof."
  };
}
function buildIncidentInvestigationBrief(store: Store, incident: ReturnType<Store["incident"]>) {
  if (!incident) return null;
  const observation = store.observation(incident.observationId);
  return { incidentId: incident.id, reportId: incident.reportId, rule: incident.ruleCode, threshold: incident.threshold, measuredValue: incident.observedMetric, sourceObservationId: incident.observationId, confirmedFinding: `The source observation triggered ${incident.ruleCode}.`, possibleCauses: ["QUERY_EXECUTION_DELAY", "ELEVATED_WORKLOAD_OR_CONCURRENCY", "APPLICATION_RENDERING_DELAY", "UNKNOWN_UNDERLYING_CAUSE"], recommendedChecks: ["INSPECT_QUERY_EXECUTION_PROFILE", "REVIEW_REPORT_REFRESH_LOGS"], missingEvidence: ["QUERY_EXECUTION_PROFILE", "APPLICATION_TRACE"], sourceReferences: [incident.observationId], observation: observation ? { avgLoadTimeSec: observation.avgLoadTimeSec, refreshStatus: observation.refreshStatus, ownerNormalized: observation.ownerNormalized, snowflakeCredits: observation.snowflakeCredits, monthlyActiveViews: observation.monthlyActiveViews } : null, certainty: "This is an evidence-backed detection, not proof of an underlying infrastructure root cause." };
}
function assignmentResponsibility(store: Store, reportId: string, user?: AuthUser) {
  return store.listAssignments().filter(row => row.reportId === reportId).filter(row => !user || effectiveRole(user) === "ADMIN" || row.username === user.username).map(row => ({ username: row.username, role: row.role, provenance: row.provenance, assignedAt: row.createdAt }));
}

function effectiveRole(user?: AuthUser): "ADMIN" | "OWNER" | "ANALYST" {
  if (user?.role === "ADMIN") return "ADMIN";
  if (user?.role === "ANALYST") return "ANALYST";
  return "OWNER";
}
function visibleReportIds(store: Store, user?: AuthUser): Set<string> | null {
  if (!user || effectiveRole(user) === "ADMIN") return null;
  return new Set(store.assignedReportIds(user.username));
}
function canSeeReport(store: Store, user: AuthUser | undefined, reportId: string) {
  const allowed = visibleReportIds(store, user); return allowed === null || allowed.has(reportId);
}
function sessionAccessible(session: ReplaySession | null, user?: AuthUser) {
  if (!session || !user) return false;
  if (effectiveRole(user) === "ADMIN") return true;
  // Private sessions belong to their creating principal. The only shared
  // session is the completed full analytical evaluation, which is projected
  // through report assignments before it reaches a restricted caller.
  return session.principalUsername === user.username || Boolean(session.sharedEvaluation && session.mode === "full" && session.state === "completed");
}
function accessibleSessionIds(store: Store, user?: AuthUser): Set<string> | null {
  if (!user || effectiveRole(user) === "ADMIN") return null;
  const ids = new Set(store.replaySessionsFor(user.username).map(session => session.id));
  const completed = store.latestCompletedFullReplay();
  if (completed) ids.add(completed.id);
  return ids;
}
function accessibleSession(store: Store, replay: ReplayService, requestedSessionId: string | undefined, user?: AuthUser) {
  if (requestedSessionId) return store.replaySession(requestedSessionId);
  if (!user || effectiveRole(user) === "ADMIN") return replay.status();
  return store.latestReplaySessionFor(user.username) ?? store.latestCompletedFullReplay();
}
function projectReplaySession(store: Store, session: ReplaySession | null, user?: AuthUser): ReplaySession | null {
  if (!session || !user || effectiveRole(user) === "ADMIN") return session;
  const allowed = visibleReportIds(store, user) ?? new Set<string>();
  const authorizedOrder = session.order.filter(id => { const observation = store.observation(id); return Boolean(observation && allowed.has(observation.reportId)); });
  const processedOrder = session.order.slice(0, Math.max(0, session.position)).filter(id => { const observation = store.observation(id); return Boolean(observation && allowed.has(observation.reportId)); });
  return { ...session, order: [], total: authorizedOrder.length, position: session.state === "completed" ? authorizedOrder.length : processedOrder.length, principalUsername: session.principalUsername === user.username ? user.username : null, principalRole: effectiveRole(user), scopeReportIds: [...allowed] };
}
function replayScope(store: Store, replay: ReplayService, requestedSessionId?: string, user?: AuthUser) {
  const session = accessibleSession(store, replay, requestedSessionId, user);
  if (!session) return { session: null, sessionId: undefined as string | undefined, observations: store.observations().filter(row => canSeeReport(store, user, row.reportId)) };
  if (!sessionAccessible(session, user)) return { session, sessionId: session.id, observations: [] as Observation[], forbidden: true };
  const ids = session.state === "completed" ? session.order : session.order.slice(0, Math.max(0, session.position));
  const observations = ids.map(id => store.observation(id)).filter((row): row is Observation => Boolean(row)).filter(row => canSeeReport(store, user, row.reportId));
  return { session, sessionId: session.id, observations };
}

function scopedIncidents(store: Store, sessionId?: string, user?: AuthUser) {
  const allowedSessions = accessibleSessionIds(store, user);
  const rows = sessionId ? store.incidents({ limit: 10000, sessionId }) : store.incidents({ limit: 10000 });
  return rows.filter(row => (!allowedSessions || allowedSessions.has(row.sessionId)) && canSeeReport(store, user, row.reportId));
}
function scopedGroups(store: Store, sessionId?: string, user?: AuthUser) {
  const allowedSessions = accessibleSessionIds(store, user);
  const rows = sessionId ? store.actionableIncidentGroups({ limit: 10000, sessionId }) : store.actionableIncidentGroups({ limit: 10000 });
  return rows.filter(row => (!allowedSessions || allowedSessions.has(String(row.session_id))) && canSeeReport(store, user, String(row.report_id)));
}
function scopedQuality(observations: Observation[]) {
  return [
    { code: "ORPHANED_OWNER", severity: "high", count: observations.filter(row => isOrphan(row.ownerNormalized)).length },
    { code: "NEGATIVE_CREDITS", severity: "high", count: observations.filter(row => row.snowflakeCredits < 0).length },
    { code: "UNKNOWN_REFRESH_STATUS", severity: "medium", count: observations.filter(row => row.refreshStatus === "UNKNOWN").length },
    { code: "ZERO_ACTIVE_VIEWS", severity: "medium", count: observations.filter(row => row.monthlyActiveViews === 0).length }
  ].filter(row => row.count > 0);
}
function scopedStats(store: Store, observations: Observation[], sessionId?: string, user?: AuthUser) {
  const incidents = scopedIncidents(store, sessionId, user); const groups = scopedGroups(store, sessionId, user);
  return { observations: observations.length, reports: new Set(observations.map(row => row.reportId)).size, incidents: incidents.length, groupedIncidents: groups.length, detections: sessionId ? store.detectionCount(sessionId) : 0, detectionEvents: sessionId ? store.detectionCount(sessionId) : 0, openIncidents: incidents.filter(row => row.status === "open").length, orphaned: observations.filter(row => isOrphan(row.ownerNormalized)).length, invalidCredits: observations.filter(row => row.snowflakeCredits < 0).length };
}

function authRequired(auth: AuthService, roles?: Role[]) { return (req: Request, res: Response, next: NextFunction) => {
  const header = req.header("authorization") ?? ""; const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const user = auth.authorizeBearer(token);
  if (!user) return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
  const canonicalRole = effectiveRole(user);
  if (roles && !roles.some(role => (role === "VIEWER" ? "OWNER" : role) === canonicalRole)) return res.status(403).json({ error: "Insufficient permission", code: "FORBIDDEN" });
  req.user = { ...user, role: canonicalRole }; req.authToken = token; return next();
}; }

export function createApp(options: { dbPath?: string; datasetPath?: string; autoRca?: boolean } = {}) {
  const store = new Store(options.dbPath ?? dbPath);
  const broker = new EventBroker(store);
  const rca = new RcaManager(store, broker);
  // Hosted providers are never invoked as an implicit side effect of replay.
  // Deterministic RCA remains enabled by default for the local demo. The
  // autoRca option can disable deterministic replay RCA for tests, but it
  // cannot opt hosted providers into automatic work; hosted RCA is always
  // requested through the authorized incident action.
  const requestedProvider = String(process.env.RCA_PROVIDER ?? "deterministic").toLowerCase();
  const hostedProvider = ["nvidia", "ollama"].includes(requestedProvider);
  const replayAutoRca = hostedProvider ? false : options.autoRca ?? true;
  const replay = new ReplayService(store, broker, rca, replayAutoRca);
  const auth = new AuthService();
  const source = options.datasetPath ?? datasetPath;
  if (!existsSync(source)) throw new Error(`Dataset not found: ${source}`);
  const dataset = loadDataset(source);
  const existingImport = store.latestImportSha();
  if (store.observationCount() > 0 && existingImport !== dataset.sha256) {
    throw new Error(`Dataset source changed or lacks provenance for this database (stored ${existingImport ?? "none"}, received ${dataset.sha256}); use a new DATABASE_PATH for a different source.`);
  }
  store.seedObservations(dataset.observations, source, dataset.sha256, dataset.errors);
  store.seedAssignments(store.reports().map(row => String(row.reportId)));

  const app = express();
  app.use(cors({ origin: process.env.WEB_ORIGIN ? process.env.WEB_ORIGIN.split(",").map(value => value.trim()) : "http://localhost:5173" }));
  app.use(express.json({ limit: "1mb" }));

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const loginRateLimit = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now(); const key = req.ip || "unknown"; const current = loginAttempts.get(key);
    const windowState = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    windowState.count += 1; loginAttempts.set(key, windowState);
    if (windowState.count > 20) return res.status(429).json({ error: "Too many sign-in attempts. Try again later.", code: "AUTH_RATE_LIMITED" });
    return next();
  };

  app.get("/health", (_req, res) => res.json({ ok: true, service: "signalgrid-api", time: new Date().toISOString(), ai: ["ollama", "nvidia"].includes(String(process.env.RCA_PROVIDER).toLowerCase()) ? "optional" : "deterministic" }));
  app.get("/api/auth/config", (_req, res) => res.json({ demoAuthEnabled: auth.isDemoAuthEnabled() }));
  app.post("/api/auth/login", loginRateLimit, (req, res) => {
    const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(401).json({ error: "Invalid credentials" });
    const result = auth.login(parsed.data.username, parsed.data.password);
    if (!result) return res.status(401).json({ error: "Invalid credentials" });
    return res.json(result);
  });
  app.get("/api/auth/me", authRequired(auth), (req, res) => res.json({ user: req.user }));
  app.post("/api/auth/logout", authRequired(auth), (req, res) => { auth.revoke(req.authToken); broker.closeUnauthorized(); return res.json({ ok: true }); });
  app.post("/api/events/ticket", authRequired(auth), (req, res) => res.json(auth.issueSseTicket(req.user!, req.authToken)));
  app.get("/api/demo/readiness", authRequired(auth), (_req, res) => {
    const active = replay.status();
    const requestedProvider = String(process.env.RCA_PROVIDER ?? "deterministic").toLowerCase();
    const providerConfigured = requestedProvider === "nvidia" ? Boolean(process.env.NVIDIA_KEY?.trim()) : requestedProvider === "ollama";
    const latestHosted = requestedProvider === "nvidia" || requestedProvider === "ollama" ? store.latestHostedRca(requestedProvider) : undefined;
    let latestResult: Record<string, unknown> | null = null;
    try { latestResult = latestHosted?.result_json ? JSON.parse(String(latestHosted.result_json)) as Record<string, unknown> : null; } catch { latestResult = null; }
    const lastOutcome = latestResult?.validationOutcome ? String(latestResult.validationOutcome) : latestHosted?.status ? String(latestHosted.status) : null;
    const providerReachable = Boolean(latestHosted && latestHosted.status !== "pending" && latestHosted.status !== "running" && latestHosted.error == null && latestResult?.provider === requestedProvider);
    return res.json({
      ready: true,
      simulated: true,
      noAutoplay: true,
      backend: { healthy: true, service: "signalgrid-api" },
      dataset: { loaded: true, observations: dataset.observations.length, reports: new Set(dataset.observations.map(row => row.reportId)).size, sha256: dataset.sha256, parseErrors: dataset.errors.length },
      replay: { ready: true, activeSessionId: active?.id ?? null, state: active?.state ?? null, canStart: !active || active.state !== "running" },
      rca: { requestedProvider, providerConfigured, providerReachable, lastVerifiedSuccess: providerReachable && latestResult?.generatedBy === "ai" && latestResult?.validationOutcome === "verified", lastCompletedOutcome: lastOutcome, lastCompletedAt: latestHosted?.completed_at ?? null, deterministicFallbackAvailable: true, model: requestedProvider === "nvidia" ? (process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b") : requestedProvider === "ollama" ? (process.env.OLLAMA_MODEL ?? "qwen2.5:7b") : null },
      access: { role: effectiveRole(_req.user), assignedReports: effectiveRole(_req.user) === "ADMIN" ? null : store.assignedReportIds(_req.user!.username), canControlReplay: effectiveRole(_req.user) === "ADMIN", canAcknowledge: ["ADMIN", "OWNER"].includes(effectiveRole(_req.user)) }
    });
  });
  app.get("/api/assignments", authRequired(auth), (req, res) => {
    const role = effectiveRole(req.user);
    if (role !== "ADMIN") return res.json({ data: store.assignmentsFor(req.user!.username), audit: [] });
    return res.json({ data: store.listAssignments(), audit: store.assignmentAudit() });
  });
  app.post("/api/assignments", authRequired(auth, ["ADMIN"]), (req, res) => {
    const parsed = z.object({ username: z.string().min(1), reportId: z.string().min(1), role: z.enum(["OWNER", "ANALYST"]), provenance: z.string().max(160).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "username, reportId and role are required" });
    try { return res.status(201).json({ assignment: store.setAssignment({ ...parsed.data, actor: req.user!.username }) }); } catch (error) { return res.status(404).json({ error: error instanceof Error ? error.message : "Report not found" }); }
  });
  app.delete("/api/assignments/:username/:reportId", authRequired(auth, ["ADMIN"]), (req, res) => res.json({ removed: store.removeAssignment(String(req.params.username), String(req.params.reportId), req.user!.username) }));
  app.get("/api/overview", authRequired(auth), (req, res) => {
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const observations = scope.observations; const incidents = scopedIncidents(store, scope.sessionId, req.user); const stats = scopedStats(store, observations, scope.sessionId, req.user);
    const validCredits = observations.filter(row => row.snowflakeCredits >= 0).map(row => row.snowflakeCredits);
    res.json({ ...stats, medianLoadTimeSec: median(observations.map(row => row.avgLoadTimeSec)), slowObservations: observations.filter(row => row.avgLoadTimeSec > 15).length, failedRefreshes: observations.filter(row => row.refreshStatus === "FAILED").length, timedOutRefreshes: observations.filter(row => row.refreshStatus === "TIMED_OUT").length, unknownRefreshes: observations.filter(row => row.refreshStatus === "UNKNOWN").length, medianCredits: median(validCredits), recentIncidents: incidents.slice(0, 12), quality: scopedQuality(observations), replay: scope.session ? { sessionId: scope.session.id, mode: scope.session.mode, state: scope.session.state, position: scope.session.state === "completed" ? scope.session.total : scope.session.position, total: scope.session.total, percent: scope.session.total ? Math.round(((scope.session.state === "completed" ? scope.session.total : scope.session.position) / scope.session.total) * 1000) / 10 : 0 } : null, provenance: { source: source, sha256: dataset.sha256, observations: dataset.observations.length, processedObservations: observations.length, errors: dataset.errors.length, timestampSemantics: "No source timestamp is available; repeated rows are observations, not chronology." } });
  });
  app.get("/api/analytics", authRequired(auth), (req, res) => {
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const observations = scope.observations; const scoped = scopedIncidents(store, scope.sessionId, req.user);
    const reports = [...new Set(observations.map(row => row.reportId))].map(reportId => reportSummary(reportId, observations, scoped));
    const latencyDistribution = [
      { bucket: "Under 5s", count: observations.filter(row => row.avgLoadTimeSec < 5).length },
      { bucket: "5–15s", count: observations.filter(row => row.avgLoadTimeSec >= 5 && row.avgLoadTimeSec <= 15).length },
      { bucket: "15–30s", count: observations.filter(row => row.avgLoadTimeSec > 15 && row.avgLoadTimeSec < 30).length },
      { bucket: "30s+", count: observations.filter(row => row.avgLoadTimeSec >= 30).length }
    ];
    const refreshHealth = ["SUCCESS", "FAILED", "TIMED_OUT", "UNKNOWN"].map(status => ({ status, count: observations.filter(row => row.refreshStatus === status).length }));
    const uniqueReports = (predicate: (rows: Observation[]) => boolean) => [...new Set(observations.map(row => row.reportId))].filter(reportId => predicate(observations.filter(row => row.reportId === reportId))).length;
    const allowedSessions = accessibleSessionIds(store, req.user);
    const replayEvents = store.recentEvents(200).map(event => ({ type: String(event.event_type), timestamp: String(event.created_at), payload: JSON.parse(String(event.payload_json)) })).filter(event => { const p = event.payload as Record<string, unknown>; const incidentPayload = p.incident && typeof p.incident === "object" ? p.incident as Record<string, unknown> : undefined; const reportId = typeof p.reportId === "string" ? p.reportId : typeof incidentPayload?.reportId === "string" ? incidentPayload.reportId : undefined; const eventSessionId = typeof p.sessionId === "string" ? p.sessionId : typeof incidentPayload?.sessionId === "string" ? incidentPayload.sessionId : undefined; return (!scope.sessionId || eventSessionId === scope.sessionId) && Boolean(reportId && eventSessionId && canSeeReport(store, req.user, reportId) && (!allowedSessions || allowedSessions.has(eventSessionId))); });
    res.json({ latencyDistribution, refreshHealth, topLatencyReports: reports.filter(row => row.maxLatencySec > 15).sort((a, b) => b.maxLatencySec - a.maxLatencySec).slice(0, 8), findingsByCategory: [{ category: "Slow Loads", count: uniqueReports(rows => rows.some(row => row.avgLoadTimeSec > 15)) }, { category: "Refresh Issues", count: uniqueReports(rows => rows.some(row => ["FAILED", "TIMED_OUT", "UNKNOWN"].includes(row.refreshStatus))) }, { category: "Missing Owners", count: uniqueReports(rows => rows.some(row => isOrphan(row.ownerNormalized))) }, { category: "Invalid Credits", count: uniqueReports(rows => rows.some(row => row.snowflakeCredits < 0)) }], replay: scope.session ? { sessionId: scope.session.id, state: scope.session.state, position: scope.session.state === "completed" ? scope.session.total : scope.session.position, total: scope.session.total } : null, replayEvents });
  });
  app.get("/api/reports", authRequired(auth), (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25))); const search = String(req.query.search ?? "").toLowerCase(); const onlyOrphaned = req.query.orphaned === "true"; const ownerFilter = String(req.query.owner ?? "all"); const latencyFilter = String(req.query.latency ?? "all"); const refreshFilter = String(req.query.refresh ?? "all");
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const observations = scope.observations; const incidents = scopedIncidents(store, scope.sessionId, req.user); const ids = [...new Set(observations.map(row => row.reportId))];
    let summaries = ids.map(id => ({ ...reportSummary(id, observations, incidents), assignmentResponsibility: assignmentResponsibility(store, id, req.user) }));
    if (search) summaries = summaries.filter(row => `${row.reportId} ${row.reportName} ${row.owner}`.toLowerCase().includes(search));
    if (onlyOrphaned) summaries = summaries.filter(row => row.orphanedObservations > 0);
    if (ownerFilter === "missing") summaries = summaries.filter(row => row.orphanedObservations > 0);
    if (ownerFilter === "assigned") summaries = summaries.filter(row => row.orphanedObservations === 0 && !row.ownerConflict);
    if (ownerFilter === "conflicting") summaries = summaries.filter(row => row.ownerConflict);
    if (latencyFilter === "slow") summaries = summaries.filter(row => row.maxLatencySec > 15);
    if (latencyFilter === "healthy") summaries = summaries.filter(row => row.maxLatencySec <= 15);
    if (latencyFilter === "critical") summaries = summaries.filter(row => row.maxLatencySec >= 30);
    if (refreshFilter !== "all") summaries = summaries.filter(row => Number(row.refreshStatusCounts?.[refreshFilter] ?? 0) > 0);
    const total = summaries.length; res.json({ data: summaries.slice((page-1)*pageSize, page*pageSize), page, pageSize, total });
  });
  app.get("/api/reports/:reportId", authRequired(auth), (req, res) => {
    const reportId = String(req.params.reportId); if (!canSeeReport(store, req.user, reportId)) return res.status(404).json({ error: "Report not found" }); const scope = replayScope(store, replay, undefined, req.user); const observations = scope.observations.filter(row => row.reportId === reportId); if (!observations.length) return res.status(404).json({ error: "Report not found" });
    const incidents = scopedIncidents(store, scope.sessionId, req.user).filter(row => row.reportId === reportId); res.json({ ...reportSummary(reportId, scope.observations, incidents), assignmentResponsibility: assignmentResponsibility(store, reportId, req.user), observations, incidents, investigationBrief: buildInvestigationBrief(reportId, observations, incidents) });
  });
  app.get("/api/reports/:reportId/ownership", authRequired(auth), (req, res) => { const reportId = String(req.params.reportId); if (!canSeeReport(store, req.user, reportId)) return res.status(404).json({ error: "Report not found" }); const scope = replayScope(store, replay, undefined, req.user); const rows = scope.observations.filter(row => row.reportId === reportId); if (!rows.length) return res.status(404).json({ error: "Report not found" }); const candidates = [...new Set(rows.map(row => row.ownerNormalized).filter(Boolean))]; return res.json({ reportId, observedOwnerCandidates: candidates, validOwnerObservationCount: rows.filter(row => Boolean(row.ownerNormalized)).length, missingOrPlaceholderObservationCount: rows.filter(row => isOrphan(row.ownerNormalized)).length, conflict: candidates.length > 1, notVerifiedCurrentOwner: true, assignmentResponsibility: assignmentResponsibility(store, reportId, req.user) }); });
  app.get("/api/reports/:reportId/investigation-brief", authRequired(auth), (req, res) => { const reportId = String(req.params.reportId); if (!canSeeReport(store, req.user, reportId)) return res.status(404).json({ error: "Report not found" }); const scope = replayScope(store, replay, undefined, req.user); const rows = scope.observations.filter(row => row.reportId === reportId); if (!rows.length) return res.status(404).json({ error: "Report not found" }); return res.json(buildInvestigationBrief(reportId, rows, scopedIncidents(store, scope.sessionId, req.user))); });
  app.get("/api/data-quality", authRequired(auth), (req, res) => { const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const ids = new Set(scope.observations.map(row => row.id)); res.json({ summary: scopedQuality(scope.observations), findings: store.qualityFindings(Number(req.query.limit ?? 200)).filter(row => ids.has(String(row.observation_id))), costUsageQuality: awsCostUsageQuality(scope.observations) }); });
  app.get("/api/incidents", authRequired(auth), (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1)); const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 8)));
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const allowedSessions = accessibleSessionIds(store, req.user); const groups = store.actionableIncidentGroups({ limit: 10000, severity: req.query.severity ? String(req.query.severity) : undefined, status: req.query.status ? String(req.query.status) : undefined, ruleCode: req.query.rule ? String(req.query.rule) : undefined, investigationStatus: req.query.investigation ? String(req.query.investigation) : undefined, search: req.query.search ? String(req.query.search) : undefined, sessionId: scope.sessionId }).filter(group => (!allowedSessions || allowedSessions.has(String(group.session_id))) && canSeeReport(store, req.user, String(group.report_id)));
    const data = groups.slice((page - 1) * pageSize, page * pageSize).map(group => ({ id: String(group.id), groupId: String(group.id), sessionId: String(group.session_id), reportId: String(group.report_id), ruleCode: String(group.rule_code), severity: String(group.severity), occurrenceCount: Number(group.occurrence_count), evidenceCount: Number(group.evidence_count), firstDetected: String(group.first_detected), lastDetected: String(group.last_detected), status: String(group.status), investigationStatus: String(group.investigation_status), rca: group.rca_result_json ? JSON.parse(String(group.rca_result_json)) : null, rcaJob: { status: String(group.rca_status), error: group.rca_error ? String(group.rca_error) : null } }));
    res.json({ data, page, pageSize, total: groups.length });
  });
  app.get("/api/incidents/occurrences", authRequired(auth), (req, res) => {
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const incidents = store.incidents({ limit: Number(req.query.limit ?? 100), severity: req.query.severity ? String(req.query.severity) : undefined, status: req.query.status ? String(req.query.status) : undefined, search: req.query.search ? String(req.query.search) : undefined, sessionId: scope.sessionId }).filter(row => canSeeReport(store, req.user, row.reportId));
    res.json({ data: incidents.map(incident => ({ ...incident, evidence: JSON.parse(incident.evidenceJson), rca: incident.groupId ? store.rcaGroupResult(incident.groupId) : null, rcaJob: incident.groupId ? store.rcaGroupJob(incident.groupId) : null })) });
  });
  app.get("/api/incidents/:id", authRequired(auth), (req, res) => { const incident = store.incident(Number(req.params.id)); const incidentSession = incident ? store.replaySession(incident.sessionId) : null; if (!incident || !canSeeReport(store, req.user, incident.reportId) || !sessionAccessible(incidentSession, req.user)) return res.status(404).json({ error: "Incident not found" }); return res.json({ ...incident, evidence: JSON.parse(incident.evidenceJson), observation: store.observation(incident.observationId), rca: incident.groupId ? store.rcaGroupResult(incident.groupId) : null, rcaJob: incident.groupId ? store.rcaGroupJob(incident.groupId) : null, investigationBrief: buildIncidentInvestigationBrief(store, incident) }); });
  app.post("/api/incidents/:id/acknowledge", authRequired(auth, ["ADMIN", "OWNER"]), (req, res) => {
    const rawId = String(req.params.id); const numericId = Number(rawId); const incident = Number.isInteger(numericId) && numericId > 0 ? store.incident(numericId) : null;
    if (incident && (!canSeeReport(store, req.user, incident.reportId) || !sessionAccessible(store.replaySession(incident.sessionId), req.user))) return res.status(404).json({ error: "Incident not found" });
    if (incident) { if (incident.groupId) store.acknowledgeGroup(incident.groupId); else store.acknowledge(incident.id); broker.publish("incident.acknowledged", { incidentId: incident.id, groupId: incident.groupId, by: req.user?.username }); return res.json({ ok: true, incident: store.incident(incident.id) }); }
    const group = store.incidentGroup(rawId); if (!group) return res.status(404).json({ error: "Incident group not found" }); if (!canSeeReport(store, req.user, String(group.report_id)) || !sessionAccessible(store.replaySession(String(group.session_id)), req.user)) return res.status(404).json({ error: "Incident group not found" });
    store.acknowledgeGroup(rawId); broker.publish("incident.acknowledged", { groupId: rawId, by: req.user?.username }); return res.json({ ok: true, groupId: rawId });
  });
  app.get("/api/costs", authRequired(auth), (req, res) => {
    const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const observations = scope.observations; const incidents = scopedIncidents(store, scope.sessionId, req.user); const valid = observations.filter(row => row.snowflakeCredits >= 0); const perView = valid.filter(row => row.monthlyActiveViews > 0).map(row => row.snowflakeCredits / row.monthlyActiveViews); const awsValid = observations.filter(row => row.monthlyActiveViews > 0 && Number.isFinite(row.awsHostingCostUsd)); const awsPerView = awsValid.map(row => row.awsHostingCostUsd / row.monthlyActiveViews);
    const safeRow = (row: Observation) => ({ id: row.id, sourceRowId: (row as Observation & { sourceRowId?: string }).sourceRowId ?? row.id, reportId: row.reportId, reportName: row.reportName, snowflakeCredits: row.snowflakeCredits, monthlyActiveViews: row.monthlyActiveViews, awsHostingCostUsd: row.awsHostingCostUsd, avgLoadTimeSec: row.avgLoadTimeSec, refreshStatus: row.refreshStatus, groupId: incidents.find(incident => incident.reportId === row.reportId && incident.ruleCode === "NEGATIVE_CREDITS")?.groupId ?? null });
    const summaries = [...new Set(observations.map(row => row.reportId))].map(reportId => reportSummary(reportId, observations, incidents));
    res.json({ methodology: "Each source row is an observation. Negative credits are excluded only from Snowflake-credit calculations; AWS hosting costs are validated independently. Zero views yield null cost per view. Report-level cost-per-view values are the median of valid row-level ratios (not a ratio of medians); repeated rows are never summed.", observationCount: observations.length, validCreditObservations: valid.length, invalidCreditObservations: observations.length-valid.length, validAwsHostingCostObservations: observations.filter(row => Number.isFinite(row.awsHostingCostUsd)).length, zeroViewObservations: observations.filter(row => row.monthlyActiveViews === 0).length, invalidCreditRows: observations.filter(row => row.snowflakeCredits < 0).map(safeRow), zeroViewRows: observations.filter(row => row.monthlyActiveViews === 0).map(safeRow), medianCredits: median(valid.map(row => row.snowflakeCredits)), medianCreditsPerActiveView: median(perView), medianAwsCostUsd: median(observations.filter(row => Number.isFinite(row.awsHostingCostUsd)).map(row => row.awsHostingCostUsd)), medianAwsCostPerActiveViewUsd: median(awsPerView), replay: scope.session ? { sessionId: scope.session.id, state: scope.session.state, position: scope.session.state === "completed" ? scope.session.total : scope.session.position, total: scope.session.total } : null, costUsageQuality: awsCostUsageQuality(observations), topReports: [...summaries].sort((a,b) => (b.medianCreditsPerActiveView ?? -1) - (a.medianCreditsPerActiveView ?? -1)).slice(0,10), topAwsReports: [...summaries].sort((a,b) => (b.medianAwsCostPerActiveViewUsd ?? -1) - (a.medianAwsCostPerActiveViewUsd ?? -1)).slice(0,10) });
  });
  app.get("/api/events", (req, res) => {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
    const authorization = auth.authorizeSseTicketDetails(ticket);
    const user = authorization?.user;
    if (!authorization || !user) return res.status(401).json({ error: "Valid SSE ticket required", code: "SSE_TICKET_REQUIRED" });
    const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    if (requestedSessionId && !sessionAccessible(store.replaySession(requestedSessionId), user)) return res.status(403).json({ error: "Replay session is not authorized for this user", code: "FORBIDDEN" });
    const authorizedSessionId = requestedSessionId;
    const allowed = visibleReportIds(store, user);
    const eventAllowed = (payload: unknown) => { if (effectiveRole(user) === "ADMIN") return true; if (!payload || typeof payload !== "object") return false; const p = payload as Record<string, unknown>; const incidentPayload = p.incident && typeof p.incident === "object" ? p.incident as Record<string, unknown> : undefined; const reportId = typeof p.reportId === "string" ? p.reportId : typeof incidentPayload?.reportId === "string" ? incidentPayload.reportId : undefined; const eventSessionId = typeof p.sessionId === "string" ? p.sessionId : typeof incidentPayload?.sessionId === "string" ? incidentPayload.sessionId : undefined; const shared = store.latestCompletedFullReplay()?.id; const owned = store.replaySessionsFor(user.username).some(session => session.id === eventSessionId); return Boolean(reportId && eventSessionId && allowed?.has(reportId) && (owned || eventSessionId === shared)); };
    req.user = user; return broker.subscribe(res, Number(req.header("last-event-id") ?? req.query.lastEventId ?? 0), authorizedSessionId, authorization.sessionToken ? () => Boolean(auth.authorizeBearer(authorization.sessionToken)) : undefined, eventAllowed);
  });
  app.get("/api/replay/status", authRequired(auth), (req, res) => {
    const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const session = accessibleSession(store, replay, requestedSessionId, req.user);
    if (requestedSessionId && (!session || !sessionAccessible(session, req.user))) return res.status(403).json({ error: "Replay session is not authorized for this user", code: "FORBIDDEN" });
    return res.json({ session: projectReplaySession(store, session, req.user), simulated: true, source, access: { role: effectiveRole(req.user), assignedReports: effectiveRole(req.user) === "ADMIN" ? null : store.assignedReportIds(req.user!.username) } });
  });
  app.post("/api/replay/scoped/config", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { try { const user = req.user!; const reportIds = store.assignedReportIds(user.username); const session = replay.configure({ mode: req.body?.mode ?? "curated", seed: req.body?.seed ?? 42, speed: req.body?.speed ?? 1, ordering: req.body?.ordering ?? "sequential", principalUsername: user.username, principalRole: effectiveRole(user), scopeReportIds: reportIds }); return res.json({ session, scope: { principal: user.username, role: effectiveRole(user), reportCount: reportIds.length }, simulated: true }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/scoped/start", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { try { const session = store.replaySession(String(req.body?.sessionId ?? "")); if (!session || session.principalUsername !== req.user!.username) return res.status(404).json({ error: "Replay session not found" }); return res.json({ session: replay.start(session.id) }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/scoped/pause", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { const session = store.replaySession(String(req.body?.sessionId ?? "")); if (!session || session.principalUsername !== req.user!.username) return res.status(404).json({ error: "Replay session not found" }); return res.json({ session: replay.pause(session.id) }); });
  app.post("/api/replay/scoped/resume", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { const session = store.replaySession(String(req.body?.sessionId ?? "")); if (!session || session.principalUsername !== req.user!.username) return res.status(404).json({ error: "Replay session not found" }); try { return res.json({ session: replay.start(session.id) }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/scoped/step", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { const session = store.replaySession(String(req.body?.sessionId ?? "")); if (!session || session.principalUsername !== req.user!.username) return res.status(404).json({ error: "Replay session not found" }); try { return res.json({ session: replay.step(session.id) }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/replay/scoped/status", authRequired(auth, ["OWNER", "ANALYST"]), (req, res) => { const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : ""; const session = store.replaySession(sessionId); if (!session || session.principalUsername !== req.user!.username) return res.status(404).json({ error: "Replay session not found" }); return res.json({ session: projectReplaySession(store, session, req.user), simulated: true }); });
  app.post("/api/replay/evaluate", authRequired(auth, ["ADMIN"]), (_req, res) => { try { const session = replay.ensureCompletedEvaluation(42); return res.json({ session, completedEvaluation: true, source, simulated: true }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/config", authRequired(auth, ["ADMIN"]), (req, res) => { try { return res.json({ session: replay.configure(req.body ?? {}), simulated: true }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/start", authRequired(auth, ["ADMIN"]), (_req, res) => { try { return res.json({ session: replay.start() }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/pause", authRequired(auth, ["ADMIN"]), (_req, res) => res.json({ session: replay.pause() }));
  app.post("/api/replay/resume", authRequired(auth, ["ADMIN"]), (_req, res) => { try { return res.json({ session: replay.resume() }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/reset", authRequired(auth, ["ADMIN"]), (_req, res) => res.json({ session: replay.reset(), sourceDataPreserved: true }));
  app.post("/api/replay/restart", authRequired(auth, ["ADMIN"]), (req, res) => { try { return res.json({ session: replay.restart(req.body?.start !== false), sourceDataPreserved: true, freshSession: true }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/replay/step", authRequired(auth, ["ADMIN"]), (req, res) => { try { return res.json({ session: replay.step() }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/demo/prepare", authRequired(auth, ["ADMIN"]), (req, res) => { try { return res.json(replay.prepareDemo({ seed: req.body?.seed, speed: req.body?.speed ?? 1 })); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/demo/start", authRequired(auth, ["ADMIN"]), (req, res) => { const parsed = z.object({ sessionId: z.string().min(1), cursor: z.number().int().nonnegative() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "sessionId and integer cursor are required" }); try { return res.json({ session: replay.startDemo(parsed.data.sessionId, parsed.data.cursor), simulated: true }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/demo/restart", authRequired(auth, ["ADMIN"]), (req, res) => { try { return res.json(replay.prepareDemo({ seed: req.body?.seed ?? 42, speed: req.body?.speed ?? 1 })); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/detection-events", authRequired(auth), (req, res) => { const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const events = store.detectionEvents({ limit: Number(req.query.limit ?? 200), sessionId: scope.sessionId }).filter(row => canSeeReport(store, req.user, String(row.report_id))); return res.json({ data: events, count: events.length }); });
  app.get("/api/notifications", authRequired(auth), (req, res) => { const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const relevant = new Set(["incident.detected", "incident.updated", "rca.queued", "rca.running", "rca.completed", "rca.fallback", "replay.started", "replay.completed", "replay.restarted"]); const events = store.recentEvents(Number(req.query.limit ?? 60)).map(event => ({ id: Number(event.id), type: String(event.event_type), timestamp: String(event.created_at), payload: JSON.parse(String(event.payload_json)) })).filter(event => relevant.has(event.type)).filter(event => { const p = event.payload as Record<string, unknown>; const incidentPayload = p.incident && typeof p.incident === "object" ? p.incident as Record<string, unknown> : undefined; const reportId = typeof p.reportId === "string" ? p.reportId : typeof incidentPayload?.reportId === "string" ? incidentPayload.reportId : ""; const eventSessionId = typeof p.sessionId === "string" ? p.sessionId : typeof incidentPayload?.sessionId === "string" ? incidentPayload.sessionId : ""; const session = eventSessionId ? store.replaySession(eventSessionId) : null; return (!scope.sessionId || eventSessionId === scope.sessionId) && Boolean(reportId && eventSessionId && canSeeReport(store, req.user, reportId) && sessionAccessible(session, req.user)); }); return res.json({ data: events }); });
  app.get("/api/incident-groups", authRequired(auth), (req, res) => { const scope = replayScope(store, replay, undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const groups = scopedGroups(store, scope.sessionId, req.user); return res.json({ data: groups }); });
  app.get("/api/incident-groups/:groupId", authRequired(auth), (req, res) => { const groupId = String(req.params.groupId); const group = store.incidentGroup(groupId); const groupSession = group ? store.replaySession(String(group.session_id)) : null; if (!group || !canSeeReport(store, req.user, String(group?.report_id ?? "")) || !sessionAccessible(groupSession, req.user)) return res.status(404).json({ error: "Incident group not found" }); if (req.query.sessionId && String(group.session_id) !== String(req.query.sessionId)) return res.status(403).json({ error: "Incident group is outside the requested replay session" }); return res.json({ group, members: store.groupMembers(groupId).filter(member => canSeeReport(store, req.user, String(member.report_id))).map(member => ({ ...store.mapIncident(member), evidence: JSON.parse(String(member.evidence_json)), observation: store.observation(String(member.observation_id)), detectionEventId: member.detection_event_id == null ? null : Number(member.detection_event_id) })), rca: store.rcaGroupResult(groupId), rcaJob: store.rcaGroupJob(groupId), investigationBrief: buildIncidentInvestigationBrief(store, store.incident(Number(store.groupMembers(groupId)[0]?.id ?? 0))) }); });
  app.post("/api/incident-groups/:groupId/rca", authRequired(auth), (req, res) => { const groupId = String(req.params.groupId); const group = store.incidentGroup(groupId); const groupSession = group ? store.replaySession(String(group.session_id)) : null; if (!group || !canSeeReport(store, req.user, String(group?.report_id ?? "")) || !sessionAccessible(groupSession, req.user)) return res.status(404).json({ error: "Incident group not found" }); if (req.query.sessionId && String(group.session_id) !== String(req.query.sessionId)) return res.status(403).json({ error: "Incident group is outside the requested replay session" }); rca.enqueueGroup(groupId); const job = store.rcaGroupJob(groupId); return res.status(202).json({ ok: true, groupId, reportId: String(group.report_id), sessionId: String(group.session_id), jobId: job?.job_id ?? `rca-job:${groupId}`, status: job?.status ?? "pending", evidenceHash: job?.evidence_hash ? String(job.evidence_hash) : null, requestedBy: req.user?.username ?? "user" }); });
  app.get("/api/incident-groups/:groupId/investigation-brief", authRequired(auth), (req, res) => { const group = store.incidentGroup(String(req.params.groupId)); const groupSession = group ? store.replaySession(String(group.session_id)) : null; if (!group || !canSeeReport(store, req.user, String(group?.report_id ?? "")) || !sessionAccessible(groupSession, req.user)) return res.status(404).json({ error: "Incident group not found" }); const member = store.groupMembers(String(req.params.groupId))[0]; const incident = member ? store.mapIncident(member) : null; if (!incident) return res.status(404).json({ error: "Incident group not found" }); return res.json(buildIncidentInvestigationBrief(store, incident)); });
  app.get("/api/incident-stats", authRequired(auth), (req, res) => { const scope = replayScope(store, replay, typeof req.query.sessionId === "string" ? req.query.sessionId : undefined, req.user); if (scope.forbidden) return res.status(403).json({ error: "Replay session is outside your assigned scope", code: "FORBIDDEN" }); const groups = scopedGroups(store, scope.sessionId, req.user); return res.json({ ...scopedStats(store, scope.observations, scope.sessionId, req.user), groups }); });
  // Backward-compatible curated demonstration shortcut.
  app.post("/api/replay", authRequired(auth, ["ADMIN"]), (req, res) => { try { const session = replay.configure({ mode: req.body?.mode ?? "curated", seed: req.body?.seed ?? 42, speed: req.body?.speed ?? 1, ordering: req.body?.ordering ?? "sequential" }); return res.json({ session: replay.start(), source, simulation: true, message: "Replay timestamps are simulation timestamps, not source history." }); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); } });
  const webDist = resolve(repoRoot, "apps/web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => { if (req.path.startsWith("/api/") || req.path === "/health") return next(); const index = resolve(webDist, "index.html"); return existsSync(index) ? res.sendFile(index) : next(); });
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ error: "Internal server error" }); });
  return { app, store, broker, rca, replay, dataset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app } = createApp(); app.listen(port, () => console.log(`SignalGrid API listening on http://localhost:${port}`));
}
