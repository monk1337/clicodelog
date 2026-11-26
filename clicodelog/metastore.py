"""SQLite-backed metadata store — the read model for listings and search.

Replaces a single in-memory dict of every session. That dict cost 68.6 MB of
resident RAM for 15,924 sessions and was fully loaded at startup, even though
clicking one project needs only that project's rows. Everything here is a
query: nothing is resident between requests, and a click reads only what it
displays.

Rows are keyed by file path and validated by (size, mtime), exactly as the JSON
index was, so refreshes stay incremental.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

from .config import APP_DATA_DIR, DATA_DIR, SOURCES
from .logging_setup import get_logger
from .scan import scan_session
from .storage import has_free_space
from .utils import encode_path_id

log = get_logger(__name__)

DB_FILE = APP_DATA_DIR / "meta.db"
SCHEMA_VERSION = 1

# Bump whenever scan.py starts extracting something differently. Rows are only
# re-read when a file's (size, mtime) changes, so without this an improved
# extractor would never reach sessions that are finished and no longer change.
#   2: titles skip Claude Code's "This session is being continued…" preamble.
#   3: ...and the "[Image: …]" / "[Request interrupted by user…]" markers.
SCAN_VERSION = 3

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS sessions(
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT,
  session_id TEXT,
  filename TEXT,
  cwd TEXT,
  summary TEXT,
  first_ts TEXT,
  last_ts TEXT,
  msg_count INTEGER,
  subagent_count INTEGER,
  size INTEGER,
  mtime REAL,
  modified TEXT,
  parent_session TEXT,          -- non-null for subagent transcripts
  u_input INTEGER DEFAULT 0,
  u_output INTEGER DEFAULT 0,
  u_cache_read INTEGER DEFAULT 0,
  u_cache_creation INTEGER DEFAULT 0,
  models TEXT,
  tools TEXT
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(source, project_id, mtime DESC);
CREATE INDEX IF NOT EXISTS sessions_parent  ON sessions(source, project_id, parent_session);
CREATE INDEX IF NOT EXISTS sessions_sid     ON sessions(source, session_id);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""

_local = threading.local()
_write_lock = threading.Lock()
_building: set = set()

COLUMNS = ("path", "source", "project_id", "project_name", "session_id", "filename",
           "cwd", "summary", "first_ts", "last_ts", "msg_count", "subagent_count",
           "size", "mtime", "modified", "parent_session",
           "u_input", "u_output", "u_cache_read", "u_cache_creation", "models", "tools")


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=20000")
    conn.executescript(SCHEMA)
    _local.conn = conn
    return conn


LIST_COLUMNS = ("path, source, project_id, project_name, session_id, filename, cwd, "
                "summary, first_ts, last_ts, msg_count, subagent_count, size, mtime, "
                "modified, parent_session, u_input, u_output, u_cache_read, "
                "u_cache_creation")


def _row_to_listing(r: sqlite3.Row) -> dict:
    """A listing row: everything the session list shows, and nothing else.

    The models/tools JSON columns are deliberately not selected or parsed here.
    They are only needed by analytics, and decoding them for 10,581 rows was
    most of the cost of opening a large project.
    """
    return {
        "session_id": r["session_id"],
        "filename": r["filename"],
        "project_id": r["project_id"],
        "project_name": r["project_name"],
        "cwd": r["cwd"] or "",
        "summary": r["summary"] or "",
        "first_ts": r["first_ts"],
        "last_ts": r["last_ts"],
        "msg_count": r["msg_count"] or 0,
        "subagent_count": r["subagent_count"] or 0,
        "size": r["size"] or 0,
        "mtime": r["mtime"] or 0,
        "modified": r["modified"],
        "full_path": r["path"],
        "usage": {
            "input": r["u_input"] or 0,
            "output": r["u_output"] or 0,
            "cache_read": r["u_cache_read"] or 0,
            "cache_creation": r["u_cache_creation"] or 0,
        },
    }


def _row_to_entry(r: sqlite3.Row) -> dict:
    """Full row, including the models/tools counters."""
    return {
        "session_id": r["session_id"],
        "filename": r["filename"],
        "project_id": r["project_id"],
        "project_name": r["project_name"],
        "cwd": r["cwd"] or "",
        "summary": r["summary"] or "",
        "first_ts": r["first_ts"],
        "last_ts": r["last_ts"],
        "msg_count": r["msg_count"] or 0,
        "subagent_count": r["subagent_count"] or 0,
        "size": r["size"] or 0,
        "mtime": r["mtime"] or 0,
        "modified": r["modified"],
        "full_path": r["path"],
        "usage": {
            "input": r["u_input"] or 0,
            "output": r["u_output"] or 0,
            "cache_read": r["u_cache_read"] or 0,
            "cache_creation": r["u_cache_creation"] or 0,
        },
        "models": json.loads(r["models"]) if r["models"] else {},
        "tools": json.loads(r["tools"]) if r["tools"] else {},
    }


# --------------------------------------------------------------------- walk
def session_files(source_id: str, data_dir: Path):
    """Yield (file, project_dir) for every session file of a source."""
    try:
        if source_id == "claude-code":
            for project_dir in data_dir.iterdir():
                if project_dir.is_dir():
                    for f in project_dir.rglob("*.jsonl"):
                        yield f, project_dir
        elif source_id == "codex":
            for f in data_dir.rglob("*.jsonl"):
                yield f, None
        else:
            # Gemini CLI writes .jsonl. The old glob asked for .json and matched
            # nothing, which is why this source silently reported no sessions.
            for f in data_dir.rglob("chats/session-*.jsonl"):
                yield f, None
    except OSError as e:
        log.warning("Could not walk %s: %s", data_dir, e)


def _row_for(source_id: str, f: Path, project_dir) -> tuple | None:
    info = scan_session(f, source_id)
    if info is None:
        return None

    parent = None
    if source_id == "claude-code":
        project_id = project_dir.name
        # The directory name is a lossy hash — Claude Code collapses "/", "_"
        # and "-" all into "-" — so the recorded cwd is authoritative.
        project_name = info["cwd"] or project_dir.name.replace("-", "/").lstrip("/")
        if f.parent != project_dir:
            # Sub-agent transcripts nest deeper than one level:
            #   <project>/<session-id>/subagents/agent-x.jsonl
            #   <project>/<session-id>/subagents/workflows/wf_.../agent-x.jsonl
            # Record the owning top-level SESSION, not the immediate folder —
            # storing f.parent.name gave "subagents" or a workflow id, which
            # matches no session, so 4,806 transcripts were hidden from the
            # session list and unreachable from the sub-agent expander.
            try:
                parent = f.relative_to(project_dir).parts[0]
            except ValueError:
                parent = f.parent.name
    elif source_id == "codex":
        cwd = info["cwd"]
        if not cwd:
            return None
        project_id = encode_path_id(cwd)
        project_name = cwd
    else:
        try:
            rel = f.relative_to(DATA_DIR / SOURCES["gemini"]["data_subdir"])
            project_id = rel.parts[0] if rel.parts else (info["gemini_hash"] or "unknown")
        except ValueError:
            project_id = info["gemini_hash"] or "unknown"
        project_name = project_id

    u = info["usage"]
    return (
        str(f), source_id, project_id, project_name, info["id"], info["filename"],
        info["cwd"], info["summary"], info["first_timestamp"], info["last_timestamp"],
        info["message_count"], info["subagent_count"], info["size"], info["mtime"],
        info["modified"], parent,
        u["input"], u["output"], u["cache_read"], u["cache_creation"],
        json.dumps(info["models"]) if info["models"] else None,
        json.dumps(info["tools"]) if info["tools"] else None,
    )


def refresh_index(source_id: str | None = None, *, force: bool = False) -> dict:
    """Incrementally refresh one source (or all). Only files whose (size, mtime)
    changed are re-read; rows for files gone from the backup are dropped."""
    sources = [source_id] if source_id else list(SOURCES.keys())
    result: dict = {}

    for sid in sources:
        if sid not in SOURCES:
            continue
        data_dir = DATA_DIR / SOURCES[sid]["data_subdir"]
        if not data_dir.exists():
            result[sid] = {"sessions": 0, "projects": 0, "changed": 0}
            continue

        with _write_lock:
            if sid in _building:
                continue
            _building.add(sid)
        try:
            result[sid] = _refresh_one(sid, data_dir, force)
        finally:
            with _write_lock:
                _building.discard(sid)
    return result


def _scan_version_current(conn, sid: str) -> bool:
    r = conn.execute("SELECT value FROM meta WHERE key=?",
                     (f"scan_version:{sid}",)).fetchone()
    return r is not None and r["value"] == str(SCAN_VERSION)


def _refresh_one(sid: str, data_dir: Path, force: bool) -> dict:
    conn = connect()
    started = time.monotonic()

    known = {}
    if not force:
        for r in conn.execute("SELECT path, size, mtime FROM sessions WHERE source=?", (sid,)):
            known[r["path"]] = (r["size"], r["mtime"])
    else:
        conn.execute("DELETE FROM sessions WHERE source=?", (sid,))
        conn.commit()

    # An outdated extractor re-reads every file once, but replaces rows in
    # place rather than deleting first, so listings stay populated meanwhile.
    rescan_all = bool(known) and not _scan_version_current(conn, sid)
    if rescan_all:
        log.info("Index %s: extraction changed (scan v%s); re-reading every session once",
                 sid, SCAN_VERSION)

    seen, batch, changed = set(), [], 0
    for f, project_dir in session_files(sid, data_dir):
        key = str(f)
        seen.add(key)
        try:
            st = f.stat()
        except OSError:
            continue
        prev = known.get(key)
        if (not rescan_all and prev
                and prev[0] == st.st_size and prev[1] == st.st_mtime):
            continue                                  # unchanged
        row = _row_for(sid, f, project_dir)
        if row:
            batch.append(row)
            changed += 1
        if len(batch) >= 500:
            _flush(conn, batch)
            batch = []

    _flush(conn, batch)

    gone = [p for p in known if p not in seen]
    if gone:
        conn.executemany("DELETE FROM sessions WHERE path=?", [(p,) for p in gone])
    # Every row now comes from the current extractor.
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                 (f"scan_version:{sid}", str(SCAN_VERSION)))
    conn.commit()

    counts = conn.execute(
        "SELECT count(*) s, count(DISTINCT project_id) p FROM sessions WHERE source=?",
        (sid,)).fetchone()

    if changed or gone:
        log.info("Index %s: %d sessions (%d rescanned, %d gone) in %.2fs",
                 sid, counts["s"], changed, len(gone), time.monotonic() - started)
    return {"sessions": counts["s"], "projects": counts["p"], "changed": changed}


def _flush(conn, batch):
    if not batch:
        return
    placeholders = ",".join("?" * len(COLUMNS))
    conn.executemany(
        f"INSERT OR REPLACE INTO sessions({','.join(COLUMNS)}) VALUES ({placeholders})",
        batch)
    conn.commit()


# --------------------------------------------------------------------- reads
def count(source_id: str) -> int:
    try:
        r = connect().execute("SELECT count(*) c FROM sessions WHERE source=?",
                              (source_id,)).fetchone()
        return r["c"] if r else 0
    except sqlite3.Error:
        return 0


def is_ready(source_id: str) -> bool:
    return count(source_id) > 0


def entry_for_session(source_id: str, project_id: str, session_id: str) -> dict | None:
    r = connect().execute(
        "SELECT * FROM sessions WHERE source=? AND project_id=? AND session_id=? LIMIT 1",
        (source_id, project_id, session_id)).fetchone()
    return _row_to_entry(r) if r else None


def project_session_count(source_id: str, project_id: str, *,
                          top_level_only: bool = True) -> int:
    sql = "SELECT count(*) c FROM sessions WHERE source=? AND project_id=?"
    if top_level_only:
        sql += " AND parent_session IS NULL"
    r = connect().execute(sql, (source_id, project_id)).fetchone()
    return r["c"] if r else 0


def sessions_for_project(source_id: str, project_id: str, *, top_level_only: bool = True,
                         limit: int | None = None, offset: int = 0) -> list:
    """Only this project's rows are read — the rest never enter memory."""
    sql = f"SELECT {LIST_COLUMNS} FROM sessions WHERE source=? AND project_id=?"
    params: list = [source_id, project_id]
    if top_level_only:
        sql += " AND parent_session IS NULL"
    sql += " ORDER BY mtime DESC"
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params += [limit, max(0, offset)]
    return [_row_to_listing(r) for r in connect().execute(sql, params)]


