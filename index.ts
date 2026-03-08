/**
 * llm-trace-phoenix
 * OpenClaw plugin: intercepts llm_input / llm_output hooks and forwards
 * traces to Arize Phoenix via OTLP/HTTP (OpenInference format).
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
  startTimeNs: string; // nanoseconds as decimal string
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  sessionId: string;
  agentId?: string;
}

interface OtlpAttr {
  key: string;
  value: { stringValue: string } | { intValue: number };
}

// ── In-memory store for pending LLM inputs (keyed by runId) ─────────────────

const pendingInputs = new Map<string, PendingInput>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

/** Convert a runId (UUID or arbitrary string) into a 32-char hex trace ID. */
function toTraceId(runId: string): string {
  const hex = runId.replace(/-/g, "").replace(/[^0-9a-fA-F]/g, "0");
  return hex.padEnd(32, "0").slice(0, 32);
}

/** Convert a runId into a 16-char hex span ID. */
function toSpanId(runId: string): string {
  const hex = runId.replace(/-/g, "").replace(/[^0-9a-fA-F]/g, "0");
  return hex.padEnd(16, "0").slice(0, 16);
}

function strAttr(key: string, value: string): OtlpAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpAttr {
  return { key, value: { intValue: value } };
}

/** Build an OpenInference-compatible messages JSON string. */
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

// ── OTLP sender ──────────────────────────────────────────────────────────────

async function sendTrace(
  phoenixUrl: string,
  projectName: string,
  input: PendingInput,
  output: PluginHookLlmOutputEvent,
  endTimeNs: string
): Promise<void> {
  const traceId = toTraceId(output.runId);
  const spanId = toSpanId(output.runId);

  const inputMessages = buildMessages(
    input.systemPrompt,
    input.historyMessages,
    input.prompt
  );
  const outputText = output.assistantTexts.join("\n");
  const outputMessages = JSON.stringify(
    output.assistantTexts.map((t) => ({ role: "assistant", content: t }))
  );

  const attrs: OtlpAttr[] = [
    strAttr("openinference.span.kind", "LLM"),
    strAttr("llm.model_name", output.model),
    strAttr("llm.provider", output.provider),
    strAttr("input.value", inputMessages),
    strAttr("output.value", outputText),
    strAttr("llm.input_messages", inputMessages),
    strAttr("llm.output_messages", outputMessages),
    strAttr("session.id", input.sessionId),
  ];

  if (input.agentId) attrs.push(strAttr("tag.agent_id", input.agentId));
  if (output.usage?.input != null) attrs.push(intAttr("llm.token_count.prompt", output.usage.input));
  if (output.usage?.output != null) attrs.push(intAttr("llm.token_count.completion", output.usage.output));
  if (output.usage?.total != null) attrs.push(intAttr("llm.token_count.total", output.usage.total));
  if (output.usage?.cacheRead != null) attrs.push(intAttr("llm.token_count.cache_read", output.usage.cacheRead));
  if (output.usage?.cacheWrite != null) attrs.push(intAttr("llm.token_count.cache_write", output.usage.cacheWrite));

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr("service.name", projectName),
            strAttr("openclaw.agent_id", input.agentId ?? "unknown"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "llm-trace-phoenix", version: "1.0.0" },
            spans: [
              {
                traceId,
                spanId,
                name: `${output.provider}/${output.model}`,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: input.startTimeNs,
                endTimeUnixNano: endTimeNs,
                attributes: attrs,
                status: { code: 1 }, // STATUS_CODE_OK
              },
            ],
          },
        ],
      },
    ],
  };

  await fetch(`${phoenixUrl}/v1/traces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-phoenix-project-name": projectName,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
}

// ── Plugin entry point ────────────────────────────────────────────────────────

export default function plugin(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const phoenixUrl = cfg.phoenixUrl ?? "http://localhost:4318";
  const projectName = cfg.projectName ?? "openclaw";

  api.logger.info(`[phoenix] tracing → ${phoenixUrl} (project: ${projectName})`);

  // Capture LLM input (before model call)
  api.on("llm_input", (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
    pendingInputs.set(event.runId, {
      startTimeNs: nowNs(),
      provider: event.provider,
      model: event.model,
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: event.historyMessages,
      sessionId: event.sessionId,
      agentId: ctx.agentId,
    });
  });

  // Capture LLM output (after model call) and send to Phoenix
  api.on("llm_output", async (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
    const input = pendingInputs.get(event.runId);
    if (!input) return;
    pendingInputs.delete(event.runId);

    const endTimeNs = nowNs();

    try {
      await sendTrace(phoenixUrl, projectName, input, event, endTimeNs);
    } catch (err) {
      // Non-fatal: log and continue
      api.logger.warn(`[phoenix] trace send failed: ${err}`);
    }
  });
}
