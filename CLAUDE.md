# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install from source (editable, changes take effect immediately)
uv pip install -e .

# Run the app
clicodelog
# or without installing:
uv run python -m clicodelog.cli

# Common flags
clicodelog --port 8080      # custom port (default: 6126)
clicodelog --no-sync        # skip initial sync (faster startup for dev)
clicodelog --debug          # debug mode

# Build for distribution
uv build                    # produces dist/*.whl and dist/*.tar.gz
uv pip install dist/*.whl   # install the built wheel to test it
```

There are no automated tests. The `dev` extras (`pytest`, `build`, `twine`) are stubs only.

## Architecture

**clicodelog** is a local-first web app that syncs AI agent logs to `~/.clicodelog/data/` and serves them via a FastAPI browser UI.

### File map

```
clicodelog/
├── cli.py            # Argparse entry point → calls server.run_server()
├── app.py            # FastAPI app setup, mounts /static, registers router (~30 lines)
├── config.py         # SOURCES dict, DATA_DIR, APP_DATA_DIR, constants
├── sync.py           # sync_data(), background_sync(), sync state globals
├── utils.py          # encode/decode_path_id, get_codex_cwd, get_gemini_project_hash
├── projects.py       # get_projects(), get_sessions(), get_conversation(), project metadata
├── routes.py         # APIRouter with all /api/* handlers
├── server.py         # kill_process_on_port(), BANNER, run_server()
├── parsers/
│   ├── __init__.py
│   ├── claude.py     # parse_claude_conversation()
│   ├── codex.py      # parse_codex_conversation()
│   └── gemini.py     # parse_gemini_conversation()
├── static/
│   ├── style.css     # All CSS (served at /static/style.css)
│   └── app.js        # All frontend JS (served at /static/app.js)
└── templates/
    └── index.html    # Markup only (~100 lines)
```

The root `app.py` and `requirements.txt` are legacy Flask artifacts — ignore them.

### Data flow

1. **Sync** — `sync_data(source_id)` in `sync.py` copies files from the source tool's directory into `~/.clicodelog/data/{source}/`. Runs once on startup (unless `--no-sync`) and again every hour via a background thread.
2. **Projects** — `get_projects(source_id)` in `projects.py` reads the synced directory structure and returns grouped project objects. Grouping logic differs per source.
3. **Sessions** — `get_sessions(project_id, source_id)` lists JSONL/JSON files within a project directory, extracting metadata (message count, size, timestamps) without fully parsing.
4. **Conversation** — `get_conversation(project_id, session_id, source_id)` fully parses a session file through one of three source-specific parsers in `parsers/`.
5. **API** — FastAPI routes in `routes.py` expose the above as JSON endpoints. The frontend (`static/app.js`) calls these via `fetch()`.

### Source configurations

Each source is defined in the `SOURCES` dict in `config.py`:

| Key | Tool | Source dir | Data format | Project grouping |
|-----|------|-----------|-------------|-----------------|
| `claude-code` | Claude Code | `~/.claude/projects/` | JSONL | By subdirectory |
| `codex` | OpenAI Codex | `~/.codex/sessions/` | JSONL | By `cwd` field |
| `gemini` | Google Gemini | `~/.gemini/tmp/` | JSON | By `projectHash` |

To add a new source: add an entry to `SOURCES` in `config.py` and add a parser in `parsers/`.

### Mutable sync state

`sync.py` owns two module-level globals: `current_source` (str) and `last_sync_time` (dict). Routes mutate these via `import sync as _sync; _sync.current_source = value`.

### Frontend

`static/app.js` is a vanilla JS SPA (no build step). State lives in JS globals (`currentProjectId`, `currentSessionId`, `currentSource`, etc.). Theme and column widths persist to `localStorage`. All DOM manipulation uses DOM methods (`textContent`, `createElement`) — not `innerHTML` with dynamic data.

## File decomposition rules

**Max file size: ~300 lines.** When a file approaches this, split it before adding more. This applies to both Python and JS/CSS files.

For new sources, add:
- An entry to `SOURCES` in `config.py`
- A parser module `parsers/{source}.py`
- Export it from `parsers/__init__.py`