def subagent_sessions(source_id: str, project_id: str, session_id: str) -> list:
    return [_row_to_listing(r) for r in connect().execute(
        f"SELECT {LIST_COLUMNS} FROM sessions WHERE source=? AND project_id=? "
        f"AND parent_session=? ORDER BY mtime DESC",
        (source_id, project_id, session_id))]


def projects_for_source(source_id: str) -> list:
    """Aggregated in SQL — no per-session objects are built."""
    rows = connect().execute("""
        SELECT project_id AS id,
               count(*)   AS session_count,
               max(mtime) AS mtime
        FROM sessions WHERE source=? AND parent_session IS NULL
        GROUP BY project_id
    """, (source_id,)).fetchall()

    out = []
    for r in rows:
        # The newest session's cwd is the best display name for the project.
        nm = connect().execute(
            "SELECT project_name, cwd FROM sessions "
            "WHERE source=? AND project_id=? ORDER BY mtime DESC LIMIT 1",
            (source_id, r["id"])).fetchone()
        out.append({
            "id": r["id"],
            "name": (nm["cwd"] or nm["project_name"] or r["id"]) if nm else r["id"],
            "cwd": (nm["cwd"] if nm else "") or "",
            "session_count": r["session_count"],
            "_mtime": r["mtime"] or 0,
        })
    return out


