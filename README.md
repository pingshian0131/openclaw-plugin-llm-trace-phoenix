# llm-trace-phoenix

Send every LLM call to [Arize Phoenix](https://github.com/Arize-ai/phoenix) for observability — prompts, responses, token usage, latency. Supports both **[OpenClaw](https://github.com/openclaw/openclaw)** and **[Hermes](https://github.com/NousResearch/hermes-agent)**.

| Platform | Language | Location |
|----------|----------|----------|
| OpenClaw | TypeScript | `index.ts` (root) |
| Hermes | Python | `hermes/__init__.py` |

Both implementations use Phoenix's native REST API (`/v1/projects/:project/spans`) with [OpenInference](https://github.com/Arize-ai/openinference) semantic conventions.

## What you get

Every LLM call is recorded in Phoenix with:

- **Token usage** — input / output / total tokens
- **Model & provider** — which model was used
- **Latency** — wall-clock time for the LLM call
- **Session ID** — conversation context

OpenClaw additionally captures full prompts, responses, and message history.

> **Note:** This plugin uses Phoenix's REST API on port **6006** (same as the UI), **not** the OTLP/HTTP endpoint on port 4318.

## Requirements

- A running Phoenix instance (self-hosted Docker or [Arize Cloud](https://app.phoenix.arize.com))
- **OpenClaw:** OpenClaw 2025+ (Plugin SDK with `llm_input` / `llm_output` hooks)
- **Hermes:** Hermes with `pre_api_request` / `post_api_request` plugin hooks

## Setup

### 0. Run Phoenix

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

### OpenClaw

**Install:**

```bash
openclaw plugins install clawhub:llm-trace-phoenix
openclaw gateway restart
```

Verify:

```bash
openclaw logs | grep phoenix
# [phoenix] tracing → http://localhost:6006 (project: openclaw)
```

**Configuration** (in `~/.openclaw/openclaw.json`):

| Key | Default | Description |
|-----|---------|-------------|
| `phoenixUrl` | `http://localhost:6006` | Phoenix REST API base URL |
| `projectName` | `openclaw` | Project name shown in Phoenix UI |

### Hermes

**Install:**

```bash
cp -r hermes/ ~/.hermes/hermes-agent/plugins/observability/phoenix/
```

Then enable in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - observability/phoenix
```

Restart Hermes gateway:

```bash
launchctl stop ai.hermes.gateway && launchctl start ai.hermes.gateway
```

**Configuration** (env vars in `~/.hermes/.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_PHOENIX_URL` | `http://localhost:6006` | Phoenix REST API base URL |
| `HERMES_PHOENIX_PROJECT` | `hermes` | Project name shown in Phoenix UI |

## Viewing traces

1. Open **http://localhost:6006**
2. Select your project (`openclaw` or `hermes`) from the sidebar
3. Make any LLM call — traces appear within seconds

Each trace shows the span name `provider/model` (e.g. `anthropic/claude-sonnet-4-6`) and token counts.

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
