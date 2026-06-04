import ctypes
import ctypes.util
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR, SOURCES, SYNC_INTERVAL
from .utils import get_codex_cwd, get_gemini_project_hash


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


def _clone_or_copy(src: Path, dest: Path) -> None:
    """Clone src → dest (APFS COW) if possible, else fall back to copy2."""
    if _clonefile is not None:
        # clonefile fails if dest already exists, so caller guarantees it doesn't.
        rc = _clonefile(str(src).encode(), str(dest).encode(), 0)
        if rc == 0:
            return
        # Any failure (cross-device, unsupported) → fall through to a real copy.
    shutil.copy2(src, dest)


def _additive_copy(src: Path, dest: Path) -> None:
    """Recursively copy src → dest, never deleting from dest.

    Files in dest that no longer exist in src are preserved (so deletions in
    the source — e.g. Claude Code pruning old projects — don't propagate to
    our local backup). For each source file, only copy when the destination
    is missing or differs in size/mtime, so re-syncs are cheap. New files are
    cloned (APFS) when possible so the backup costs almost no extra disk.
    """
    if not src.exists():
        return
    if src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            _additive_copy(entry, dest / entry.name)
        return
    if dest.exists():
        try:
            s = src.stat()
            d = dest.stat()
            if s.st_size == d.st_size and d.st_mtime >= s.st_mtime:
                return
        except OSError:
            pass
        # Content changed: replace so we can clone afresh.
        try:
            dest.unlink()
        except OSError:
            shutil.copy2(src, dest)
            return
    _clone_or_copy(src, dest)

sync_lock = threading.Lock()
last_sync_time: dict = {}
current_source: str = "claude-code"
# Optional case-insensitive substring; when set, the projects API only returns
# folders whose id/name contains it (CLI: --folder <name>). None = show all.
folder_filter: str | None = None


def sync_data(source_id: str | None = None, silent: bool = False) -> bool:
    """Copy data from source directory to ~/.clicodelog/data/{source}/."""
    global last_sync_time

    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        if not silent:
            print(f"Unknown source: {source_id}")
        return False

    source_config = SOURCES[source_id]
    source_dir = source_config["source_dir"]
    dest_dir = DATA_DIR / source_config["data_subdir"]

    with sync_lock:
        if not source_dir.exists():
            if not silent:
                print(f"Source directory not found: {source_dir}")
            return False

        DATA_DIR.mkdir(parents=True, exist_ok=True)

        if not silent:
            print(f"Syncing {source_config['name']} from {source_dir} to {dest_dir}...")

        # Additive sync: copy new/updated files into dest, but never delete
        # from dest. If Claude (or another tool) removes a project upstream,
        # we keep our local copy. This trades a little disk space for the
        # ability to recover sessions the source has pruned.
        _additive_copy(source_dir, dest_dir)

        if source_id == "claude-code":
            project_count = sum(1 for p in dest_dir.iterdir() if p.is_dir())
            session_count = sum(1 for p in dest_dir.iterdir() if p.is_dir() for _ in p.rglob("*.jsonl"))
        elif source_id == "codex":
            session_files = list(dest_dir.rglob("*.jsonl"))
            session_count = len(session_files)
            project_count = len(set(get_codex_cwd(f) for f in session_files if get_codex_cwd(f)))
        else:  # gemini
            session_files = list(dest_dir.rglob("chats/session-*.json"))
            session_count = len(session_files)
            project_count = len(set(get_gemini_project_hash(f) for f in session_files if get_gemini_project_hash(f)))

        last_sync_time[source_id] = datetime.now()

        # Keep the search index current right after the data changes.
        try:
            from .search_index import refresh_index
            refresh_index(source_id)
        except Exception as e:
            if not silent:
                print(f"  (index refresh skipped: {e})")

        if not silent:
            print(f"Synced {project_count} projects with {session_count} sessions")
        else:
            ts = last_sync_time[source_id].strftime("%Y-%m-%d %H:%M:%S")
            print(f"[{ts}] Background sync ({source_config['name']}): {project_count} projects, {session_count} sessions")

        return True


def background_sync():
    """Background thread: syncs all sources every SYNC_INTERVAL seconds."""
    while True:
        time.sleep(SYNC_INTERVAL)
        for source_id in SOURCES:
            try:
                sync_data(source_id=source_id, silent=True)
            except Exception as e:
                print(f"[Background sync error for {source_id}] {e}")