def search_index(query: str, source_id: str, limit: int = 50) -> list:
    """Substring match over id / cwd / summary / project name, done in SQL."""
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{q.lower()}%"
    rows = connect().execute("""
        SELECT *, (lower(session_id) = lower(?)) AS exact
        FROM sessions
        WHERE source = ?
          AND (lower(session_id) LIKE ?
               OR lower(cwd) LIKE ?
               OR lower(summary) LIKE ?
               OR lower(project_name) LIKE ?)
        ORDER BY exact DESC, mtime DESC
        LIMIT ?
    """, (q, source_id, like, like, like, like, limit)).fetchall()

    return [{
        "project_id": r["project_id"],
        "session_id": r["session_id"],
        "project_name": r["project_name"],
        "cwd": r["cwd"] or "",
        "summary": r["summary"] or "",
        "last_ts": r["last_ts"],
        "msg_count": r["msg_count"] or 0,
    } for r in rows]


def iter_entries(source_id: str, batch: int = 500):
    """Stream every row for a source without materialising them all.

    Used by index builders and aggregation. Callers must not accumulate.
    """
    cur = connect().execute("SELECT * FROM sessions WHERE source=?", (source_id,))
    while True:
        rows = cur.fetchmany(batch)
        if not rows:
            return
        for r in rows:
            yield _row_to_entry(r)


