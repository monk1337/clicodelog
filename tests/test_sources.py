"""Per-source contract tests.

The check that matters: given a source directory with realistic files, the
pipeline must yield at least one session. Gemini failed exactly this for months
— six call sites globbed "chats/session-*.json" while the files on disk were
"*.jsonl", and the format had changed from one JSON object to JSON Lines. The
UI showed an empty project list, which looks identical to never having used the
tool, so nothing ever surfaced it.
"""

import json

import pytest

from clicodelog import metastore, search_index, sessions
from clicodelog.scan import scan_session

CLAUDE_LINES = [
    {"type": "summary", "summary": "Fix the CORS hole"},
    {"type": "user", "timestamp": "2026-08-01T10:00:00Z", "cwd": "/Users/x/my_app",
     "uuid": "u1", "message": {"role": "user", "content": "delete the middleware"}},
    {"type": "assistant", "timestamp": "2026-08-01T10:00:05Z", "uuid": "a1",
     "message": {"role": "assistant", "model": "claude-opus-4-8",
                 "usage": {"input_tokens": 10, "output_tokens": 20,
                           "cache_read_input_tokens": 5000,
                           "cache_creation_input_tokens": 100},
                 "content": [{"type": "text", "text": "Removing it now."},
                             {"type": "tool_use", "name": "Edit",
                              "input": {"file_path": "/Users/x/my_app/app.py"}}]}},
]

CODEX_LINES = [
    {"type": "session_meta", "timestamp": "2026-08-01T10:00:00Z",
     "payload": {"cwd": "/Users/x/proj"}},
    {"type": "response_item", "timestamp": "2026-08-01T10:00:01Z",
     "payload": {"role": "user", "content": [{"type": "input_text", "text": "hello"}]}},
    {"type": "response_item", "timestamp": "2026-08-01T10:00:02Z",
     "payload": {"role": "assistant", "content": [{"type": "output_text", "text": "hi"}]}},
    {"type": "event_msg", "timestamp": "2026-08-01T10:00:03Z",
     "payload": {"type": "token_count",
                 "info": {"total_token_usage": {"input_tokens": 100, "output_tokens": 50,
                                                "cached_input_tokens": 900}}}},
]

# Current Gemini CLI shape: header line, then $set mutations / bare records.
GEMINI_LINES = [
    {"sessionId": "s1", "projectHash": "abc123", "kind": "main",
     "startTime": "2026-08-01T10:00:00Z", "lastUpdated": "2026-08-01T10:05:00Z"},
    {"$set": {"messages": [
        {"id": "m1", "timestamp": "2026-08-01T10:00:01Z", "type": "user",
         "content": [{"text": "why is this slow"}]},
        {"id": "m2", "timestamp": "2026-08-01T10:00:02Z", "type": "gemini",
         "content": [{"text": "because it re-parses"}], "model": "gemini-2.0"},
    ]}},
    {"id": "m3", "timestamp": "2026-08-01T10:00:03Z", "type": "user",
     "content": [{"text": "fix it"}]},
]


def _write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")


@pytest.fixture
def fake_data(tmp_path, monkeypatch):
    """A data dir laid out like the real backup, for all three sources."""
    root = tmp_path / "data"
    _write_jsonl(root / "claude-code" / "-Users-x-my-app" / "sess-1.jsonl", CLAUDE_LINES)
    _write_jsonl(root / "codex" / "2026" / "08" / "rollout-1.jsonl", CODEX_LINES)
    _write_jsonl(root / "gemini" / "my_app" / "chats" / "session-2026-08-01.jsonl",
                 GEMINI_LINES)

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.metastore.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.sessions.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.projects.DATA_DIR", root)

    # Each test gets its own database file and its own thread-local connection.
    monkeypatch.setattr("clicodelog.metastore.DB_FILE", tmp_path / "meta.db")
    if hasattr(metastore._local, "conn"):
        metastore._local.conn.close()
        del metastore._local.conn
    yield root
    if hasattr(metastore._local, "conn"):
        metastore._local.conn.close()
        del metastore._local.conn


