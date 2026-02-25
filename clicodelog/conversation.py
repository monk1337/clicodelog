from pathlib import Path

from .config import DATA_DIR, SOURCES
from .parsers import parse_claude_conversation, parse_codex_conversation, parse_gemini_conversation
from .utils import decode_path_id, get_codex_cwd, get_gemini_project_hash


def get_conversation(project_id: str, session_id: str, source_id: str) -> dict:
    if source_id not in SOURCES:
        return {"error": "Unknown source"}

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    session_file = _find_session_file(data_dir, project_id, session_id, source_id)

    if not session_file or not session_file.exists():
        return {"error": "Session not found"}

    if source_id == "claude-code":
        return parse_claude_conversation(session_file, session_id)
    elif source_id == "codex":
        return parse_codex_conversation(session_file, session_id)
    else:
        return parse_gemini_conversation(session_file, session_id)


def _find_session_file(data_dir: Path, project_id: str, session_id: str, source_id: str):
    if source_id == "claude-code":
        for f in (data_dir / project_id).rglob("*.jsonl"):
            if f.stem == session_id:
                return f

    elif source_id == "codex":
        try:
            target_cwd = decode_path_id(project_id)
        except Exception:
            return None
        for f in data_dir.rglob("*.jsonl"):
            if f.stem == session_id and get_codex_cwd(f) == target_cwd:
                return f

    else:  # gemini
        for f in data_dir.rglob("chats/session-*.json"):
            if f.stem == session_id and get_gemini_project_hash(f) == project_id:
                return f

    return None
