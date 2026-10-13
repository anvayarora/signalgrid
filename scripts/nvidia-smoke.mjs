import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = process.env.SIGNALGRID_ENV_FILE ? resolve(process.cwd(), process.env.SIGNALGRID_ENV_FILE) : resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const key = process.env.NVIDIA_KEY?.trim();
if (!key) {
  console.error("NVIDIA_KEY is not configured. Add it to a local .env; the key is never printed.");
  process.exitCode = 2;
} else {
  const base = (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const model = process.env.NVIDIA_SMOKE_MODEL ?? process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b";
  const tools = [{ type: "function", function: { name: "get_incident_evidence", description: "Read evidence for the incident group.", parameters: { type: "object", additionalProperties: false, required: ["incident_group_id"], properties: { incident_group_id: { type: "string" } } } } }];
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const post = async (body) => {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    try { const response = await fetch(`${base}/chat/completions`, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) }); const text = await response.text(); const safeText = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/("account"\s*:\s*")[^"]+/gi, "$1[redacted]"); if (!response.ok) throw new Error(`HTTP ${response.status}: ${safeText.slice(0, 300)}`); return JSON.parse(text); }
    finally { clearTimeout(timeout); }
  };
  try {
    const first = await post({ model, temperature: 0, max_tokens: 256, stream: false, tools, tool_choice: "required", messages: [{ role: "system", content: "Call get_incident_evidence exactly once, then wait for the tool result." }, { role: "user", content: "Investigate incident group group:smoke:report:rule." }] });
    const call = first.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.id || call.function?.name !== "get_incident_evidence") throw new Error("model did not return the required structured tool call");
    const final = await post({ model, temperature: 0, max_tokens: 256, stream: false, tools, messages: [
      { role: "system", content: "Return JSON only and make no causal claim beyond the tool result." },
      { role: "user", content: "Investigate incident group group:smoke:report:rule." },
      first.choices[0].message,
      { role: "tool", tool_call_id: call.id, content: JSON.stringify({ groupId: "group:smoke:report:rule", evidenceRefs: ["observation:smoke"], validationFindings: [], limitations: ["Smoke test evidence only"] }) }
    ] });
    if (!final.choices?.[0]?.message?.content) throw new Error("model did not return a final message after the tool result");
    console.log(`NVIDIA structured tool-call cycle passed (model ${model}).`);
  } catch (error) {
    console.error(`NVIDIA structured tool-call smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