@pytest.mark.parametrize("source_id", ["claude-code", "codex", "gemini"])
def test_source_yields_at_least_one_session(fake_data, source_id):
    """The contract every source must meet, and the one Gemini silently broke."""
    result = search_index.refresh_index(source_id)
    assert result[source_id]["sessions"] >= 1, (
        f"{source_id}: files are on disk but nothing was indexed — "
        f"the log format has probably changed"
    )

    projects = search_index.projects_for_source(source_id)
    assert projects, f"{source_id}: indexed sessions produced no projects"

    page = sessions.get_sessions(projects[0]["id"], source_id)
    assert page["sessions"], f"{source_id}: project is indexed but lists no sessions"
    assert page["total"] >= 1
    assert page["sessions"][0]["message_count"] >= 1


def test_gemini_reads_jsonl_not_json(fake_data):
    """Regression guard: .jsonl extension AND JSON Lines content."""
    f = next((fake_data / "gemini").rglob("chats/session-*.jsonl"))
    info = scan_session(f, "gemini")
    assert info is not None
    assert info["message_count"] == 3          # 2 from $set + 1 appended
    assert info["gemini_hash"] == "abc123"


def test_claude_token_usage_includes_cache_fields(fake_data):
    """Summing only input+output under-reported real usage by ~116x."""
    f = next((fake_data / "claude-code").rglob("*.jsonl"))
    info = scan_session(f, "claude-code")
    u = info["usage"]
    assert u["input"] == 10 and u["output"] == 20
    assert u["cache_read"] == 5000, "cache reads must be counted"
    assert u["cache_creation"] == 100, "cache writes must be counted"
    assert sum(u.values()) == 5130


def test_codex_token_usage_is_captured(fake_data):
    """Codex token_count events used to be discarded entirely."""
    f = next((fake_data / "codex").rglob("*.jsonl"))
    info = scan_session(f, "codex")
    assert info["usage"]["input"] == 100
    assert info["usage"]["cache_read"] == 900


def test_edited_files_are_recorded(fake_data):
    f = next((fake_data / "claude-code").rglob("*.jsonl"))
    info = scan_session(f, "claude-code")
    assert "/Users/x/my_app/app.py" in info["files_touched"]


def test_project_name_comes_from_cwd_not_directory(fake_data):
    """Claude Code collapses "/", "_" and "-" all into "-", so the directory
    name cannot be decoded back to a path. The recorded cwd is authoritative."""
    search_index.refresh_index("claude-code")
    projects = search_index.projects_for_source("claude-code")
    assert projects[0]["name"] == "/Users/x/my_app"
    assert "my/app" not in projects[0]["name"]


def test_torn_final_line_does_not_break_a_session(tmp_path):
    """Sync copies files while the agent is still writing them."""
    p = tmp_path / "torn.jsonl"
    good = "\n".join(json.dumps(r) for r in CLAUDE_LINES)
    p.write_text(good + '\n{"type": "assistant", "message": {"cont')
    info = scan_session(p, "claude-code")
    assert info is not None
    assert info["message_count"] == 2


def test_non_dict_line_is_skipped(tmp_path):
    p = tmp_path / "odd.jsonl"
    p.write_text("null\n42\n" + json.dumps(CLAUDE_LINES[1]) + "\n")
    info = scan_session(p, "claude-code")
    assert info is not None and info["message_count"] == 1


def test_session_listing_is_paged(fake_data):
    """A project with 10,581 sessions must not return all of them at once."""
    search_index.refresh_index("claude-code")
    projects = search_index.projects_for_source("claude-code")
    pid = projects[0]["id"]

    page = sessions.get_sessions(pid, "claude-code", limit=1, offset=0)
    assert len(page["sessions"]) == 1
    assert page["total"] >= 1
    assert page["offset"] == 0


def test_listing_rows_omit_the_heavy_counter_columns(fake_data):
    """Listings must not decode the models/tools JSON — that was most of the
    cost of opening a large project."""
    search_index.refresh_index("claude-code")
    projects = search_index.projects_for_source("claude-code")
    rows = metastore.sessions_for_project("claude-code", projects[0]["id"])
    assert rows and "models" not in rows[0] and "tools" not in rows[0]
    # ...but the full accessor still has them, for analytics.
    full = next(metastore.iter_entries("claude-code"))
    assert "models" in full and "tools" in full


def test_nothing_is_resident_between_queries(fake_data):
    """The store must not keep a cache of every row."""
    search_index.refresh_index("claude-code")
    assert not hasattr(metastore, "_index"), "the in-memory index dict is gone"
    assert metastore.count("claude-code") >= 1


