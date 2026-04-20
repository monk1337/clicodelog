from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import PACKAGE_DIR
from .routes import router

app = FastAPI(title="CLI Code Log", version="0.2.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(PACKAGE_DIR / "static")), name="static")

templates = Jinja2Templates(directory=str(PACKAGE_DIR / "templates"))


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # FastAPI/Starlette changed TemplateResponse to accept `request` first.
    # Support both the current and older call styles so fresh installs and
    # older environments render the index page correctly.
    try:
        return templates.TemplateResponse(request=request, name="index.html")
    except TypeError:
        return templates.TemplateResponse("index.html", {"request": request})


app.include_router(router)
