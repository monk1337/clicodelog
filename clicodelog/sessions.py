import json
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR, SOURCES
from .utils import decode_path_id, get_codex_cwd, get_gemini_project_hash


def get_sessions(project_id: str, source_id: str) -> list:
    if source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]

    if source_id == "claude-code":
        project_dir = data_dir / project_id
        if not project_dir.exists():
            return []
        files = sorted(project_dir.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)

    elif source_id == "codex":
        try:
            target_cwd = decode_path_id(project_id)
        except Exception:
            return []
        files = sorted(
            [f for f in data_dir.rglob("*.jsonl") if get_codex_cwd(f) == target_cwd],
            key=lambda x: x.stat().st_mtime, reverse=True,
        )

    else:  # gemini
        files = sorted(
            [f for f in data_dir.rglob("chats/session-*.json") if get_gemini_project_hash(f) == project_id],
            key=lambda x: x.stat().st_mtime, reverse=True,
        )

    return [info for f in files if (info := _parse_session_info(f, source_id)) is not None]


def get_subagent_sessions(project_id: str, session_id: str, source_id: str) -> list:
    if source_id != "claude-code":
        return []
    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    sub_dir = data_dir / project_id / session_id
    if not sub_dir.exists():
        return []
    files = sorted(sub_dir.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)
    return [info for f in files if (info := _parse_session_info(f, source_id)) is not None]


def _parse_session_info(session_file: Path, source_id: str):
    state = {"first_summary": None, "message_count": 0,
             "first_timestamp": None, "last_timestamp": None, "first_user_message": None}
    try:
        if source_id == "gemini":
            _read_gemini_file(session_file, state)
        else:
            _read_jsonl_file(session_file, source_id, state)
    except Exception as e:
        print(f"Error reading {session_file}: {e}")
        return None

    sub_dir = session_file.parent / session_file.stem
    subagent_count = len(list(sub_dir.glob("*.jsonl"))) if sub_dir.exists() else 0

    return {
        "id": session_file.stem,
        "filename": session_file.name,
        "summary": state["first_summary"] or state["first_user_message"] or "No summary",
        "message_count": state["message_count"],
        "first_timestamp": state["first_timestamp"],
        "last_timestamp": state["last_timestamp"],
        "size": session_file.stat().st_size,
        "modified": datetime.fromtimestamp(session_file.stat().st_mtime).isoformat(),
        "full_path": str(session_file),
        "subagent_count": subagent_count,
    }


def _read_gemini_file(session_file: Path, state: dict) -> None:
    with open(session_file, "r") as f:
        data = json.load(f)
    state["first_timestamp"] = data.get("startTime")
    state["last_timestamp"] = data.get("lastUpdated")
    for msg in data.get("messages", []):
        msg_type = msg.get("type")
        if msg_type in ("user", "gemini"):
            state["message_count"] += 1
            if msg_type == "user" and not state["first_user_message"]:
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) < 500:
                    state["first_user_message"] = content[:100]


def _read_jsonl_file(session_file: Path, source_id: str, state: dict) -> None:
    with open(session_file, "r") as f:
        for line in f:
            try:
                entry = json.loads(line)
                if source_id == "claude-code":
                    _read_claude_entry(entry, state)
                else:
                    _read_codex_entry(entry, state)
            except json.JSONDecodeError:
                continue


def _read_claude_entry(entry: dict, state: dict) -> None:
    if entry.get("type") == "summary" and not state["first_summary"]:
        state["first_summary"] = entry.get("summary", "")
    if entry.get("timestamp"):
        if not state["first_timestamp"]:
            state["first_timestamp"] = entry["timestamp"]
        state["last_timestamp"] = entry["timestamp"]
    if entry.get("type") in ("user", "assistant"):
        state["message_count"] += 1
        if entry.get("type") == "user" and not state["first_user_message"]:
            content = entry.get("message", {}).get("content", "")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        state["first_user_message"] = block.get("text", "")[:100]
                        break
            elif isinstance(content, str):
                state["first_user_message"] = content[:100]


def _read_codex_entry(entry: dict, state: dict) -> None:
    ts = entry.get("timestamp")
    if ts:
        if not state["first_timestamp"]:
            state["first_timestamp"] = ts
        state["last_timestamp"] = ts
    if entry.get("type") == "response_item":
        payload = entry.get("payload", {})
        role = payload.get("role")
        if role in ("user", "assistant"):
            state["message_count"] += 1
            if role == "user" and not state["first_user_message"]:
                for block in payload.get("content", []):
                    if isinstance(block, dict) and block.get("type") == "input_text":
                        text = block.get("text", "")
                        if not text.startswith("<") and len(text) < 500:
                            state["first_user_message"] = text[:100]
                            break
    elif entry.get("type") == "event_msg":
        payload = entry.get("payload", {})
        if payload.get("type") == "user_message" and not state["first_user_message"]:
            state["first_user_message"] = payload.get("message", "")[:100]
