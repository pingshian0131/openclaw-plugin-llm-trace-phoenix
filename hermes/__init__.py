"""phoenix — Hermes plugin for Arize Phoenix observability.

One span per LLM API call, sent after the call completes.
Uses pre_api_request / post_api_request hooks so token usage is available.

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
from typing import Any, Dict, Optional

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
    """Deterministic hex ID from arbitrary string via SHA-256."""
    return hashlib.sha256(seed.encode()).hexdigest()[:length]


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


def _on_pre_api_request(
    *,
    session_id: str = "",
    model: str = "",
    provider: str = "",
    platform: str = "",
    **_kwargs: Any,
) -> None:
    with _LOCK:
        _PENDING[session_id] = {
            "start_time": time.time(),
            "session_id": session_id,
            "model": model,
            "provider": provider,
            "platform": platform,
        }


def _on_post_api_request(
    *,
    session_id: str = "",
    model: str = "",
    provider: str = "",
    platform: str = "",
    usage: Optional[Dict[str, Any]] = None,
    **_kwargs: Any,
) -> None:
    end_time = time.time()

    with _LOCK:
        pending = _PENDING.pop(session_id, None)

    start_time = pending["start_time"] if pending else end_time
    effective_model = model or (pending or {}).get("model", "")
    effective_provider = provider or (pending or {}).get("provider", "")

    attributes: Dict[str, Any] = {
        "openinference.span.kind": "LLM",
        "llm.model_name": effective_model,
        "llm.provider": effective_provider,
        "session.id": session_id,
        "tag.platform": platform,
    }

    # Token counts from post_api_request usage field
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
    ctx.register_hook("pre_api_request", _on_pre_api_request)
    ctx.register_hook("post_api_request", _on_post_api_request)
