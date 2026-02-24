from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import sync as _sync
from ..config import DATA_DIR, SOURCES

router = APIRouter()


@router.post("/api/sync")
async def api_sync(source: Optional[str] = None):
    source_id = source or _sync.current_source
    try:
        _sync.sync_data(source_id=source_id, silent=True)
        last = _sync.last_sync_time.get(source_id)
        return {"status": "success", "source": source_id, "last_sync": last.isoformat() if last else None}
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@router.get("/api/status")
async def api_status(source: Optional[str] = None):
    source_id = source or _sync.current_source
    data_dir = DATA_DIR / SOURCES.get(source_id, {}).get("data_subdir", "")
    last = _sync.last_sync_time.get(source_id)
    return {
        "source": source_id,
        "last_sync": last.isoformat() if last else None,
        "sync_interval_hours": 1,
        "data_dir": str(data_dir),
    }
