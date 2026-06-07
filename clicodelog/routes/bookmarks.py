from fastapi import APIRouter, Request

from ..bookmarks import add_bookmark, load_bookmarks, remove_bookmark

router = APIRouter()


@router.get("/api/bookmarks")
async def api_list_bookmarks():
    # Newest first
    return sorted(load_bookmarks(), key=lambda b: b.get("created", ""), reverse=True)


@router.post("/api/bookmarks")
async def api_add_bookmark(request: Request):
    body = await request.json()
    return add_bookmark(body)


@router.delete("/api/bookmarks/{bid:path}")
async def api_remove_bookmark(bid: str):
    return remove_bookmark(bid)
