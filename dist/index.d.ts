/**
 * llm-trace-phoenix
 * OpenClaw plugin: intercepts llm_input / llm_output hooks and forwards
 * traces to Arize Phoenix via its native REST API (/v1/projects/:project/spans).
 */
interface LlmInputEvent {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
}
interface LlmOutputEvent {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
}
interface AgentContext {
    agentId?: string;
}
interface PluginApi {
    pluginConfig?: unknown;
    logger: {
        info(msg: string): void;
        warn(msg: string): void;
    };
    on(event: "llm_input", handler: (event: LlmInputEvent, ctx: AgentContext) => void | Promise<void>): void;
    on(event: "llm_output", handler: (event: LlmOutputEvent, ctx: AgentContext) => void | Promise<void>): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
}
export default function plugin(api: PluginApi): void;
export {};
