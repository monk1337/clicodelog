"""Give memory back when nobody is using the app.

The server's footprint is mostly what it keeps to make the *next* request fast
(parsed conversations), plus heap the allocator holds on to after a burst.
Measured here: 14 MB at startup, 55 MB after reading through a 22,751-message
session. None of that helps anyone once the browser tab has been left alone.

After IDLE_SECONDS with no request in flight, this drops the parsed-
conversation cache, runs the collector and asks the C allocator to return free
pages to the OS: the server half of the tab discarding in static/js/idle.js.

Deliberately kept: the per-session line-offset tables (window.py). They are a
few hundred KB each, and rebuilding one means re-reading the whole session
file, which takes seconds for the largest sessions. Dropping them would trade a
trivial amount of memory for a slow first click.
"""

import ctypes
import gc
import os
import sys
import threading
import time

from .logging_setup import get_logger

log = get_logger(__name__)

IDLE_SECONDS = int(os.environ.get("CLICODELOG_IDLE_SECONDS", "300"))
CHECK_SECONDS = max(1, min(30, IDLE_SECONDS // 4))

# Polls that say nothing about anyone reading. If they counted, a visible tab
# polling once a minute would keep the server "busy" forever.
PASSIVE_PATHS = ("/api/status", "/api/search/status")

_lock = threading.Lock()
_in_flight = 0
_last_activity = time.monotonic()
_dirty = False          # something worth trimming happened since the last trim
_started = False


def _passive(path: str) -> bool:
    return path.startswith(PASSIVE_PATHS)


def request_started(path: str) -> None:
    global _in_flight, _last_activity, _dirty
    if _passive(path):
        return
    with _lock:
        _in_flight += 1
        _last_activity = time.monotonic()
        _dirty = True


def request_finished(path: str) -> None:
    global _in_flight, _last_activity
    if _passive(path):
        return
    with _lock:
        _in_flight = max(0, _in_flight - 1)
        _last_activity = time.monotonic()


def note_background_work() -> None:
    """A sync or an index build allocated; trim again once things are quiet."""
    global _dirty
    with _lock:
        _dirty = True


def _release_heap() -> bool:
    """Ask the C allocator to hand free pages back to the OS.

    Python returns its own small-object arenas when they empty, but anything
    larger came from malloc, which keeps freed pages for reuse indefinitely.
    """
    try:
        if sys.platform == "darwin":
            libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            relief = libc.malloc_zone_pressure_relief
            relief.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            relief.restype = ctypes.c_size_t
            relief(None, 0)            # every zone, as much as possible
            return True
        if sys.platform.startswith("linux"):
            ctypes.CDLL("libc.so.6").malloc_trim(0)
            return True
    except (OSError, AttributeError):
        pass
    return False


def trim(reason: str = "idle") -> None:
    from . import conversation
    conversation.clear_cache()
    gc.collect()
    released = _release_heap()
    log.info("Released idle memory (%s; allocator relief %s)", reason,
             "ok" if released else "unavailable")


def _loop() -> None:
    global _dirty
    while True:
        time.sleep(CHECK_SECONDS)
        with _lock:
            idle_for = time.monotonic() - _last_activity
            ready = _dirty and _in_flight == 0 and idle_for >= IDLE_SECONDS
            if ready:
                _dirty = False
        if ready:
            try:
                trim()
            except Exception:
                log.exception("Idle trim failed")


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="clicodelog-reaper", daemon=True).start()
