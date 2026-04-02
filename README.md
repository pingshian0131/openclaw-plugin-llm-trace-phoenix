# openclaw-plugin-llm-trace-phoenix

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that intercepts every LLM call and sends a full trace to [Arize Phoenix](https://github.com/Arize-ai/phoenix) — so you can inspect prompts, responses, and token usage in a clean UI.

## What you get

Every time any of your OpenClaw agents calls an AI model, Phoenix records:

- **Full input** — system prompt + conversation history + user prompt
- **Full output** — complete assistant response
- **Token usage** — input / output / total / cache read / cache write
- **Model & provider** — which model was used
- **Agent ID** — which agent made the call
- **Latency** — wall-clock time for the LLM call

## How it works

The plugin hooks into OpenClaw's `llm_input` and `llm_output` plugin events, then forwards traces to Phoenix via Phoenix's **native REST API** (`/v1/projects/:project/spans`) using the [OpenInference](https://github.com/Arize-ai/openinference) semantic conventions — the same format Phoenix natively understands.

> **Note:** This plugin uses Phoenix's REST API on port **6006** (same as the UI), **not** the OpenTelemetry OTLP/HTTP endpoint on port 4318.

No proxy, no traffic interception, no changes to your agents.

## Requirements

- OpenClaw 2025+ (Plugin SDK with `llm_input` / `llm_output` hooks)
- A running Phoenix instance (self-hosted Docker or [Arize Cloud](https://app.phoenix.arize.com))

## Setup

### 1. Run Phoenix

The easiest way is Docker. Add this to your `docker-compose.yml`:

```yaml
phoenix:
  image: arizephoenix/phoenix:latest
  ports:
    - "6006:6006"   # Phoenix UI
    - "4317:4317"   # OTLP gRPC
    - "4318:4318"   # OTLP HTTP
  environment:
    PHOENIX_WORKING_DIR: /phoenix_data
  volumes:
    - phoenix-data:/phoenix_data
  restart: unless-stopped

volumes:
  phoenix-data:
```

Then:

```bash
docker compose up -d phoenix
```

Phoenix UI will be available at `http://localhost:6006`.

### 2. Install the plugin

```bash
openclaw plugins install clawhub:llm-trace-phoenix
```

This automatically installs the plugin and adds it to your `~/.openclaw/openclaw.json`.

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

Verify the plugin loaded:

```bash
openclaw gateway status
```

Or check the logs:

```bash
openclaw logs | grep phoenix
# [phoenix] tracing → http://localhost:6006 (project: openclaw)
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `phoenixUrl` | `http://localhost:6006` | Phoenix REST API base URL (same port as the UI) |
| `projectName` | `openclaw` | Project name shown in Phoenix UI |

## Viewing traces

1. Open **http://localhost:6006**
2. Select the `openclaw` project from the sidebar
3. Talk to any agent — traces appear within seconds

Each trace shows the span name `provider/model` (e.g. `anthropic/claude-opus-4-6`) and all attributes listed above.

## Privacy

This plugin forwards **all LLM call content** to your configured Phoenix instance, including:

- System prompts and conversation history
- User prompts and assistant responses
- Session ID and agent ID

**Data stays on your infrastructure.** The default `phoenixUrl` points to `http://localhost:6006` — traces never leave your machine unless you explicitly point it at a remote host.

If you configure a remote `phoenixUrl`:
- Use HTTPS to encrypt data in transit (e.g. `https://phoenix.yourcompany.com`)
- Ensure access to your Phoenix instance is properly restricted
- Be aware that conversation content (which may include sensitive information) will be stored on that remote host

This plugin sends data **only** to the Phoenix endpoint you configure. No data is sent to any third party, including the plugin author.

## License

MIT
