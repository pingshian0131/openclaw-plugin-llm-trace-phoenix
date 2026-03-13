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

Copy the plugin files into your OpenClaw extensions directory:

```bash
git clone https://github.com/pingshian0131/openclaw-plugin-llm-trace-phoenix \
  ~/.openclaw/extensions/llm-trace-phoenix
```

### 3. Register in openclaw.json

Add this to the `plugins.entries` section of `~/.openclaw/openclaw.json`:

```json
"llm-trace-phoenix": {
  "enabled": true,
  "config": {
    "phoenixUrl": "http://localhost:6006",
    "projectName": "openclaw"
  }
}
```

Also add it to `plugins.allow`:

```json
"allow": ["llm-trace-phoenix"]
```

### 4. Restart OpenClaw

```bash
# macOS (launchd)
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Docker
docker restart <your-openclaw-container>
```

Verify the plugin loaded:

```bash
grep phoenix ~/.openclaw/logs/gateway.log
# [gateway] [phoenix] tracing → http://localhost:6006 (project: openclaw)
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

## License

MIT
