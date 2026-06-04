"""Lightweight, auto-maintained metadata index for fast session search.

Stores one small record per session (id, project, cwd, summary, timestamps,
size, mtime) in ~/.clicodelog/search_index.json. Lets search match by session
id / cwd / summary / project name instantly without walking and reading files.

Freshness strategy (no background process, always correct):
  * Full incremental refresh on startup and after every sync.
  * A cheap TTL-guarded incremental refresh before each search, so anything
    you look at is current within seconds.
Incremental = each entry is keyed by (size, mtime); only changed/new files are
re-read, and entries whose files vanished are dropped. The index mirrors the
local backup dir (DATA_DIR), which is additive, so nothing is lost.
"""

import json
import time
from pathlib import Path

from .config import APP_DATA_DIR, DATA_DIR, SOURCES
from .utils import encode_path_id, get_codex_cwd, get_gemini_project_hash

INDEX_FILE = APP_DATA_DIR / "search_index.json"
_REFRESH_TTL = 5.0  # seconds; min gap between lazy refreshes per source

# In-memory index: { source_id: { file_path: entry } }
_index: dict = {}
_last_refresh: dict = {}
_loaded = False


def _read_claude_cwd(path: Path) -> str | None:
    try:
        with open(path, "r", errors="ignore") as fh:
            for _ in range(20):
                line = fh.readline()
                if not line:
                    break
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("cwd"):
                    return entry["cwd"]
    except Exception:
        pass
    return None


def _load() -> None:
    global _index, _loaded
    if _loaded:
        return
    try:
        _index = json.loads(INDEX_FILE.read_text())
    except Exception:
        _index = {}
    _loaded = True


def _save() -> None:
    try:
        APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
        INDEX_FILE.write_text(json.dumps(_index))
    except Exception:
        pass


def _session_files(source_id: str, data_dir: Path):
    if source_id == "claude-code":
        for project_dir in data_dir.iterdir():
            if project_dir.is_dir():
                for f in project_dir.rglob("*.jsonl"):
                    yield f, project_dir
    elif source_id == "codex":
        for f in data_dir.rglob("*.jsonl"):
            yield f, None
    else:  # gemini
        for f in data_dir.rglob("chats/session-*.json"):
            yield f, None


def _build_entry(source_id: str, f: Path, project_dir, stat) -> dict | None:
    # Lazy import avoids a circular import at module load (sessions imports nothing
    # from here, but keep it tidy).
    from .sessions import _parse_session_info

    info = _parse_session_info(f, source_id)
    if info is None:
        return None

    if source_id == "claude-code":
        project_id = project_dir.name
        project_name = project_dir.name.replace("-", "/").lstrip("/")
        cwd = _read_claude_cwd(f) or ""
    elif source_id == "codex":
        cwd = get_codex_cwd(f) or ""
        if not cwd:
            return None
        project_id = encode_path_id(cwd)
        project_name = cwd
    else:  # gemini
        ph = get_gemini_project_hash(f)
        if not ph:
            return None
        project_id = ph
        project_name = f"Project {ph[:8]}..."
        cwd = ""

    return {
        "session_id": info["id"],
        "project_id": project_id,
        "project_name": project_name,
        "cwd": cwd,
        "summary": info["summary"],
        "first_ts": info["first_timestamp"],
        "last_ts": info["last_timestamp"],
        "msg_count": info["message_count"],
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


def refresh_index(source_id: str | None = None) -> None:
    """Incrementally rebuild the index for one source (or all). Cheap: only
    re-reads files whose (size, mtime) changed; drops entries for files gone."""
    _load()
    sources = [source_id] if source_id else list(SOURCES.keys())
    for sid in sources:
        if sid not in SOURCES:
            continue
        data_dir = DATA_DIR / SOURCES[sid]["data_subdir"]
        if not data_dir.exists():
            continue
        old = _index.get(sid, {})
        new: dict = {}
        for f, project_dir in _session_files(sid, data_dir):
            key = str(f)
            try:
                st = f.stat()
            except OSError:
                continue
            prev = old.get(key)
            if prev and prev.get("size") == st.st_size and prev.get("mtime") == st.st_mtime:
                new[key] = prev  # unchanged — reuse
                continue
            entry = _build_entry(sid, f, project_dir, st)
            if entry:
                new[key] = entry
        _index[sid] = new
        _last_refresh[sid] = time.monotonic()
    _save()


def _ensure_fresh(source_id: str) -> None:
    _load()
    last = _last_refresh.get(source_id, 0)
    if time.monotonic() - last > _REFRESH_TTL:
        refresh_index(source_id)


def search_index(query: str, source_id: str) -> list:
    """Match query against session id, cwd, summary, project name. Instant —
    no file reads. Exact id matches are returned first."""
    q = (query or "").strip().lower()
    if not q:
        return []
    _ensure_fresh(source_id)
    entries = _index.get(source_id, {})
    exact, partial = [], []
    for e in entries.values():
        sid = e.get("session_id", "")
        if sid.lower() == q:
            exact.append(e)
            continue
        hay = " ".join([
            sid,
            e.get("cwd", ""),
            e.get("summary", ""),
            e.get("project_name", ""),
        ]).lower()
        if q in hay:
            partial.append(e)
    out = []
    seen = set()
    for e in exact + partial:
        k = (e["project_id"], e["session_id"])
        if k in seen:
            continue
        seen.add(k)
        out.append({
            "project_id": e["project_id"],
            "session_id": e["session_id"],
            "project_name": e["project_name"],
            "cwd": e.get("cwd", ""),
            "summary": e.get("summary", ""),
        })
    return out
