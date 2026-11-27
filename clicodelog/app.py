from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import __version__, assets, reaper
from .config import PACKAGE_DIR
from .routes import router

app = FastAPI(title="CLI Code Log", version=__version__)

# There is deliberately no CORSMiddleware here. The SPA is served from this same
# origin and never needed it, while `allow_origins=["*"]` with
# `allow_credentials=True` made Starlette reflect any requesting page's Origin —
# so any website open in the browser could read every transcript from
# 127.0.0.1:6126 and delete bookmarks through it.


@app.middleware("http")
async def cache_policy(request: Request, call_next):
    path = request.url.path
    # Requests in flight keep the reaper from trimming caches mid-use.
    reaper.request_started(path)
    try:
        response = await call_next(request)
    finally:
        reaper.request_finished(path)
    if path.startswith("/static/js/vendor/"):
        # Vendored libraries are immutable for a given release.
        response.headers["Cache-Control"] = "public, max-age=604800"
    elif path.startswith("/static") or path in ("/", "/view"):
        # `no-cache` still revalidates on every load, preserving the
        # edit-and-refresh loop, but allows a 304 instead of a full re-download.
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/static", StaticFiles(directory=str(PACKAGE_DIR / "static")), name="static")

templates = Jinja2Templates(directory=str(PACKAGE_DIR / "templates"))
templates.env.globals["asset"] = assets.url


def _render(request: Request, name: str):
    # FastAPI/Starlette changed TemplateResponse to accept `request` first.
    # Support both call styles so fresh installs and older environments work.
    try:
        return templates.TemplateResponse(request=request, name=name)
    except TypeError:
        return templates.TemplateResponse(name, {"request": request})


# Plain `def`: rendering stats every bundled file to version its URL.
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return _render(request, "index.html")


@app.get("/view", response_class=HTMLResponse)
def view(request: Request):
    return _render(request, "view.html")


@app.get("/bundle/{digest}/{name}")
def bundle(digest: str, name: str, request: Request):
    b = assets.get(name)
    if b is None:
        raise HTTPException(status_code=404)
    etag = f'"{b.digest}"'
    # A stale digest (an old page asking for a since-edited bundle) gets the
    # current content, but must not be cached as if it were that version.
    headers = {
        "Cache-Control": assets.IMMUTABLE if digest == b.digest else "no-cache",
        "ETag": etag,
        "Vary": "Accept-Encoding",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        return Response(b.gz, media_type=b.media_type, headers=headers)
    return Response(b.body, media_type=b.media_type, headers=headers)


app.include_router(router)
