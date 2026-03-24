# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An OpenClaw plugin (`llm-trace-phoenix`) that hooks into OpenClaw's `llm_input` / `llm_output` plugin events and forwards LLM traces to Arize Phoenix via Phoenix's native REST API (`/v1/projects/:project/spans`). Uses OpenInference semantic conventions.

## Project structure

This is a single-file TypeScript plugin:

- `index.ts` — entire plugin logic (hook registration, trace building, Phoenix REST sender)
- `package.json` — declares `"type": "module"` and `"main": "index.ts"`; no build step required
- `openclaw.plugin.json` — plugin manifest with config schema and UI hints

## Architecture

The plugin is stateful within a session: `llm_input` events are stored in a `Map<runId, PendingInput>`, then consumed on `llm_output` to compute latency and send the trace. Errors are non-fatal (logged via `api.logger.warn`).

**Trace format:** Phoenix REST body uses a flat `attributes` object (not OTLP array format). Span and trace IDs are derived from `runId` by stripping hyphens and padding to 16/32 hex chars.

**Key API endpoint:** `POST {phoenixUrl}/v1/projects/{projectName}/spans`

**Port note:** Phoenix REST API runs on port **6006** (same as UI), not 4318 (OTLP HTTP).

## Configuration

Plugin config in `~/.openclaw/openclaw.json`:

```json
"llm-trace-phoenix": {
  "enabled": true,
  "config": {
    "phoenixUrl": "http://localhost:6006",
    "projectName": "openclaw"
  }
}
```

## Installing / testing the plugin

```bash
# Install into OpenClaw extensions
git clone <repo> ~/.openclaw/extensions/llm-trace-phoenix

# Restart OpenClaw (macOS launchd)
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Verify plugin loaded
grep phoenix ~/.openclaw/logs/gateway.log
```

There is no build step and no test runner configured. Validation is done by running Phoenix locally (`docker compose up -d phoenix`) and observing traces at `http://localhost:6006`.
