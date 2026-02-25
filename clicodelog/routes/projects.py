from typing import Optional

from fastapi import APIRouter, Request

from .. import sync as _sync
from ..conversation import get_conversation
from ..metadata import get_project_meta_key, load_project_meta, save_project_meta
from ..projects import get_projects
from ..sessions import get_sessions, get_subagent_sessions

router = APIRouter()


@router.get("/api/projects")
async def api_projects(source: Optional[str] = None):
    return get_projects(source or _sync.current_source)


@router.get("/api/projects/{project_id}/sessions")
async def api_sessions(project_id: str, source: Optional[str] = None):
    return get_sessions(project_id, source or _sync.current_source)


@router.get("/api/projects/{project_id}/sessions/{session_id}/subagents")
async def api_subagents(project_id: str, session_id: str, source: Optional[str] = None):
    return get_subagent_sessions(project_id, session_id, source or _sync.current_source)


@router.get("/api/projects/{project_id}/sessions/{session_id}")
async def api_conversation(project_id: str, session_id: str, source: Optional[str] = None):
    return get_conversation(project_id, session_id, source or _sync.current_source)


@router.get("/api/projects/{project_id}/meta")
async def api_get_project_meta(project_id: str, source: Optional[str] = None):
    source_id = source or _sync.current_source
    pm = load_project_meta().get(get_project_meta_key(project_id, source_id), {})
    return {"custom_name": pm.get("custom_name", ""), "tags": pm.get("tags", [])}


@router.put("/api/projects/{project_id}/meta")
async def api_set_project_meta(project_id: str, request: Request, source: Optional[str] = None):
    source_id = source or _sync.current_source
    body = await request.json()
    meta = load_project_meta()
    key = get_project_meta_key(project_id, source_id)
    meta.setdefault(key, {})
    if "custom_name" in body:
        meta[key]["custom_name"] = body["custom_name"]
    if "tags" in body:
        meta[key]["tags"] = body["tags"]
    save_project_meta(meta)
    return {"status": "success"}


@router.get("/api/tags")
async def api_get_tags(source: Optional[str] = None):
    source_id = source or _sync.current_source
    prefix = f"{source_id}:"
    tags = {
        tag
        for key, pm in load_project_meta().items()
        if key.startswith(prefix)
        for tag in pm.get("tags", [])
    }
    return sorted(tags)
