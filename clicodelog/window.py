"""Windowed reads of a Claude Code session, so a page costs page-sized memory.

Twelve files hold 61% of this corpus, and the largest is 966 MB / 89,823
messages. Parsing one whole session to show fifty messages peaked at 604 MB of
RSS and produced a 138 MB JSON body.

Instead we build a line-offset table once per (path, size, mtime): the byte
offset of every line that yields a message. The table is an array of 64-bit
ints — about 700 KB for 90,000 messages — so a page then seeks directly to its
own lines and parses only those. Opening a session is O(file) once for the
scan, and every page after that is O(page).
"""

import hashlib
import json
import threading
from array import array
from collections import OrderedDict
from pathlib import Path

from .logging_setup import get_logger
from .parsers.claude import build_message

log = get_logger(__name__)

_MAX_CACHED_TABLES = 6
_tables: "OrderedDict[tuple, dict]" = OrderedDict()
_lock = threading.Lock()


def _get_cached(key):
    with _lock:
        if key in _tables:
            _tables.move_to_end(key)
            return _tables[key]
    return None


def _put_cached(key, value):
    with _lock:
        _tables[key] = value
        _tables.move_to_end(key)
        while len(_tables) > _MAX_CACHED_TABLES:
            _tables.popitem(last=False)


def clear_cache() -> None:
    with _lock:
        _tables.clear()


def uuid_key(value: str) -> int:
    """A 63-bit digest of a message uuid.

    Storing the uuid strings themselves would cost ~17 MB on the largest
    session here; a parallel array of digests costs 8 bytes per message. A hit
    is confirmed by reading the message back, so a collision cannot mis-target.
    """
    if not value:
        return 0
    d = hashlib.blake2b(value.encode("utf-8", "ignore"), digest_size=8).digest()
    return int.from_bytes(d, "big") & 0x7FFFFFFFFFFFFFFF


def build_table(path: Path) -> dict:
    """Scan once, remembering where each message-bearing line starts.

    Nothing from the file is retained except offsets, uuid digests and the
    (small) summaries, so this stays flat in memory regardless of file size.
    """
    offsets = array("q")
    uuids = array("q")
    summaries: list = []
    pos = 0
    with open(path, "rb") as fh:
        for line in fh:
            start = pos
            pos += len(line)
            if not line.strip():
                continue
            # Cheap prefilter: skip json.loads on lines that cannot be messages.
            # The type field appears early in every record these tools write.
            head = line[:200]
            if b'"type"' not in head:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(entry, dict):
                continue
            etype = entry.get("type")
            if etype == "summary":
                s = entry.get("summary")
                if isinstance(s, str):
                    summaries.append(s)
            elif etype in ("user", "assistant"):
                offsets.append(start)
                u = entry.get("uuid")
                uuids.append(uuid_key(u) if isinstance(u, str) else 0)
    return {"offsets": offsets, "uuids": uuids, "summaries": summaries}


def index_of_uuid(path: Path, size: int, mtime: float, target: str) -> int:
    """Message index for a uuid, or -1. Used to jump straight to a bookmark."""
    if not target:
        return -1
    table = table_for(path, size, mtime)
    try:
        # array.index scans in C — fast enough to be imperceptible at 90k.
        return table["uuids"].index(uuid_key(target))
    except ValueError:
        return -1


def table_for(path: Path, size: int, mtime: float) -> dict:
    key = (str(path), size, mtime)
    table = _get_cached(key)
    if table is None:
        table = build_table(path)
        _put_cached(key, table)
    return table


def read_window(path: Path, size: int, mtime: float, offset: int,
                limit: int | None, tail: bool = False,
                center: int | None = None) -> tuple[list, int, list, int]:
    """Return (messages, total, summaries, start) for one page.

    tail=True reads the LAST `limit` messages — the viewer defaults to
    newest-first, so it needs the end of the conversation, not the beginning.
    center=<index> reads a window around that message, which is how a bookmark
    opens instantly instead of loading everything before it.
    """
    table = table_for(path, size, mtime)
    offsets = table["offsets"]
    total = len(offsets)

    if center is not None and limit is not None:
        start = max(0, min(center - limit // 2, max(0, total - limit)))
    elif tail and limit is not None:
        start = max(0, total - limit)
    else:
        start = max(0, min(offset, total))
    end = total if limit is None else min(start + max(0, limit), total)

    messages = []
    if start < end:
        with open(path, "rb") as fh:
            for i in range(start, end):
                fh.seek(offsets[i])
                line = fh.readline()
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(entry, dict):
                    continue
                try:
                    # tool_results is None: the viewer never renders tool output,
                    # and resolving it would require reading the whole file.
                    m = build_message(entry, None)
                except (AttributeError, TypeError):
                    continue
                if m:
                    messages.append(m)

    return messages, total, table["summaries"], start
