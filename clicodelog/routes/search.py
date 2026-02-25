from typing import Optional

from fastapi import APIRouter

from .. import sync as _sync
from ..config import DATA_DIR, SOURCES
from ..utils import encode_path_id, get_codex_cwd, get_gemini_project_hash

router = APIRouter()


@router.get("/api/search")
async def api_search(q: Optional[str] = None, source: Optional[str] = None):
    query = (q or "").lower()
    source_id = source or _sync.current_source

    if not query or source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    if not data_dir.exists():
        return []

    results = []

    if source_id == "claude-code":
        for project_dir in data_dir.iterdir():
            if not project_dir.is_dir():
                continue
            for f in project_dir.rglob("*.jsonl"):
                try:
                    if query in f.read_text().lower():
                        results.append({
                            "project_id": project_dir.name,
                            "session_id": f.stem,
                            "project_name": project_dir.name.replace("-", "/").lstrip("/"),
                        })
                except Exception:
                    continue

    elif source_id == "codex":
        for f in data_dir.rglob("*.jsonl"):
            try:
                if query in f.read_text().lower():
                    cwd = get_codex_cwd(f)
                    if cwd:
                        results.append({"project_id": encode_path_id(cwd), "session_id": f.stem, "project_name": cwd})
            except Exception:
                continue

    else:  # gemini
        for f in data_dir.rglob("chats/session-*.json"):
            try:
                if query in f.read_text().lower():
                    ph = get_gemini_project_hash(f)
                    if ph:
                        results.append({"project_id": ph, "session_id": f.stem, "project_name": f"Project {ph[:8]}..."})
            except Exception:
                continue

    return results[:50]