def test_deeply_nested_subagents_stay_reachable(tmp_path, monkeypatch):
    """Every session file must be reachable — as a top-level session or as a
    sub-agent of one.

    Sub-agent transcripts nest more than one level deep:
        <project>/<session-id>/subagents/agent-x.jsonl
        <project>/<session-id>/subagents/workflows/wf_.../agent-x.jsonl
    Keying them by their immediate parent folder recorded "subagents" or a
    workflow id, which matches no session — so they were filtered out of the
    session list AND unreachable from the expander. 4,806 real transcripts
    vanished that way.
    """
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    _write_jsonl(proj / "sess-1.jsonl", CLAUDE_LINES)
    _write_jsonl(proj / "sess-1" / "subagents" / "agent-a.jsonl", CLAUDE_LINES)
    _write_jsonl(proj / "sess-1" / "subagents" / "workflows" / "wf_abc" / "agent-b.jsonl",
                 CLAUDE_LINES)

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.metastore.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.sessions.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.metastore.DB_FILE", tmp_path / "meta.db")
    if hasattr(metastore._local, "conn"):
        metastore._local.conn.close()
        del metastore._local.conn
    try:
        search_index.refresh_index("claude-code")

        page = sessions.get_sessions("-Users-x-my-app", "claude-code")
        assert len(page["sessions"]) == 1, "only the top-level session belongs in the list"
        assert page["sessions"][0]["id"] == "sess-1"

        subs = sessions.get_subagent_sessions("-Users-x-my-app", "sess-1", "claude-code")
        ids = sorted(s["id"] for s in subs)
        assert ids == ["agent-a", "agent-b"], (
            f"both nesting depths must hang off their owning session, got {ids}"
        )

        # Nothing may be stranded: indexed == listed + reachable-as-subagent.
        total = metastore.count("claude-code")
        assert total == len(page["sessions"]) + len(subs) == 3
    finally:
        if hasattr(metastore._local, "conn"):
            metastore._local.conn.close()
            del metastore._local.conn


def _many_messages(n):
    rows = [{"type": "summary", "summary": "long session"}]
    for i in range(n):
        rows.append({
            "type": "user",
            "timestamp": f"2026-08-{(i % 28) + 1:02d}T10:00:00Z",
            "uuid": f"u{i}",
            "cwd": "/Users/x/my_app",
            "message": {"role": "user", "content": f"message {i}"},
        })
    return rows


def test_newest_first_reads_the_end_of_the_session(tmp_path, monkeypatch):
    """The viewer defaults to newest-first. Fetching offset 0 and reversing it
    showed the OLDEST page under a "Newest first" label — on a long session the
    recent conversation looked like it was simply missing."""
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    _write_jsonl(proj / "long.jsonl", _many_messages(500))

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    from clicodelog import conversation, window
    conversation.clear_cache()
    window.clear_cache()

    head = conversation.get_conversation("-Users-x-my-app", "long", "claude-code", limit=10)
    tail = conversation.get_conversation("-Users-x-my-app", "long", "claude-code",
                                         limit=10, tail=True)

    assert head["total_messages"] == 500
    assert head["offset"] == 0
    assert head["messages"][0]["content"] == "message 0"

    # The tail must be the LAST page, and must report where it starts so the
    # client can page backwards from there.
    assert tail["offset"] == 490, "tail must start at total - limit"
    assert tail["messages"][-1]["content"] == "message 499"
    assert tail["truncated"] is False

    # Paging backwards from the tail reaches the page before it.
    prev = conversation.get_conversation("-Users-x-my-app", "long", "claude-code",
                                         limit=10, offset=480)
    assert prev["messages"][-1]["content"] == "message 489"


