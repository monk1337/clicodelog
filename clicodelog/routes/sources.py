from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import sync as _sync
from ..config import SOURCES

router = APIRouter()


@router.get("/api/sources")
async def api_sources():
    return {
        "sources": [
            {"id": sid, "name": cfg["name"], "available": cfg["source_dir"].exists()}
            for sid, cfg in SOURCES.items()
        ],
        "current": _sync.current_source,
    }


@router.post("/api/sources/{source_id}")
async def api_set_source(source_id: str):
    if source_id not in SOURCES:
        return JSONResponse({"error": "Unknown source"}, status_code=400)
    _sync.current_source = source_id
    return {"status": "success", "current": _sync.current_source}