def path_project_map(source_id: str) -> dict:
    """Small path -> (project_id, project_name) map for the FTS builder."""
    return {r["path"]: (r["project_id"], r["project_name"])
            for r in connect().execute(
                "SELECT path, project_id, project_name FROM sessions WHERE source=?",
                (source_id,))}


def summaries_for(source_id: str, keys: list) -> dict:
    """Summary/cwd for a specific set of (project_id, session_id) pairs."""
    if not keys:
        return {}
    out = {}
    conn = connect()
    for i in range(0, len(keys), 200):
        chunk = keys[i:i + 200]
        clause = " OR ".join("(project_id=? AND session_id=?)" for _ in chunk)
        params = [x for pair in chunk for x in pair]
        for r in conn.execute(
                f"SELECT project_id, session_id, summary, cwd, last_ts FROM sessions "
                f"WHERE source=? AND ({clause})", [source_id] + params):
            out[(r["project_id"], r["session_id"])] = {
                "summary": r["summary"] or "", "cwd": r["cwd"] or "",
                "last_ts": r["last_ts"],
            }
    return out


def usage_totals(source_id: str, project_id: str | None = None) -> dict:
    """Aggregate token usage in SQL rather than in Python."""
    sql = ("SELECT count(*) sessions, "
           "COALESCE(sum(u_input),0) i, COALESCE(sum(u_output),0) o, "
           "COALESCE(sum(u_cache_read),0) cr, COALESCE(sum(u_cache_creation),0) cc "
           "FROM sessions WHERE source=?")
    params: list = [source_id]
    if project_id:
        sql += " AND project_id=?"
        params.append(project_id)
    r = connect().execute(sql, params).fetchone()
    return {"sessions": r["sessions"], "input": r["i"], "output": r["o"],
            "cache_read": r["cr"], "cache_creation": r["cc"]}


