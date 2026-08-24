"""Project, session and conversation endpoints.

Every handler here is a plain `def`, not `async def`. FastAPI runs sync handlers
in its threadpool and async ones directly on the event loop, so declaring these
async while doing blocking filesystem work meant a single slow request froze the
whole server: /api/status measured 2.5 ms idle and 12.29 s while one session
listing was in flight.
"""

from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import sync as _sync
from ..conversation import get_conversation
from ..metadata import get_project_meta_key, load_project_meta, update_project_meta
from ..projects import get_projects
from ..sessions import get_sessions, get_subagent_sessions
from ..utils import is_safe_id

router = APIRouter()

MAX_PAGE = 2000


def _resolve_source(source: Optional[str]) -> str:
    return source or _sync.current_source


@router.get("/api/projects")
def api_projects(source: Optional[str] = None):
    projects = get_projects(_resolve_source(source))
    flt = _sync.folder_filter
    if flt:
        needle = flt.lower()
        projects = [
            p for p in projects
            if needle in p.get("id", "").lower()
            or needle in p.get("name", "").lower()
            or needle in (p.get("custom_name") or "").lower()
        ]
    return projects


@router.get("/api/projects/{project_id}/sessions")
def api_sessions(project_id: str, source: Optional[str] = None,
                 limit: Optional[int] = 500, offset: int = 0):
    if not is_safe_id(project_id):
        return JSONResponse({"error": "Invalid project id"}, status_code=400)
    if limit is not None:
        limit = max(1, min(limit, 20000))
    return get_sessions(project_id, _resolve_source(source),
                        limit=limit, offset=max(0, offset))


@router.get("/api/projects/{project_id}/sessions/{session_id}/subagents")
def api_subagents(project_id: str, session_id: str, source: Optional[str] = None):
    if not (is_safe_id(project_id) and is_safe_id(session_id)):
        return JSONResponse({"error": "Invalid id"}, status_code=400)
    return get_subagent_sessions(project_id, session_id, _resolve_source(source))


@router.get("/api/projects/{project_id}/sessions/{session_id}")
def api_conversation(project_id: str, session_id: str,
                     source: Optional[str] = None,
                     offset: int = 0,
                     limit: Optional[int] = None,
                     include_results: bool = False,
                     tail: bool = False,
                     around_uuid: Optional[str] = None):
    if not (is_safe_id(project_id) and is_safe_id(session_id)):
        return JSONResponse({"error": "Invalid id"}, status_code=400)
    if limit is not None:
        limit = max(1, min(limit, MAX_PAGE))
    conv = get_conversation(project_id, session_id, _resolve_source(source),
                            offset=max(0, offset), limit=limit,
                            include_results=include_results, tail=tail,
                            around_uuid=around_uuid)
    if "error" in conv:
        # Previously returned 200 with an error body, so no client could tell
        # success from failure by status alone.
        status = 404 if conv["error"] in ("Session not found", "Unknown source") else 400
        return JSONResponse(conv, status_code=status)
    return conv


@router.get("/api/projects/{project_id}/meta")
def api_get_project_meta(project_id: str, source: Optional[str] = None):
    source_id = _resolve_source(source)
    pm = load_project_meta().get(get_project_meta_key(project_id, source_id), {})
    return {"custom_name": pm.get("custom_name", ""), "tags": pm.get("tags", [])}


@router.put("/api/projects/{project_id}/meta")
async def api_set_project_meta(project_id: str, request: Request, source: Optional[str] = None):
    # Async only because reading the request body is genuinely awaitable; the
    # write itself is handed to a locked, atomic helper.
    source_id = _resolve_source(source)
    body = await request.json()
    fields = {}
    if "custom_name" in body:
        fields["custom_name"] = body["custom_name"]
    if "tags" in body:
        fields["tags"] = body["tags"]
    update_project_meta(get_project_meta_key(project_id, source_id), fields)
    return {"status": "success"}


@router.get("/api/tags")
def api_get_tags(source: Optional[str] = None):
    source_id = _resolve_source(source)
    prefix = f"{source_id}:"
    tags = {
        tag
        for key, pm in load_project_meta().items()
        if key.startswith(prefix)
        for tag in pm.get("tags", [])
    }
    return sorted(tags)
