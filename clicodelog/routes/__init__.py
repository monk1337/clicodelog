from fastapi import APIRouter

from .export import router as export_router
from .projects import router as projects_router
from .search import router as search_router
from .sources import router as sources_router
from .sync import router as sync_router

router = APIRouter()
router.include_router(sources_router)
router.include_router(projects_router)
router.include_router(search_router)
router.include_router(export_router)
router.include_router(sync_router)