def usage_by(source_id: str, group: str, project_id: str | None = None,
             limit: int = 400) -> list:
    """GROUP BY day or project, entirely in SQL."""
    if group == "day":
        key = "substr(COALESCE(last_ts, first_ts), 1, 10)"
    elif group == "project":
        key = "project_name"
    else:
        return []
    sql = (f"SELECT {key} AS k, count(*) sessions, "
           f"COALESCE(sum(u_input),0) i, COALESCE(sum(u_output),0) o, "
           f"COALESCE(sum(u_cache_read),0) cr, COALESCE(sum(u_cache_creation),0) cc "
           f"FROM sessions WHERE source=?")
    params: list = [source_id]
    if project_id:
        sql += " AND project_id=?"
        params.append(project_id)
    sql += f" GROUP BY k ORDER BY {'k DESC' if group == 'day' else '(i+o+cr+cc) DESC'} LIMIT ?"
    params.append(limit)

    return [{
        "key": r["k"] or "unknown",
        "sessions": r["sessions"],
        "usage": {"input": r["i"], "output": r["o"],
                  "cache_read": r["cr"], "cache_creation": r["cc"]},
        "total_tokens": r["i"] + r["o"] + r["cr"] + r["cc"],
    } for r in connect().execute(sql, params)]


def json_counter_totals(source_id: str, column: str, limit: int = 25) -> dict:
    """Sum the small JSON counter columns (models, tools) by streaming."""
    if column not in ("models", "tools"):
        return {}
    totals: dict = {}
    cur = connect().execute(
        f"SELECT {column} c FROM sessions WHERE source=? AND {column} IS NOT NULL",
        (source_id,))
    while True:
        rows = cur.fetchmany(500)
        if not rows:
            break
        for r in rows:
            try:
                for name, n in json.loads(r["c"]).items():
                    totals[name] = totals.get(name, 0) + n
            except (json.JSONDecodeError, AttributeError):
                continue
    return dict(sorted(totals.items(), key=lambda kv: -kv[1])[:limit])


def estimated_db_bytes() -> int:
    try:
        return DB_FILE.stat().st_size
    except OSError:
        return 0


def ensure_space_for_refresh() -> tuple[bool, int]:
    # ~1.5 KB per session row; refuse to start a build that cannot finish.
    total = sum(1 for sid in SOURCES
                for _ in session_files(sid, DATA_DIR / SOURCES[sid]["data_subdir"])
                if (DATA_DIR / SOURCES[sid]["data_subdir"]).exists())
    return has_free_space(APP_DATA_DIR, total * 1500)
