"""phoenix — Hermes plugin for Arize Phoenix observability.

One span per LLM call, sent after the call completes.
Uses three hooks to capture both conversation content and token usage:
  pre_llm_call    → start time, user message, conversation history
  post_api_request → token usage (input_tokens / output_tokens)
  post_llm_call   → assistant response, finalize and send trace

Required env vars (set in ~/.hermes/.env):
  HERMES_PHOENIX_URL     - Phoenix base URL (default: http://localhost:6006)
  HERMES_PHOENIX_PROJECT - Project name in Phoenix UI (default: hermes)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_PENDING: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _phoenix_url() -> str:
    return _env("HERMES_PHOENIX_URL", "http://localhost:6006").rstrip("/")


def _project() -> str:
    return _env("HERMES_PHOENIX_PROJECT", "hermes")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _make_id(seed: str, length: int) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()[:length]


def _extract_messages(history: Any) -> List[Dict[str, str]]:
    if not isinstance(history, list):
        return []
    result = []
    for m in history:
        if not isinstance(m, dict):
            continue
        role = m.get("role", "")
        if role not in ("system", "user", "assistant", "tool"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            text = " ".join(
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
        elif content is None:
            text = ""
        else:
            text = str(content)
        result.append({"role": role, "content": text[:6000]})
    return result


def _send_to_phoenix(payload: dict) -> None:
    url = f"{_phoenix_url()}/v1/projects/{_project()}/spans"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status >= 400:
                logger.warning("Phoenix plugin: HTTP %s", resp.status)
    except urllib.error.URLError as exc:
        logger.debug("Phoenix plugin: send failed: %s", exc)
    except Exception as exc:
        logger.debug("Phoenix plugin: unexpected error: %s", exc)


def _send_async(payload: dict) -> None:
    t = threading.Thread(target=_send_to_phoenix, args=(payload,), daemon=True)
    t.start()


# ── Hook 1: capture start time + conversation context ────────────────────────

def _on_pre_llm_call(
    *,
    session_id: str = "",
    user_message: str = "",
    conversation_history: Any = None,
    model: str = "",
    platform: str = "",
    **_kwargs: Any,
) -> None:
    with _LOCK:
        _PENDING[session_id] = {
            "start_time": time.time(),
            "user_message": user_message,
            "conversation_history": conversation_history,
            "model": model,
            "platform": platform,
            "usage": None,
        }


# ── Hook 2: capture token usage from raw API response ────────────────────────

def _on_post_api_request(
    *,
    session_id: str = "",
    usage: Optional[Dict[str, Any]] = None,
    provider: str = "",
    **_kwargs: Any,
) -> None:
    with _LOCK:
        pending = _PENDING.get(session_id)
        if pending is not None:
            pending["usage"] = usage
            if provider:
                pending["provider"] = provider


# ── Hook 3: finalize and send trace ──────────────────────────────────────────

def _on_post_llm_call(
    *,
    session_id: str = "",
    assistant_response: str = "",
    conversation_history: Any = None,
    model: str = "",
    platform: str = "",
    **_kwargs: Any,
) -> None:
    end_time = time.time()

    with _LOCK:
        pending = _PENDING.pop(session_id, None)

    start_time = pending["start_time"] if pending else end_time
    user_message = (pending or {}).get("user_message", "")
    history = (pending or {}).get("conversation_history") or conversation_history
    effective_model = model or (pending or {}).get("model", "")
    effective_provider = (pending or {}).get("provider", "")
    usage = (pending or {}).get("usage")

    messages = _extract_messages(history)
    if assistant_response:
        messages.append({"role": "assistant", "content": str(assistant_response)[:6000]})

    attributes: Dict[str, Any] = {
        "openinference.span.kind": "LLM",
        "llm.model_name": effective_model,
        "llm.provider": effective_provider,
        "input.value": user_message[:4000],
        "output.value": str(assistant_response)[:4000],
        "session.id": session_id,
        "tag.platform": platform,
    }

    for i, m in enumerate(messages):
        attributes[f"llm.input_messages.{i}.message.role"] = m["role"]
        attributes[f"llm.input_messages.{i}.message.content"] = m["content"]

    # Token counts from post_api_request
    if isinstance(usage, dict):
        input_tokens = usage.get("input_tokens") or usage.get("prompt_tokens")
        output_tokens = usage.get("output_tokens") or usage.get("completion_tokens")
        if input_tokens is not None:
            attributes["llm.token_count.prompt"] = int(input_tokens)
        if output_tokens is not None:
            attributes["llm.token_count.completion"] = int(output_tokens)
        if input_tokens is not None and output_tokens is not None:
            attributes["llm.token_count.total"] = int(input_tokens) + int(output_tokens)

    seed = f"{session_id}:{start_time}"
    trace_id = _make_id(seed, 32)
    span_id = _make_id(seed, 16)

    payload = {
        "data": [{
            "name": f"{effective_provider}/{effective_model}",
            "context": {"trace_id": trace_id, "span_id": span_id},
            "span_kind": "LLM",
            "start_time": _iso(start_time),
            "end_time": _iso(end_time),
            "status_code": "OK",
            "attributes": attributes,
        }]
    }

    _send_async(payload)


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_api_request", _on_post_api_request)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
