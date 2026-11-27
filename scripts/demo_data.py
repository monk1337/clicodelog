"""Build a synthetic HOME for README screenshots and demos.

Every project, session, path and message here is invented, so screenshots can
be taken and shared without exposing anyone's real history:

    python scripts/demo_data.py /tmp/clicodelog-demo
    HOME=/tmp/clicodelog-demo clicodelog --no-sync --no-browser --port 6200

Nothing outside the given directory is read or written.
"""

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

NS = uuid.UUID("6f1c9a52-3b7e-4c1d-9a8e-2b5d7c4e1f00")
MODEL = "claude-opus-4-5"
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def uid(*parts) -> str:
    return str(uuid.uuid5(NS, "/".join(str(p) for p in parts)))


def ts(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def usage(i: int, o: int, cr: int = 0, cc: int = 0) -> dict:
    return {"input_tokens": i, "output_tokens": o,
            "cache_read_input_tokens": cr, "cache_creation_input_tokens": cc}


class Session:
    def __init__(self, project: str, title: str, start: datetime, branch: str = "main"):
        self.project, self.sid, self.t = project, uid(project, title), start
        self.cwd = f"/Users/demo/code/{project}"
        self.branch, self.records, self.n = branch, [], 0

    def _base(self, kind: str, minutes: float) -> dict:
        self.t += timedelta(minutes=minutes)
        self.n += 1
        return {"type": kind, "timestamp": ts(self.t), "uuid": uid(self.sid, self.n),
                "sessionId": self.sid, "cwd": self.cwd, "gitBranch": self.branch}

    def user(self, text: str, minutes: float = 1) -> str:
        r = self._base("user", minutes)
        r["message"] = {"role": "user", "content": text}
        self.records.append(r)
        return r["uuid"]

    def assistant(self, text: str = "", thinking: str = "", tools=(), minutes: float = 0.5,
                  tokens=(1200, 400, 18000, 900)) -> str:
        r = self._base("assistant", minutes)
        blocks = []
        if thinking:
            blocks.append({"type": "thinking", "thinking": thinking})
        if text:
            blocks.append({"type": "text", "text": text})
        ids = []
        for name, inp in tools:
            ids.append(f"toolu_{uid(self.sid, self.n, name)[:20].replace('-', '')}")
            blocks.append({"type": "tool_use", "id": ids[-1], "name": name, "input": inp})
        r["message"] = {"role": "assistant", "model": MODEL, "usage": usage(*tokens), "content": blocks}
        self.records.append(r)
        for tid in ids:      # what the tools returned; the viewer folds these away
            res = self._base("user", 0.2)
            res["message"] = {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}
            self.records.append(res)
        return r["uuid"]

    def write(self, root: Path, subdir: str = "") -> Path:
        d = root / ("-Users-demo-code-" + self.project.replace("_", "-")) / subdir
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{self.sid if not subdir else 'agent-' + self.sid[:8]}.jsonl"
        f.write_text("\n".join(json.dumps(r) for r in self.records) + "\n")
        # The file's mtime is what "updated 2 days ago" is read from.
        os.utime(f, (self.t.timestamp(), self.t.timestamp()))
        return f


def featured(start: datetime) -> tuple:
    s = Session("acme-storefront", "checkout-rounding", start, branch="fix/checkout-rounding")
    first = s.user("Customers say the checkout total is sometimes a cent off from the cart. "
                   "Can you find out why and fix it?")
    s.assistant(thinking="Cart and checkout probably round at different points. Look at how "
                "line totals are rounded in both paths before touching anything.",
                tools=[("Grep", {"pattern": "toFixed|Math.round", "path": "src/pricing"}),
                       ("Read", {"file_path": f"{s.cwd}/src/pricing/total.ts"})])
    s.assistant("Found it. The cart rounds **each line** to cents before summing, while "
                "checkout sums the raw amounts and rounds **once** at the end:\n\n"
                "```ts\n// cart.ts\nconst subtotal = lines.reduce((s, l) => s + round2(l.price * l.qty), 0);\n\n"
                "// checkout.ts\nconst subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));\n```\n\n"
                "Three stickers at $0.335 come to **$1.01** in the cart and **$1.00** at checkout.",
                minutes=1)
    for k in range(3):
        s.user("run the pricing tests again", minutes=6)
        s.assistant(tools=[("Bash", {"command": "npm test -- pricing",
                                     "description": "Run the pricing test suite"})])
        s.assistant(f"{44 + k * 2} passed, {2 - k} failing — still the tax-on-subtotal cases."
                    if k < 2 else "All 48 pricing tests pass.", minutes=1)
    s.user("Can you make sure tax is computed on the rounded subtotal, not per line?", minutes=4)
    s.assistant(thinking="Tax per line compounds the same rounding error. Compute the subtotal "
                "in integer cents, then apply the rate once and round half-even.",
                tools=[("Edit", {"file_path": f"{s.cwd}/src/pricing/total.ts",
                                 "old_string": "lines.map(taxLine)",
                                 "new_string": "applyTax(subtotalCents, rate)"})])
    s.user("Summarize what changed so I can put it in the PR description.", minutes=5)
    summary = s.assistant(
        "## Fix: checkout total off by a cent\n\n"
        "All money math now happens in **integer cents**, and rounding happens exactly once.\n\n"
        "- `toCents()` converts prices on the way in; nothing downstream sees a float.\n"
        "- Cart and checkout share one `computeTotals()`, so they cannot drift again.\n"
        "- Tax is applied to the rounded subtotal, rounding half-even.\n\n"
        "| Case | Cart before | Checkout before | Both now |\n"
        "|---|---|---|---|\n"
        "| 3 × $0.335 | $1.01 | $1.00 | $1.01 |\n"
        "| 7 × $1.99 + 8.25% tax | $15.08 | $15.07 | $15.08 |\n\n"
        "```ts\nexport function computeTotals(lines: Line[], rate: number): Totals {\n"
        "  const subtotal = lines.reduce((s, l) => s + toCents(l.price) * l.qty, 0);\n"
        "  const tax = roundHalfEven(subtotal * rate);\n"
        "  return { subtotal, tax, total: subtotal + tax };\n}\n```\n\n"
        "Added regression tests for both cases; the suite is green (48/48).",
        minutes=1, tokens=(2400, 900, 52000, 1800))
    return s, first, summary


OTHER = {
    "acme-storefront": ["Add Stripe webhook retries with idempotency keys",
                        "Migrate product search to Postgres full-text search",
                        "Speed up the cart page by lazy-loading recommendations",
                        "Write end-to-end tests for guest checkout",
                        "Refactor pricing rules into a strategy table"],
    "data-pipeline": ["Why is the nightly orders DAG 40 minutes slower this week?",
                      "Backfill the warehouse orders table from the event log",
                      "Add data-quality checks to the revenue model"],
    "infra": ["Move the API to two availability zones with Terraform",
              "Rotate the database credentials without downtime",
              "Cut CI time: cache dependencies between jobs"],
    "mobile-app": ["Fix the iOS share sheet crash on iPad",
                   "Add offline mode to the order history screen"],
    "design-system": ["Build an accessible combobox component",
                      "Audit color contrast in the dark theme"],
    "ml-ranking": ["Evaluate the new ranking model against last month's baseline",
                   "Why did click-through drop after the feature-store migration?"],
    "cli-tools": ["Add shell completions for zsh and fish",
                  "Make the release script idempotent"],
}


def main(out: Path) -> None:
    root = out / ".clicodelog" / "data" / "claude-code"
    sessions = []
    s, first, summary = featured(NOW - timedelta(hours=2))
    sessions.append(s)
    for p_i, (project, titles) in enumerate(OTHER.items()):
        for t_i, title in enumerate(titles):
            start = NOW - timedelta(days=1 + p_i * 2 + t_i * 1.7, hours=t_i * 3)
            x = Session(project, title, start)
            x.user(title)
            for k in range(2 + (p_i * 3 + t_i * 5) % 9):
                x.assistant(f"Step {k + 1}: checked the relevant code and ran the tests.",
                            tools=[("Bash", {"command": "make test"})])
                x.user("keep going", minutes=3)
            x.assistant("Done — summary and next steps are above.")
            sessions.append(x)
    for x in sessions:
        x.write(root)
    # Two sub-agents under one session, to show the sub-agent expander.
    parent = sessions[1]
    for name in ("search-indexer", "benchmark-runner"):
        a = Session(parent.project, name, NOW - timedelta(days=1, hours=2))
        a.user(f"[{name}] index the product catalogue and report timings")
        a.assistant("Indexed 48,120 products in 6.2 s.")
        a.write(root, f"{parent.sid}/subagents")

    # Empty source folders, so each tool shows as installed.
    for src in (".claude/projects", ".codex/sessions", ".gemini/tmp"):
        (out / src).mkdir(parents=True, exist_ok=True)

    app = out / ".clicodelog"
    bm = [{"source": "claude-code", "project_id": "-Users-demo-code-acme-storefront",
           "session_id": s.sid, "uuid": u, "anchor": u, "msg_index": 0, "role": role,
           "timestamp": ts(NOW), "preview": text,
           "id": f"claude-code:-Users-demo-code-acme-storefront:{s.sid}:{u}",
           "created": ts(NOW)}
          for u, role, text in ((first, "user", "Customers say the checkout total is sometimes a cent off"),
                                (summary, "assistant", "Fix: checkout total off by a cent"))]
    (app / "bookmarks.json").write_text(json.dumps(bm, indent=2))
    meta = {"claude-code:-Users-demo-code-acme-storefront": {"tags": ["work"]},
            "claude-code:-Users-demo-code-data-pipeline": {"tags": ["work"]},
            "claude-code:-Users-demo-code-cli-tools": {"tags": ["oss"]}}
    (app / "project_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Demo HOME ready: {out}\n  HOME={out} clicodelog --no-sync --no-browser --port 6200")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python scripts/demo_data.py <empty-directory>")
    target = Path(sys.argv[1]).expanduser().resolve()
    if target.exists() and any(target.iterdir()):
        sys.exit(f"{target} is not empty; pass an empty or new directory")
    main(target)
