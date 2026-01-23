<div align="center">
<h1>cli code log</h1>
<p>
A lightweight, local-first web app to browse, inspect, and export logs from
CLI-based AI coding agents — Claude Code, OpenAI Codex, and Gemini CLI.
</p>

<p>
  <a href="#features">Features</a> •
  <a href="#supported-tools">Supported Tools</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#screenshots">Screenshots</a>
</p>

<p>
  <img src="https://img.shields.io/badge/Python-3.7+-blue.svg" alt="Python 3.7+" />
  <img src="https://img.shields.io/badge/Flask-2.0+-green.svg" alt="Flask" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License MIT" />
  <a href="http://makeapullrequest.com">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" />
  </a>
</p>
</div>

![Gemini CLI Screenshot](screenshots/dark.png)

---

## Features

- **Multi-source support** — View logs from Claude Code, OpenAI Codex, and Gemini CLI
- **Three-panel layout** — Projects → Sessions → Conversation
- **Auto-sync** — Backs up data from source directories every hour
- **Export** — Download any session as a `.txt` file
- **Theme support** — Light (soft blue) and Dark modes
- **Rich display** — User/assistant messages, thinking blocks, tool usage, token stats
- **Search** — Quickly find projects and sessions

---

## Supported Tools

| Tool | Source Directory | Status |
|------|------------------|--------|
| **Claude Code** | `~/.claude/projects/` | ✅ Supported |
| **OpenAI Codex** | `~/.codex/sessions/` | ✅ Supported |
| **Gemini CLI** | `~/.gemini/tmp/` | ✅ Supported |

### Claude Code

- Sessions organized by project directory
- Displays summaries, messages, thinking blocks, and tool usage
- Shows model metadata and token usage

### OpenAI Codex

- Sessions organized by date (`YYYY/MM/DD/`)
- Groups sessions by working directory (cwd) as projects
- Displays messages, function calls, and reasoning blocks
- Filters out system prompts for cleaner inspection

### Gemini CLI

- Sessions stored as JSON files in `{hash}/chats/session-*.json`
- Groups sessions by project hash
- Displays messages, thoughts (thinking), and tool calls
- Shows token usage (input, output, cached)

---

## Installation

### Via pip (Recommended)

```bash
pip install clicodelog
```

### From source

```bash
git clone https://github.com/monk1337/clicodelog.git
cd clicodelog
pip install -e .
```

---

## Usage

If installed via pip:

```bash
clicodelog
```

Or run directly from source:

```bash
./run.sh
```

Or manually:

```bash
pip install -r requirements.txt
python app.py
```

Open http://localhost:5050 in your browser, or another port if it's busy.

### CLI Options

```
clicodelog --help
clicodelog --port 8080        # Run on custom port
clicodelog --host 0.0.0.0     # Bind to all interfaces
clicodelog --no-sync          # Skip initial data sync
clicodelog --debug            # Run in debug mode
```

---

## How It Works

- **Startup sync** — Copies logs from source directories into local `./data/`
- **Background sync** — Automatically refreshes every hour
- **Manual sync** — Trigger a sync for the active source via UI
- **Source switching** — Switch between Claude Code, Codex, and Gemini CLI

---

## Data Storage

```
data/
├── claude-code/          # Claude Code backup
│   ├── -Users-project1/
│   │   ├── session1.jsonl
│   │   └── session2.jsonl
│   └── -Users-project2/
├── codex/                # OpenAI Codex backup
│   └── 2026/
│       └── 01/
│           ├── 16/
│           │   └── rollout-xxx.jsonl
│           └── 17/
└── gemini/               # Gemini CLI backup
    ├── {project-hash-1}/
    │   └── chats/
    │       ├── session-2026-01-17T12-57-xxx.json
    │       └── session-2026-01-17T13-04-xxx.json
    └── {project-hash-2}/
```

---

## Controls

| Control | Action |
|---------|--------|
| Source dropdown | Switch between supported tools |
| 📥 Export | Download current session as .txt |
| 🔄 Sync | Manually refresh logs from source |
| ☀️ / 🌙 Theme | Toggle light/dark mode |

---

## Screenshots

| Light Mode | Dark Mode |
|------------|-----------|
| ![Light Mode](screenshots/light.png) | ![Dark Mode](screenshots/dark.png) |

---

## Project Structure

```
clicodelog/
├── app.py              # Flask backend (multi-source support)
├── run.sh              # Run script
├── requirements.txt    # Dependencies
├── data/               # Synced logs (auto-created)
│   ├── claude-code/
│   ├── codex/
│   └── gemini/
└── templates/
    └── index.html      # Frontend
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sources` | GET | List available sources |
| `/api/sources/<id>` | POST | Set active source |
| `/api/projects?source=` | GET | List projects |
| `/api/projects/<id>/sessions?source=` | GET | List sessions |
| `/api/projects/<id>/sessions/<id>?source=` | GET | Fetch session |
| `/api/sync?source=` | POST | Trigger sync |
| `/api/status?source=` | GET | Sync status |

---

## Requirements

- Python 3.7+
- Flask 2.0+
- flask-cors

---

## Adding New Sources

To add support for another CLI-based AI tool, update `app.py`:

```python
SOURCES = {
    "claude-code": {
        "name": "Claude Code",
        "source_dir": Path.home() / ".claude" / "projects",
        "data_subdir": "claude-code"
    },
    "codex": {
        "name": "OpenAI Codex",
        "source_dir": Path.home() / ".codex" / "sessions",
        "data_subdir": "codex"
    },
    "gemini": {
        "name": "Gemini CLI",
        "source_dir": Path.home() / ".gemini" / "tmp",
        "data_subdir": "gemini"
    },
    # Add new tool here
}
```

Then implement the corresponding parser for its log format.

---

## License

MIT

---

<div align="center">
<sub>Built for inspecting what AI coding agents actually did.</sub>
</div>

```

@misc{clicodelog2026,
  title = {clicodelog: Browse, inspect CLI-based AI coding agents},
  author = {Pal, Ankit},
  year = {2026},
  howpublished = {\url{https://github.com/monk1337/clicodelog}},
  note = {A lightweight, local-first web app to browse, inspect, and export logs from CLI-based AI coding agents — Claude Code, OpenAI Codex, and Gemini CLI.}
}

```

## 💁 Contributing

Welcome any contributions to open source project, including new features, improvements to infrastructure, and more comprehensive documentation. 
