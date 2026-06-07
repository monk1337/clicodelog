import json
from datetime import datetime

from .config import APP_DATA_DIR

BOOKMARKS_FILE = APP_DATA_DIR / "bookmarks.json"


def load_bookmarks() -> list:
    if BOOKMARKS_FILE.exists():
        try:
            with open(BOOKMARKS_FILE, "r") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            return []
    return []


def save_bookmarks(bookmarks: list) -> None:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(BOOKMARKS_FILE, "w") as f:
        json.dump(bookmarks, f, indent=2)


def _bid(b: dict) -> str:
    # Stable key: source + project + session + message anchor (uuid or index).
    anchor = b.get("uuid") or f"idx{b.get('msg_index')}"
    return f"{b.get('source')}:{b.get('project_id')}:{b.get('session_id')}:{anchor}"


def add_bookmark(b: dict) -> list:
    bookmarks = load_bookmarks()
    key = _bid(b)
    bookmarks = [x for x in bookmarks if _bid(x) != key]  # de-dup / replace
    b["id"] = key
    b.setdefault("created", datetime.now().isoformat())
    bookmarks.append(b)
    save_bookmarks(bookmarks)
    return bookmarks


def remove_bookmark(bid: str) -> list:
    bookmarks = [x for x in load_bookmarks() if x.get("id") != bid]
    save_bookmarks(bookmarks)
    return bookmarks
