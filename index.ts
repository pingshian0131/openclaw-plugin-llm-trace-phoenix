/**
 * llm-trace-phoenix
 * OpenClaw plugin: intercepts llm_input / llm_output hooks and forwards
 * traces to Arize Phoenix via its native REST API (/v1/projects/:project/spans).
 */

import type {
  OpenClawPluginApi,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";

// ── Types ────────────────────────────────────────────────────────────────────

interface PluginConfig {
  phoenixUrl?: string;
  projectName?: string;
}

interface PendingInput {
  startTime: number; // ms
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  sessionId: string;
  agentId?: string;
}

// ── In-memory store for pending LLM inputs (keyed by runId) ─────────────────

const pendingInputs = new Map<string, PendingInput>();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert runId to a clean hex string for trace/span IDs. */
function toHex(runId: string, length: number): string {
  const hex = runId.replace(/-/g, "").replace(/[^0-9a-fA-F]/g, "0");
  return hex.padEnd(length, "0").slice(0, length);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Build an OpenInference-compatible messages array as a JSON string. */
function buildMessages(
  systemPrompt: string | undefined,
  history: unknown[],
  userPrompt: string
): string {
  const msgs: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    msgs.push({ role: "system", content: systemPrompt });
  }

  for (const m of history as Array<Record<string, unknown>>) {
    const role = typeof m.role === "string" ? m.role : "user";
    const content =
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content ?? "");
    msgs.push({ role, content });
  }

  msgs.push({ role: "user", content: userPrompt });
  return JSON.stringify(msgs);
}

// ── Phoenix REST sender ───────────────────────────────────────────────────────

async function sendTrace(
  phoenixUrl: string,
  projectName: string,
  input: PendingInput,
  output: PluginHookLlmOutputEvent,
  endTime: number
): Promise<void> {
  const traceId = toHex(output.runId, 32);
  const spanId = toHex(output.runId, 16);

  const inputMessages = buildMessages(
    input.systemPrompt,
    input.historyMessages,
    input.prompt
  );
  const outputText = output.assistantTexts.join("\n");
  const outputMessages = JSON.stringify(
    output.assistantTexts.map((t) => ({ role: "assistant", content: t }))
  );

  // Phoenix REST API uses a flat attributes object (not OTLP array format)
  const attributes: Record<string, unknown> = {
    "openinference.span.kind": "LLM",
    "llm.model_name": output.model,
    "llm.provider": output.provider,
    "input.value": inputMessages,
    "output.value": outputText,
    "llm.input_messages": inputMessages,
    "llm.output_messages": outputMessages,
    "session.id": input.sessionId,
  };

  if (input.agentId) attributes["tag.agent_id"] = input.agentId;
  if (output.usage?.input != null) attributes["llm.token_count.prompt"] = output.usage.input;
  if (output.usage?.output != null) attributes["llm.token_count.completion"] = output.usage.output;
  if (output.usage?.total != null) attributes["llm.token_count.total"] = output.usage.total;
  if (output.usage?.cacheRead != null) attributes["llm.token_count.cache_read"] = output.usage.cacheRead;
  if (output.usage?.cacheWrite != null) attributes["llm.token_count.cache_write"] = output.usage.cacheWrite;

  const body = {
    data: [
      {
        name: `${output.provider}/${output.model}`,
        context: { trace_id: traceId, span_id: spanId },
        span_kind: "LLM",
        start_time: toIso(input.startTime),
        end_time: toIso(endTime),
        status_code: "OK",
        attributes,
      },
    ],
  };

  const res = await fetch(
    `${phoenixUrl}/v1/projects/${encodeURIComponent(projectName)}/spans`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

// ── Plugin entry point ────────────────────────────────────────────────────────

export default function plugin(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const phoenixUrl = (cfg.phoenixUrl ?? "http://localhost:6006").replace(/\/$/, "");
  const projectName = cfg.projectName ?? "openclaw";

  api.logger.info(`[phoenix] tracing → ${phoenixUrl} (project: ${projectName})`);

  // Capture LLM input (before model call)
  api.on("llm_input", (event: PluginHookLlmInputEvent, _ctx: PluginHookAgentContext) => {
    pendingInputs.set(event.runId, {
      startTime: Date.now(),
      provider: event.provider,
      model: event.model,
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: event.historyMessages,
      sessionId: event.sessionId,
      agentId: _ctx.agentId,
    });
  });

  // Capture LLM output (after model call) and send to Phoenix
  api.on("llm_output", async (event: PluginHookLlmOutputEvent, _ctx: PluginHookAgentContext) => {
    const input = pendingInputs.get(event.runId);
    if (!input) return;
    pendingInputs.delete(event.runId);

    const endTime = Date.now();

    try {
      await sendTrace(phoenixUrl, projectName, input, event, endTime);
    } catch (err) {
      // Non-fatal: log and continue
      api.logger.warn(`[phoenix] trace send failed: ${err}`);
    }
  });
}
