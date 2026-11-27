"""Static asset bundles.

The page used to load 10 stylesheets, 3 vendor scripts and 17 app scripts as
separate requests, plus two external font CDNs, and revalidated every one of
them on each load (Cache-Control: no-cache): 40 requests, queued six at a time.

Each bundle below is the same files concatenated in the same order, served
from a content-hashed URL with an immutable cache header. A repeat visit makes
no static requests at all, and editing any file changes the hash, so a refresh
still picks up the change at once. Bundles are rebuilt only when a file's
mtime or size changes, and are kept gzipped in memory.
"""

import gzip
import hashlib
import re
import threading
from typing import NamedTuple, Optional

from .config import PACKAGE_DIR

STATIC_DIR = PACKAGE_DIR / "static"

_CSS = ["variables", "base", "controls", "layout", "list", "tags", "conversation",
        "messages", "search", "misc", "organize"]

# Scripts share one global scope, so order is load order: state first, then
# helpers, then the modules that use them, then the page's own startup.
_CONVERSATION_JS = ["conv-data", "conv-list", "conv-edges", "conv-message", "conv-head",
                    "conv-view", "conversation", "bookmarks", "bookmarks-panel", "unique"]
_APP_JS = (["state", "utils", "theme", "keys", "tags", "sync", "router", "projects", "sessions"]
           + _CONVERSATION_JS + ["search", "stats", "clipboard", "idle", "resize", "main"])
_VIEW_JS = (["state", "utils", "theme", "keys", "sync"]
            + _CONVERSATION_JS + ["search", "clipboard", "idle", "focus"])

BUNDLES = {
    "app.css": [f"css/{n}.css" for n in _CSS],
    "vendor.js": ["js/vendor/marked.min.js", "js/vendor/purify.min.js",
                  "js/vendor/highlight.min.js"],
    "app.js": [f"js/{n}.js" for n in _APP_JS],
    "view.js": [f"js/{n}.js" for n in _VIEW_JS],
}

IMMUTABLE = "public, max-age=31536000, immutable"

_SOURCE_MAP = re.compile(rb"^\s*//[#@] sourceMappingURL=.*$", re.M)


class Bundle(NamedTuple):
    digest: str
    body: bytes
    gz: bytes
    media_type: str


_lock = threading.Lock()
_built: dict = {}


def _stamp(files: list) -> tuple:
    out = []
    for f in files:
        st = (STATIC_DIR / f).stat()
        out.append((f, st.st_mtime_ns, st.st_size))
    return tuple(out)


def get(name: str) -> Optional[Bundle]:
    files = BUNDLES.get(name)
    if files is None:
        return None
    stamp = _stamp(files)
    with _lock:
        hit = _built.get(name)
        if hit and hit[0] == stamp:
            return hit[1]

    is_js = name.endswith(".js")
    parts = []
    for f in files:
        data = (STATIC_DIR / f).read_bytes()
        if is_js:
            # A vendor map comment would send devtools looking for a .map
            # next to the bundle. The ';' guards against a file whose last
            # statement lacks one running into the next file's first.
            data = _SOURCE_MAP.sub(b"", data)
        parts.append(b"/* --- " + f.encode() + b" --- */\n" + data.rstrip() +
                     (b"\n;\n" if is_js else b"\n"))
    body = b"".join(parts)
    bundle = Bundle(
        digest=hashlib.blake2b(body, digest_size=8).hexdigest(),
        body=body,
        gz=gzip.compress(body, compresslevel=6, mtime=0),
        media_type=("text/javascript" if is_js else "text/css") + "; charset=utf-8",
    )
    with _lock:
        _built[name] = (stamp, bundle)
    return bundle


def url(name: str) -> str:
    """The versioned URL a template uses for a bundle."""
    b = get(name)
    if b is None:
        raise KeyError(f"unknown bundle {name!r}")
    return f"/bundle/{b.digest}/{name}"
