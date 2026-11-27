"""One-pass metadata extraction for a session file.

Previously three modules each opened and re-read the same files: sessions.py to
build a listing, search_index.py to build an index entry, and projects.py to
count and stat. This reads a file once and returns everything any of them need,
including the token, model, tool and edited-file totals that power analytics and
file-edit archaeology — those are free here because the pass is already running.

Every reader is defensive: a session being appended to while sync copies it can
produce a torn final line, and a vendor can change its format at any time, so a
line that does not parse is skipped rather than aborting the file.
"""

import json
from datetime import datetime
from pathlib import Path

from .logging_setup import get_logger

log = get_logger(__name__)

# Tools whose input names a file the agent modified.
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_editor"}
MAX_FILES_TOUCHED = 200      # keep index entries bounded
SUMMARY_CHARS = 100

# When a Claude Code session runs out of context it restarts with this
# preamble as its first user message. Taking it as the title made every
# continued session read "This session is being continued from a previous…",
# which is most of the long, heavily bookmarked ones — so it is skipped like
# any other preamble, and the first prompt the user actually typed wins.
CONTINUATION_PREFIXES = (
    "This session is being continued from a previous conversation",
    # Harness markers Claude Code writes as user turns — never what the user typed.
    "[Image:",
    "[Image #",
    "[Request interrupted by user",
)


def _is_preamble(text: str) -> bool:
    return text.startswith("<") or text.startswith(CONTINUATION_PREFIXES)


def _blank_usage() -> dict:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}


def _new_state() -> dict:
    return {
        "summary": None,
        "first_user_message": None,
        "any_user_text": None,     # fallback when every user turn is a system preamble
        "message_count": 0,
        "first_timestamp": None,
        "last_timestamp": None,
        "cwd": None,
        "usage": _blank_usage(),
        "models": {},
        "tools": {},
        "files_touched": [],
        "_files_seen": set(),
    }


def _note_time(state: dict, ts) -> None:
    if not ts or not isinstance(ts, str):
        return
    if not state["first_timestamp"]:
        state["first_timestamp"] = ts
    state["last_timestamp"] = ts


def _note_file(state: dict, path) -> None:
    if not isinstance(path, str) or not path:
        return
    if path in state["_files_seen"] or len(state["files_touched"]) >= MAX_FILES_TOUCHED:
        return
    state["_files_seen"].add(path)
    state["files_touched"].append(path)


def _note_tool(state: dict, name, tool_input) -> None:
    if not isinstance(name, str) or not name:
        return
    state["tools"][name] = state["tools"].get(name, 0) + 1
    if name in EDIT_TOOLS and isinstance(tool_input, dict):
        _note_file(state, tool_input.get("file_path") or tool_input.get("path"))
        for edit in tool_input.get("edits") or []:
            if isinstance(edit, dict):
                _note_file(state, edit.get("file_path"))


