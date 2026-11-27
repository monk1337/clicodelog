"""Bookmark endpoints.

Plain `def` handlers: they read and write a JSON file, and FastAPI runs sync
handlers in its threadpool rather than on the event loop.

The list response is enriched with each bookmark's readable project name and
session title so the panel can group and search them. That enrichment exists
only in the response — bookmarks.json, the one piece of irreplaceable user data
in the app, is never rewritten to add derived fields.
"""

from fastapi import APIRouter, Body

from ..bookmarks import add_bookmark, load_bookmarks, remove_bookmark
from ..logging_setup import get_logger

router = APIRouter()
log = get_logger(__name__)


def _fallback_project_name(source: str, project_id: str) -> str:
    if source == "codex":
        try:
            from ..utils import decode_path_id
            return decode_path_id(project_id)
        except Exception:
            return project_id
    if source == "claude-code":
        # Lossy (Claude Code folds "/", "_" and "-" together) — only used when
        # the session has no recorded cwd.
        return project_id.replace("-", "/").lstrip("/")
    return project_id


def _enrich(items: list) -> list:
    by_source: dict = {}
    for b in items:
        src, pid, sid = b.get("source"), b.get("project_id"), b.get("session_id")
        if src and pid and sid:
            by_source.setdefault(src, set()).add((pid, sid))

    lookup: dict = {}
    try:
        from ..search_index import summaries_for
        for src, keys in by_source.items():
            for key, info in summaries_for(src, list(keys)).items():
                lookup[(src,) + key] = info
    except Exception:
        log.exception("Could not enrich bookmarks; returning them unenriched")

    out = []
    for b in items:
        e = dict(b)
        info = lookup.get((b.get("source"), b.get("project_id"), b.get("session_id")), {})
        e["project_name"] = (info.get("cwd")
                             or _fallback_project_name(b.get("source", ""),
                                                       b.get("project_id", "")))
        e["session_summary"] = info.get("summary") or ""
        out.append(e)
    return out


@router.get("/api/bookmarks")
def api_list_bookmarks():
    # Newest first
    items = sorted(load_bookmarks(), key=lambda b: b.get("created", ""), reverse=True)
    return _enrich(items)


@router.post("/api/bookmarks")
def api_add_bookmark(body: dict = Body(...)):
    return _enrich(add_bookmark(body))


@router.delete("/api/bookmarks/{bid:path}")
def api_remove_bookmark(bid: str):
    return _enrich(remove_bookmark(bid))
