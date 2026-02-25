import shutil
import threading
import time
from datetime import datetime

from .config import DATA_DIR, SOURCES, SYNC_INTERVAL
from .utils import get_codex_cwd, get_gemini_project_hash

sync_lock = threading.Lock()
last_sync_time: dict = {}
current_source: str = "claude-code"


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

        if dest_dir.exists():
            shutil.rmtree(dest_dir)

        shutil.copytree(source_dir, dest_dir)

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
