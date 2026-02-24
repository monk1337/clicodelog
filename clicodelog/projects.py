from .config import DATA_DIR, SOURCES
from .metadata import get_project_meta_key, load_project_meta
from .utils import encode_path_id, get_codex_cwd, get_gemini_project_hash


def get_projects(source_id: str) -> list:
    if source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    if not data_dir.exists():
        return []

    meta = load_project_meta()

    def _pm(pid):
        return meta.get(get_project_meta_key(pid, source_id), {})

    if source_id == "claude-code":
        return [
            {
                "id": d.name,
                "name": d.name.replace("-", "/").lstrip("/"),
                "custom_name": _pm(d.name).get("custom_name", ""),
                "tags": _pm(d.name).get("tags", []),
                "session_count": len(list(d.rglob("*.jsonl"))),
                "path": str(d),
            }
            for d in sorted(data_dir.iterdir()) if d.is_dir()
        ]

    if source_id == "codex":
        cwd_sessions: dict = {}
        for f in data_dir.rglob("*.jsonl"):
            cwd = get_codex_cwd(f)
            if cwd:
                cwd_sessions.setdefault(cwd, []).append(f)
        return [
            {
                "id": encode_path_id(cwd),
                "name": cwd,
                "custom_name": _pm(encode_path_id(cwd)).get("custom_name", ""),
                "tags": _pm(encode_path_id(cwd)).get("tags", []),
                "session_count": len(sessions),
                "path": cwd,
            }
            for cwd, sessions in sorted(cwd_sessions.items())
        ]

    # gemini
    hash_sessions: dict = {}
    for f in data_dir.rglob("chats/session-*.json"):
        h = get_gemini_project_hash(f)
        if h:
            hash_sessions.setdefault(h, []).append(f)
    return [
        {
            "id": ph,
            "name": f"Project {ph[:8]}...",
            "custom_name": _pm(ph).get("custom_name", ""),
            "tags": _pm(ph).get("tags", []),
            "session_count": len(sessions),
            "path": str(data_dir / ph),
        }
        for ph, sessions in sorted(hash_sessions.items())
    ]
