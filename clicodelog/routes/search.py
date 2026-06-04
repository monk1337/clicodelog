from typing import Optional

from fastapi import APIRouter

from .. import sync as _sync
from ..config import DATA_DIR, SOURCES
from ..search_index import search_index
from ..utils import encode_path_id, get_codex_cwd, get_gemini_project_hash

router = APIRouter()

# Cap how much of a file we read for content matching. Session logs can be
# hundreds of MB; reading them whole would blow up memory. The session id and
# project name are matched without reading the file at all.
_MAX_CONTENT_SCAN = 8 * 1024 * 1024  # 8 MB


def _content_match(path, needle: str) -> bool:
    """Stream up to _MAX_CONTENT_SCAN bytes looking for needle; never loads
    the whole file into memory."""
    try:
        read = 0
        with open(path, "r", errors="ignore") as fh:
            while read < _MAX_CONTENT_SCAN:
                chunk = fh.read(65536)
                if not chunk:
                    break
                read += len(chunk)
                if needle in chunk.lower():
                    return True
    except Exception:
        return False
    return False


@router.get("/api/search")
async def api_search(q: Optional[str] = None, source: Optional[str] = None):
    query = (q or "").strip().lower()
    source_id = source or _sync.current_source

    if not query or source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    if not data_dir.exists():
        return []

    # Fast path: metadata index (id / cwd / summary / project name). Instant,
    # no file reads, auto-refreshed. If it returns hits we're done.
    indexed = search_index(query, source_id)
    if indexed:
        return indexed[:50]

    # Fallback: bounded full-text content scan for matches inside transcripts
    # that the metadata index can't see.
    results = []
    seen = set()

    def _add(project_id, session_id, project_name):
        key = (project_id, session_id)
        if key in seen:
            return
        seen.add(key)
        results.append({
            "project_id": project_id,
            "session_id": session_id,
            "project_name": project_name,
        })

    if source_id == "claude-code":
        for project_dir in data_dir.iterdir():
            if not project_dir.is_dir():
                continue
            project_name = project_dir.name.replace("-", "/").lstrip("/")
            name_hit = query in project_dir.name.lower() or query in project_name.lower()
            for f in project_dir.rglob("*.jsonl"):
                # Fast path: match by session id (filename) or project name —
                # no file read. Slow path: bounded content scan.
                if query in f.stem.lower() or name_hit or _content_match(f, query):
                    _add(project_dir.name, f.stem, project_name)

    elif source_id == "codex":
        for f in data_dir.rglob("*.jsonl"):
            cwd = get_codex_cwd(f)
            if not cwd:
                continue
            name_hit = query in cwd.lower()
            if query in f.stem.lower() or name_hit or _content_match(f, query):
                _add(encode_path_id(cwd), f.stem, cwd)

    else:  # gemini
        for f in data_dir.rglob("chats/session-*.json"):
            ph = get_gemini_project_hash(f)
            if not ph:
                continue
            if query in f.stem.lower() or query in ph.lower() or _content_match(f, query):
                _add(ph, f.stem, f"Project {ph[:8]}...")

    return results[:50]