def test_backward_paging_covers_the_session_exactly(tmp_path, monkeypatch):
    """The client pages backwards from the tail using `offset` + page length.

    Both must be in RAW message units. The renderer drops empty tool-result
    acknowledgements, so the displayed count is smaller than the window — using
    that shrunken number as the paging cursor meant the loaded range never
    reached the total, and the sentinel sat on "Loading more..." forever.
    """
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    rows = [{"type": "summary", "summary": "s"}]
    for i in range(250):
        rows.append({"type": "user", "timestamp": "2026-08-01T10:00:00Z", "uuid": f"u{i}",
                     "message": {"role": "user", "content": f"m{i}"}})
        # An empty protocol ack — real sessions are full of these, and they are
        # exactly what the renderer filters out.
        rows.append({"type": "user", "timestamp": "2026-08-01T10:00:00Z", "uuid": f"t{i}",
                     "message": {"role": "user", "content": [
                         {"type": "tool_result", "tool_use_id": f"x{i}", "content": "ok"}]}})
    _write_jsonl(proj / "long.jsonl", rows)

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    from clicodelog import conversation, window
    conversation.clear_cache()
    window.clear_cache()

    PAGE = 100
    first = conversation.get_conversation("-Users-x-my-app", "long", "claude-code",
                                          limit=PAGE, tail=True)
    total = first["total_messages"]
    assert total == 500

    # Walk backwards exactly as the client does, and confirm full coverage
    # with no gaps and no overlap.
    start, end = first["offset"], first["offset"] + len(first["messages"])
    assert end == total
    guard = 0
    while start > 0 and guard < 50:
        guard += 1
        want = min(PAGE, start)
        page = conversation.get_conversation("-Users-x-my-app", "long", "claude-code",
                                             limit=want, offset=start - want)
        assert page["offset"] == start - want, "server must honour the requested offset"
        assert len(page["messages"]) == want, "a full page must come back in raw units"
        start = page["offset"]
    assert start == 0, "backward paging must reach the beginning"
    assert end - start == total, "the walk must cover the session exactly once"


def test_bookmark_opens_on_a_window_centred_on_its_message(tmp_path, monkeypatch):
    """A bookmark used to reach its message by rendering the whole session
    first, which is unusable on a long conversation. The server now resolves the
    uuid and returns a small window centred on it."""
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    rows = [{"type": "summary", "summary": "s"}]
    for i in range(400):
        rows.append({"type": "user", "timestamp": "2026-08-01T10:00:00Z", "uuid": f"u{i}",
                     "message": {"role": "user", "content": f"m{i}"}})
    _write_jsonl(proj / "long.jsonl", rows)

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    from clicodelog import conversation, window
    conversation.clear_cache()
    window.clear_cache()

    conv = conversation.get_conversation("-Users-x-my-app", "long", "claude-code",
                                         limit=41, around_uuid="u300")
    assert conv["total_messages"] == 400
    assert conv["anchor_index"] == 300
    assert conv["offset"] == 280, "window must be centred on the anchor"
    assert len(conv["messages"]) == 41
    uuids = [m["uuid"] for m in conv["messages"]]
    assert "u300" in uuids
    # ~20 either side, which is what makes the jump instant.
    assert uuids[0] == "u280" and uuids[-1] == "u320"


def test_anchor_near_the_end_still_returns_a_full_window(tmp_path, monkeypatch):
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    rows = [{"type": "user", "timestamp": "2026-08-01T10:00:00Z", "uuid": f"u{i}",
             "message": {"role": "user", "content": f"m{i}"}} for i in range(100)]
    _write_jsonl(proj / "s.jsonl", rows)

    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    from clicodelog import conversation, window
    conversation.clear_cache()
    window.clear_cache()

    conv = conversation.get_conversation("-Users-x-my-app", "s", "claude-code",
                                         limit=21, around_uuid="u98")
    assert len(conv["messages"]) == 21, "a window near the end must not be truncated"
    assert conv["offset"] == 79
    assert conv["anchor_index"] == 98


def test_unknown_anchor_falls_back_without_error(tmp_path, monkeypatch):
    root = tmp_path / "data"
    proj = root / "claude-code" / "-Users-x-my-app"
    _write_jsonl(proj / "s.jsonl", CLAUDE_LINES)
    monkeypatch.setattr("clicodelog.config.DATA_DIR", root)
    monkeypatch.setattr("clicodelog.conversation.DATA_DIR", root)
    from clicodelog import conversation, window
    conversation.clear_cache()
    window.clear_cache()

    conv = conversation.get_conversation("-Users-x-my-app", "s", "claude-code",
                                         limit=10, around_uuid="does-not-exist")
    assert conv["anchor_index"] == -1
    assert "error" not in conv
    assert conv["messages"], "an unknown anchor must still return the session"
