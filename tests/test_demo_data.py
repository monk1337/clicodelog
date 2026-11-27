"""The README screenshots are built from scripts/demo_data.py. Keep it working,
and keep it obviously synthetic."""

import json
import runpy
from pathlib import Path

from clicodelog.scan import scan_session

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "demo_data.py"


def test_demo_home_is_complete_and_synthetic(tmp_path):
    demo = runpy.run_path(str(SCRIPT))
    home = tmp_path / "home"
    demo["main"](home)

    data = home / ".clicodelog" / "data" / "claude-code"
    files = sorted(data.rglob("*.jsonl"))
    assert len(files) >= 20
    for f in files:
        for line in f.read_text().splitlines():
            rec = json.loads(line)
            cwd = rec.get("cwd") or "/Users/demo/"
            assert cwd.startswith("/Users/demo/"), cwd

    infos = {f: scan_session(f, "claude-code") for f in files}
    assert all(i is not None for i in infos.values())
    featured = [f for f, i in infos.items() if i and i["summary"].startswith("Customers say")]
    assert len(featured) == 1
    info = infos[featured[0]]
    assert info is not None
    assert info["message_count"] > 10 and info["usage"]["cache_read"] > 0

    bookmarks = json.loads((home / ".clicodelog" / "bookmarks.json").read_text())
    assert {b["session_id"] for b in bookmarks} == {featured[0].stem}
    assert (home / ".claude" / "projects").is_dir()
