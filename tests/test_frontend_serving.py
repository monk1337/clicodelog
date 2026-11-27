"""Serving the redesigned frontend: bundles, templates, the idle reaper, and the
rank-then-snippet content search."""

import gzip
import json
import re

import pytest
from fastapi.testclient import TestClient

from clicodelog import assets, fts, reaper
from clicodelog.app import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_every_bundled_file_exists():
    for name, files in assets.BUNDLES.items():
        for f in files:
            assert (assets.STATIC_DIR / f).is_file(), f"{name} lists missing file {f}"


def test_bundle_has_every_file_in_order():
    for name, files in assets.BUNDLES.items():
        body = assets.get(name).body
        positions = [body.index(f"/* --- {f} --- */".encode()) for f in files]
        assert positions == sorted(positions), f"{name} is out of order"


@pytest.mark.parametrize("page", ["/", "/view?source=claude-code&project=p&session=s"])
def test_pages_reference_versioned_bundles(client, page):
    r = client.get(page)
    assert r.status_code == 200
    html = r.text
    assert 'id="i-search"' in html, "icon sprite missing"
    assert "fonts.googleapis.com" not in html and "fontshare" not in html
    urls = re.findall(r'(?:src|href)="(/bundle/[0-9a-f]{16}/[\w.]+)"', html)
    assert len(urls) == 3, urls
    for url in urls:
        res = client.get(url)
        assert res.status_code == 200
        assert "immutable" in res.headers["cache-control"]


def test_stale_digest_is_served_but_not_cached(client):
    res = client.get("/bundle/0000000000000000/app.css")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-cache"


def test_bundle_revalidates_and_compresses(client):
    b = assets.get("app.js")
    url = f"/bundle/{b.digest}/app.js"
    assert client.get(url, headers={"If-None-Match": f'"{b.digest}"'}).status_code == 304
    raw = client.get(url, headers={"Accept-Encoding": "identity"})
    assert raw.content == b.body
    assert gzip.decompress(b.gz) == b.body


def test_unknown_bundle_is_404(client):
    assert client.get("/bundle/0000000000000000/nope.js").status_code == 404


def test_focus_page_has_no_usage_dialog(client):
    html = client.get("/view?source=claude-code&project=p&session=s").text
    assert 'id="stats-modal"' not in html
    assert 'id="stats-modal"' in client.get("/").text


def test_passive_polls_do_not_count_as_activity(monkeypatch):
    monkeypatch.setattr(reaper, "_in_flight", 0)
    monkeypatch.setattr(reaper, "_dirty", False)
    reaper.request_started("/api/status")
    assert reaper._in_flight == 0 and reaper._dirty is False
    reaper.request_started("/api/projects")
    assert reaper._in_flight == 1 and reaper._dirty is True
    reaper.request_finished("/api/projects")
    assert reaper._in_flight == 0


def test_trim_clears_parsed_conversations():
    from clicodelog import conversation
    conversation._cache_put(("k",), {"messages": []})
    reaper.trim("test")
    assert conversation._cache_get(("k",)) is None


# ------------------------------------------------------------- content search
CLAUDE = [
    {"type": "user", "timestamp": "2026-08-01T10:00:00Z", "uuid": "u1",
     "message": {"role": "user", "content": "the parser throws an error on empty input"}},
    {"type": "assistant", "timestamp": "2026-08-01T10:00:05Z", "uuid": "a1",
     "message": {"role": "assistant", "content": [
         {"type": "text", "text": "The error comes from the tokenizer; fixing the error path."}]}},
    {"type": "user", "timestamp": "2026-08-01T10:01:00Z", "uuid": "u2",
     "message": {"role": "user", "content": "now the error is gone, thanks"}},
]


@pytest.fixture
def content_index(tmp_path, monkeypatch):
    monkeypatch.setattr(fts, "DB_FILE", tmp_path / "fts.db")
    for key in ("rw", "ro"):
        if hasattr(fts._local, key):
            getattr(fts._local, key).close()
            delattr(fts._local, key)
    session = tmp_path / "sess-1.jsonl"
    session.write_text("\n".join(json.dumps(r) for r in CLAUDE) + "\n")
    conn = fts._connect()
    fts._ensure_schema(conn)
    fts._index_file(conn, session, "claude-code", "proj", "/Users/x/proj", fts.DEFAULT_TOOL_CAP)
    conn.commit()
    from clicodelog import search_index
    monkeypatch.setattr(search_index, "summaries_for", lambda *a, **k: {})
    yield
    for key in ("rw", "ro"):
        if hasattr(fts._local, key):
            getattr(fts._local, key).close()
            delattr(fts._local, key)


def test_content_search_groups_ranks_and_snippets(content_index):
    out = fts.search_content("error", "claude-code")
    assert len(out) == 1
    s = out[0]
    assert s["session_id"] == "sess-1" and s["match_count"] == 3
    assert len(s["matches"]) == 3
    for m in s["matches"]:
        assert "_id" not in m
        hits = [p["t"] for p in m["snippet_parts"] if p["hit"]]
        assert hits and all(h.lower() == "error" for h in hits)
    # The message that says "error" twice ranks first.
    assert s["matches"][0]["uuid"] == "a1"


def test_content_search_filters_by_role(content_index):
    out = fts.search_content("error", "claude-code", role="user")
    assert {m["uuid"] for m in out[0]["matches"]} == {"u1", "u2"}
    assert fts.search_content("error", "codex") == []


def test_content_search_with_no_match_is_empty(content_index):
    assert fts.search_content("zebra", "claude-code") == []
