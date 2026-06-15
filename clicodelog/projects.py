from datetime import datetime

from .config import DATA_DIR, SOURCES
from .metadata import get_project_meta_key, load_project_meta
from .utils import encode_path_id, get_codex_cwd, get_gemini_project_hash


def _count_and_mtime(files):
    """Return (count, latest-mtime-ISO-or-None) over an iterable of paths."""
    count = 0
    latest = 0.0
    for f in files:
        count += 1
        try:
            m = f.stat().st_mtime
            if m > latest:
                latest = m
        except OSError:
            pass
    iso = datetime.fromtimestamp(latest).isoformat() if latest else None
    return count, iso


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
        out = []
        for d in sorted(data_dir.iterdir()):
            if not d.is_dir():
                continue
            count, last_mod = _count_and_mtime(d.rglob("*.jsonl"))
            out.append({
                "id": d.name,
                "name": d.name.replace("-", "/").lstrip("/"),
                "custom_name": _pm(d.name).get("custom_name", ""),
                "tags": _pm(d.name).get("tags", []),
                "session_count": count,
                "last_modified": last_mod,
                "path": str(d),
            })
        return out

    if source_id == "codex":
        cwd_sessions: dict = {}
        for f in data_dir.rglob("*.jsonl"):
            cwd = get_codex_cwd(f)
            if cwd:
                cwd_sessions.setdefault(cwd, []).append(f)
        out = []
        for cwd, sessions in sorted(cwd_sessions.items()):
            count, last_mod = _count_and_mtime(sessions)
            out.append({
                "id": encode_path_id(cwd),
                "name": cwd,
                "custom_name": _pm(encode_path_id(cwd)).get("custom_name", ""),
                "tags": _pm(encode_path_id(cwd)).get("tags", []),
                "session_count": count,
                "last_modified": last_mod,
                "path": cwd,
            })
        return out

    # gemini
    hash_sessions: dict = {}
    for f in data_dir.rglob("chats/session-*.json"):
        h = get_gemini_project_hash(f)
        if h:
            hash_sessions.setdefault(h, []).append(f)
    out = []
    for ph, sessions in sorted(hash_sessions.items()):
        count, last_mod = _count_and_mtime(sessions)
        out.append({
            "id": ph,
            "name": f"Project {ph[:8]}...",
            "custom_name": _pm(ph).get("custom_name", ""),
            "tags": _pm(ph).get("tags", []),
            "session_count": count,
            "last_modified": last_mod,
            "path": str(data_dir / ph),
        })
    return out
