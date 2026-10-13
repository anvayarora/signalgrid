/*
 * Controlled, opt-in end-to-end RCA verification.
 * Run only with RUN_LIVE_NVIDIA=1 and an explicitly selected private env file.
 * The script prints metadata only; it never prints keys, raw evidence, or model text.
 */
if (process.env.RUN_LIVE_NVIDIA !== "1") {
  console.error("Set RUN_LIVE_NVIDIA=1 to run the controlled hosted RCA check.");
  process.exitCode = 2;
} else {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { createApp } = await import("../apps/api/src/server.ts");
  const dir = mkdtempSync(`${tmpdir()}/signalgrid-live-rca-`);
  let apiServer;
  try {
    const result = createApp({ dbPath: resolve(dir, "signalgrid.db"), datasetPath: resolve(process.cwd(), "data/raw/monitoring.csv") });
    const before = result.store.latestEventId();
    const prepared = result.replay.prepareDemo({ seed: 42, speed: 1 });
    const session = prepared.session;
    const streamChunks = [];
    let closeStream;
    result.broker.subscribe({ status() { return this; }, set() { return this; }, flushHeaders() {}, write(chunk) { streamChunks.push(String(chunk)); return true; }, on(event, callback) { if (event === "close") closeStream = callback; return this; } }, prepared.cursor, session.id);
    result.replay.startDemo(session.id, prepared.cursor);
    const deadline = Date.now() + Number(process.env.RCA_TOTAL_TIMEOUT_MS ?? 150000) + 30000;
    let requestedGroupId = null;
    while (Date.now() < deadline) {
      const firstGroup = result.store.incidentGroups(1)[0];
      if (firstGroup && !requestedGroupId) {
        // Hosted RCA is an explicit investigation action, never a replay side
        // effect. The incident/SSE alert exists before this request is made.
        requestedGroupId = String(firstGroup.id);
        // Freeze the source prefix before inference so the accepted result is
        // current rather than correctly marked stale by a moving replay.
        result.replay.pause();
        result.rca.enqueueGroup(requestedGroupId);
      }
      if (requestedGroupId) {
        const firstJob = result.store.rcaGroupJob(requestedGroupId);
        if (firstJob?.status === "completed" || firstJob?.status === "insufficient_evidence") break;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    await result.rca.whenIdle();
    result.replay.pause();
    closeStream?.();
    const fallbackGroup = result.store.incidentGroups(1)[0];
    const groupId = requestedGroupId ?? (fallbackGroup ? String(fallbackGroup.id) : null);
    const group = groupId ? result.store.incidentGroup(groupId) : null;
    const job = groupId ? result.store.rcaGroupJob(groupId) : null;
    const rca = groupId ? result.store.rcaGroupResult(groupId) : null;
    const events = result.store.eventsSince(before, 1000).map(event => String(event.event_type));
    const toolTrace = rca?.toolTrace ?? [];
    const evidenceBindings = rca?.evidenceBindings ?? [];
    let authorizedApiRetrieval = false;
    if (groupId) {
      apiServer = result.app.listen(0, "127.0.0.1");
      await new Promise(resolveReady => apiServer.once("listening", resolveReady));
      const address = apiServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: process.env.SIGNALGRID_ADMIN_PASSWORD ?? "admin123" }) });
      if (loginResponse.ok) {
        const login = await loginResponse.json();
        const incidentResponse = await fetch(`http://127.0.0.1:${port}/api/incident-groups/${encodeURIComponent(groupId)}`, { headers: { authorization: `Bearer ${login.token}` } });
        if (incidentResponse.ok) {
          const incident = await incidentResponse.json();
          authorizedApiRetrieval = incident?.rca?.provider === "nvidia" && incident?.rca?.validationOutcome === "verified";
        }
      }
    }
    const output = {
      sessionId: session?.id ?? null,
      groupId,
      sourceObservationIds: groupId ? result.store.groupMembers(groupId).map(member => String(member.observation_id)) : [],
      incidentAlertBeforeRca: events.indexOf("incident.detected") >= 0 && (events.indexOf("rca.queued") < 0 || events.indexOf("incident.detected") < events.indexOf("rca.queued")),
      rcaJobId: job?.job_id ?? null,
      jobStatus: job?.status ?? null,
      jobError: job?.error ?? null,
      jobProvider: job?.provider ?? null,
      jobModel: job?.model ?? null,
      provider: rca?.provider ?? null,
      model: rca?.model ?? null,
      attemptedProvider: rca?.attemptedProvider ?? null,
      attemptedModel: rca?.attemptedModel ?? null,
      generatedBy: rca?.generatedBy ?? null,
      validationOutcome: rca?.validationOutcome ?? null,
      validationReason: rca?.validationReason ?? null,
      providerRequestCount: rca?.providerRequestCount ?? 0,
      toolsUsed: rca?.toolsUsed ?? [],
      toolTraceCount: toolTrace.length,
      analysisDurationMs: rca?.analysisDurationMs ?? 0,
      providerDiagnostics: rca?.providerDiagnostics ?? null,
      evidenceHash: job?.evidence_hash ?? null,
      fallbackStatus: rca?.fallbackStatus ?? null,
      stages: {
        connection: typeof rca?.providerDiagnostics?.httpStatus === "number",
        structuredToolCall: toolTrace.length > 0,
        toolResultDelivery: toolTrace.some(trace => trace.ok),
        finalJsonParsing: rca?.providerDiagnostics?.parseOutcome === "accepted",
        controlledSchema: rca?.validationOutcome === "verified",
        rulePolicy: rca?.validationOutcome === "verified",
        evidenceBindings: rca?.validationOutcome === "verified" && evidenceBindings.length === (rca?.hypothesisCodes?.length ?? 0),
        persistence: Boolean(job?.job_id && rca),
        sseLifecycle: ["incident.detected", "rca.queued", "rca.running", "rca.completed"].every(event => events.includes(event)),
        authorizedApiRetrieval
      },
      confirmedFindingCount: rca?.confirmedFindings?.length ?? 0,
      hypothesisCount: rca?.supportedHypotheses?.length ?? 0,
      missingEvidenceCount: rca?.missingEvidence?.length ?? 0,
      lifecycleEvents: events.filter(event => ["incident.detected", "rca.queued", "rca.running", "rca.fallback", "rca.completed"].includes(event)),
      streamEventTypes: [...new Set(streamChunks.map(chunk => chunk.match(/^event: ([^\n]+)/m)?.[1]).filter(Boolean))]
    };
    console.log(JSON.stringify(output));
    if (output.provider !== "nvidia" || output.generatedBy !== "ai" || output.validationOutcome !== "verified" || output.providerRequestCount < 2 || output.toolTraceCount < 1 || !output.rcaJobId || !output.incidentAlertBeforeRca || !Object.values(output.stages).every(Boolean)) process.exitCode = 1;
  } finally { apiServer?.close(); rmSync(dir, { recursive: true, force: true }); }
}