def _text_of(content) -> str:
    """Flatten Anthropic/Gemini-style content into plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") in (None, "text"):
            t = block.get("text")
            if isinstance(t, str):
                parts.append(t)
    return " ".join(parts)


# --------------------------------------------------------------------------- claude
def _read_claude(entry: dict, state: dict) -> None:
    etype = entry.get("type")

    if not state["cwd"] and isinstance(entry.get("cwd"), str):
        state["cwd"] = entry["cwd"]

    if etype == "summary":
        if not state["summary"]:
            s = entry.get("summary")
            if isinstance(s, str):
                state["summary"] = s
        return

    _note_time(state, entry.get("timestamp"))

    if etype not in ("user", "assistant"):
        return

    state["message_count"] += 1
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return

    if etype == "assistant":
        model = msg.get("model")
        if isinstance(model, str) and model:
            state["models"][model] = state["models"].get(model, 0) + 1
        usage = msg.get("usage")
        if isinstance(usage, dict):
            u = state["usage"]
            # All four fields. Summing only input+output under-reported real
            # usage by ~116x, because prompt caching moves nearly all input
            # into cache_read_input_tokens.
            u["input"] += usage.get("input_tokens") or 0
            u["output"] += usage.get("output_tokens") or 0
            u["cache_read"] += usage.get("cache_read_input_tokens") or 0
            u["cache_creation"] += usage.get("cache_creation_input_tokens") or 0

    content = msg.get("content")
    if etype == "user" and not state["first_user_message"]:
        text = _text_of(content).strip()
        if text and not state["any_user_text"]:
            state["any_user_text"] = text[:SUMMARY_CHARS]
        if text and not _is_preamble(text):
            state["first_user_message"] = text[:SUMMARY_CHARS]

    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                _note_tool(state, block.get("name"), block.get("input"))


# --------------------------------------------------------------------------- codex
def _read_codex(entry: dict, state: dict) -> None:
    _note_time(state, entry.get("timestamp"))
    etype = entry.get("type")
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        return

    if etype == "session_meta":
        if not state["cwd"] and isinstance(payload.get("cwd"), str):
            state["cwd"] = payload["cwd"]
        return

    if etype == "response_item":
        role = payload.get("role")
        if role in ("user", "assistant"):
            state["message_count"] += 1
            if role == "user" and not state["first_user_message"]:
                for block in payload.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "input_text":
                        text = block.get("text") or ""
                        if text and not text.startswith("<") and len(text) < 500:
                            state["first_user_message"] = text[:SUMMARY_CHARS]
                            break
        if payload.get("type") == "function_call":
            name = payload.get("name")
            args = payload.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, ValueError):
                    args = None
            _note_tool(state, name, args if isinstance(args, dict) else None)
        return

    if etype == "event_msg":
        ptype = payload.get("type")
        if ptype == "user_message" and not state["first_user_message"]:
            m = payload.get("message")
            if isinstance(m, str):
                state["first_user_message"] = m[:SUMMARY_CHARS]
        elif ptype == "token_count":
            # Cumulative totals; the last one wins.
            info = payload.get("info")
            tot = info.get("total_token_usage") if isinstance(info, dict) else None
            if isinstance(tot, dict):
                state["usage"] = {
                    "input": tot.get("input_tokens") or 0,
                    "output": tot.get("output_tokens") or 0,
                    "cache_read": tot.get("cached_input_tokens") or 0,
                    "cache_creation": 0,
                }


# --------------------------------------------------------------------------- gemini
def _gemini_message(msg: dict, state: dict) -> None:
    if not isinstance(msg, dict):
        return
    mtype = msg.get("type")
    _note_time(state, msg.get("timestamp"))
    if mtype not in ("user", "gemini", "model", "assistant"):
        return                                   # 'info' etc. are not conversation
    state["message_count"] += 1
    if mtype == "user":
        if not state["first_user_message"]:
            text = _text_of(msg.get("content")).strip()
            if text and not state["any_user_text"]:
                state["any_user_text"] = text[:SUMMARY_CHARS]
            if text and not _is_preamble(text):
                state["first_user_message"] = text[:SUMMARY_CHARS]
        return

    model = msg.get("model")
    if isinstance(model, str) and model:
        state["models"][model] = state["models"].get(model, 0) + 1
    tokens = msg.get("tokens")
    if isinstance(tokens, dict):
        u = state["usage"]
        u["input"] += tokens.get("input") or tokens.get("input_tokens") or 0
        u["output"] += tokens.get("output") or tokens.get("output_tokens") or 0
        u["cache_read"] += tokens.get("cached") or 0
    elif isinstance(tokens, int):
        state["usage"]["output"] += tokens
    for call in msg.get("toolCalls") or []:
        if isinstance(call, dict):
            _note_tool(state, call.get("name"), call.get("args"))


def _read_gemini_line(entry: dict, state: dict, header: dict) -> None:
    """Gemini CLI writes JSON Lines: a header, then $set mutations and/or bare
    message records. $set.messages replaces the list wholesale."""
    if "sessionId" in entry and "projectHash" in entry:
        header.update(entry)
        _note_time(state, entry.get("startTime"))
        _note_time(state, entry.get("lastUpdated"))
        return

    mutation = entry.get("$set")
    if isinstance(mutation, dict):
        msgs = mutation.get("messages")
        if isinstance(msgs, list):
            # A replacement of the whole list — recount from scratch.
            state["message_count"] = 0
            state["first_user_message"] = None
            for m in msgs:
                _gemini_message(m, state)
        _note_time(state, mutation.get("lastUpdated"))
        return

    if entry.get("type"):
        _gemini_message(entry, state)


# --------------------------------------------------------------------------- driver
def scan_session(path: Path, source_id: str) -> dict | None:
    """Read one session file and return everything the app needs about it."""
    state = _new_state()
    header: dict = {}
    try:
        st = path.stat()
        with open(path, "r", errors="ignore") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue                       # torn line from a live session
                if not isinstance(entry, dict):
                    continue                       # 'null' or a bare scalar
                try:
                    if source_id == "claude-code":
                        _read_claude(entry, state)
                    elif source_id == "codex":
                        _read_codex(entry, state)
                    else:
                        _read_gemini_line(entry, state, header)
                except (AttributeError, TypeError):
                    continue                       # unexpected shape; skip the line
    except OSError as e:
        log.warning("Could not read %s: %s", path, e)
        return None

    sub_dir = path.parent / path.stem
    subagent_count = 0
    if sub_dir.is_dir():
        try:
            subagent_count = sum(1 for _ in sub_dir.rglob("*.jsonl"))
        except OSError:
            pass

    return {
        "id": path.stem,
        "filename": path.name,
        "summary": (state["summary"] or state["first_user_message"]
                    or state["any_user_text"] or "No summary"),
        "message_count": state["message_count"],
        "first_timestamp": state["first_timestamp"],
        "last_timestamp": state["last_timestamp"],
        "size": st.st_size,
        "mtime": st.st_mtime,
        "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
        "full_path": str(path),
        "subagent_count": subagent_count,
        "cwd": state["cwd"] or "",
        "usage": state["usage"],
        "models": state["models"],
        "tools": state["tools"],
        "files_touched": state["files_touched"],
        "gemini_hash": header.get("projectHash", ""),
    }
