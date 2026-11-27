import ctypes
import ctypes.util
import os
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR, SOURCES, SYNC_INTERVAL
from .logging_setup import get_logger
from .storage import has_free_space

log = get_logger(__name__)


# --- APFS clonefile support ---------------------------------------------------
# On macOS/APFS we can clone files instead of byte-copying them. A clone shares
# the source's disk blocks copy-on-write, so backing up costs ~0 extra space
# until a file is modified. Since session logs are append-only/immutable, clones
# essentially never diverge — a multi-GB backup occupies almost no real disk.
_clonefile = None
if sys.platform == "darwin":
    try:
        _libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        _clonefile = _libc.clonefile
        _clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
        _clonefile.restype = ctypes.c_int
    except Exception:
        _clonefile = None


def _clone_or_copy(src: Path, dest: Path) -> bool:
    """Clone src -> dest (APFS COW) if possible, else copy. dest must not exist."""
    if _clonefile is not None:
        rc = _clonefile(str(src).encode(), str(dest).encode(), 0)
        if rc == 0:
            return True
        # Any failure (cross-device, unsupported) falls through to a real copy.
    try:
        shutil.copy2(src, dest)
        return True
    except OSError as e:
        log.warning("Could not copy %s -> %s: %s", src, dest, e)
        return False


def _place_atomically(src: Path, dest: Path) -> bool:
    """Write src's contents to dest via a temp file and os.replace.

    The previous implementation unlinked dest and then cloned. Two problems:
    readers hitting that window got a 500, and if the copy failed after the
    unlink the destination was simply gone — for a file the source tool had
    already pruned, that backup was the only remaining copy. Nothing is removed
    now until a complete replacement is in place.
    """
    tmp = dest.with_name(f".{dest.name}.tmp-sync")
    try:
        if tmp.exists():
            tmp.unlink()          # our own leftover temp, never user data
    except OSError:
        pass
    if not _clone_or_copy(src, tmp):
        return False
    try:
        os.replace(tmp, dest)     # atomic; readers see old or new, never neither
        return True
    except OSError as e:
        log.warning("Could not place %s: %s", dest, e)
        try:
            tmp.unlink()
        except OSError:
            pass
        return False


def _additive_copy(src: Path, dest: Path, stats: dict) -> None:
    """Recursively copy src -> dest, never deleting from dest.

    Files in dest that no longer exist in src are preserved, so deletions in the
    source (e.g. Claude Code pruning old projects) don't propagate to the local
    backup. Only files missing or differing in size/mtime are copied.
    """
    try:
        if src.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
            # scandir carries type info from the directory read, avoiding a
            # separate stat syscall per entry.
            with os.scandir(src) as it:
                for entry in it:
                    _additive_copy(Path(entry.path), dest / entry.name, stats)
            return
    except OSError as e:
        log.warning("Could not walk %s: %s", src, e)
        return

    try:
        s = src.stat()
    except OSError:
        return

    if dest.exists():
        try:
            d = dest.stat()
            if s.st_size == d.st_size and d.st_mtime >= s.st_mtime:
                stats["skipped"] += 1
                return
        except OSError:
            pass

    ok, free = has_free_space(dest.parent, s.st_size, margin=1.05)
    if not ok:
        stats["skipped_no_space"] += 1
        if not stats.get("_warned_space"):
            stats["_warned_space"] = True
            log.warning("Low disk (%.0f MB free) — skipping copies that would not fit. "
                        "Existing backups are untouched.", free / 1e6)
        return

    if _place_atomically(src, dest):
        stats["copied"] += 1
    else:
        stats["failed"] += 1


sync_lock = threading.Lock()
last_sync_time: dict = {}
current_source: str = "claude-code"
# Optional case-insensitive substring; when set, the projects API only returns
# folders whose id/name contains it (CLI: --folder <name>). None = show all.
folder_filter: str | None = None
initial_sync_done: bool = False


def sync_data(source_id: str | None = None, silent: bool = False,
              *, refresh: bool = True) -> bool:
    """Copy data from a source directory into ~/.clicodelog/data/{source}/."""
    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        log.error("Unknown source: %s", source_id)
        return False

    source_config = SOURCES[source_id]
    source_dir = source_config["source_dir"]
    dest_dir = DATA_DIR / source_config["data_subdir"]

    if not source_dir.exists():
        log.info("Source directory not found: %s", source_dir)
        return False

    stats = {"copied": 0, "skipped": 0, "failed": 0, "skipped_no_space": 0}
    started = time.monotonic()

    # The lock covers the copy only. Counting and indexing used to run inside it
    # too, so a POST /api/sync could block on a background sync for its whole
    # duration.
    with sync_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log.info("Syncing %s from %s", source_config["name"], source_dir)
        _additive_copy(source_dir, dest_dir, stats)

    last_sync_time[source_id] = datetime.now()

    counts = {}
    if refresh:
        # The index refresh walks the tree anyway, so take the counts from it
        # instead of doing a second (and for codex, file-opening) pass.
        try:
            from .search_index import refresh_index
            counts = refresh_index(source_id).get(source_id, {})
        except Exception:
            log.exception("Index refresh failed after syncing %s", source_id)

    if stats["failed"] or stats["skipped_no_space"]:
        log.warning("Sync %s: %d copied, %d failed, %d skipped for space",
                    source_id, stats["copied"], stats["failed"], stats["skipped_no_space"])

    msg = (f"Sync {source_config['name']}: {counts.get('projects', '?')} projects, "
           f"{counts.get('sessions', '?')} sessions, {stats['copied']} new files "
           f"in {time.monotonic() - started:.1f}s")
    log.info(msg)
    if not silent:
        print(f"  {msg}")
    return True


def background_sync():
    """Background thread: syncs all sources every SYNC_INTERVAL seconds."""
    while True:
        time.sleep(SYNC_INTERVAL)
        for source_id in SOURCES:
            try:
                sync_data(source_id=source_id, silent=True)
            except Exception:
                log.exception("Background sync failed for %s", source_id)
        # A sync re-reads changed files; let the reaper give that memory back.
        from . import reaper
        reaper.note_background_work()


def initial_sync(skip: bool = False):
    """Run the startup sync off the request path.

    This used to run synchronously before uvicorn bound its port — 9.8 seconds
    of blank terminal, and minutes on a first run. The data directory already
    holds the previous run's copy, so the UI is fully usable while this happens.
    """
    global initial_sync_done
    try:
        if not skip:
            for source_id in SOURCES:
                try:
                    sync_data(source_id=source_id, silent=True)
                except Exception:
                    log.exception("Initial sync failed for %s", source_id)
        else:
            from .search_index import refresh_index
            refresh_index()
    except Exception:
        log.exception("Initial sync/refresh failed")
    finally:
        initial_sync_done = True
        log.info("Initial sync complete")
