from pathlib import Path

PACKAGE_DIR = Path(__file__).parent

APP_DATA_DIR = Path.home() / ".clicodelog"
DATA_DIR = APP_DATA_DIR / "data"
PROJECT_META_FILE = APP_DATA_DIR / "project_meta.json"

SYNC_INTERVAL = 3600  # seconds

SOURCES = {
    "claude-code": {
        "name": "Claude Code",
        "source_dir": Path.home() / ".claude" / "projects",
        "data_subdir": "claude-code",
    },
    "codex": {
        "name": "OpenAI Codex",
        "source_dir": Path.home() / ".codex" / "sessions",
        "data_subdir": "codex",
    },
    "gemini": {
        "name": "Google Gemini",
        "source_dir": Path.home() / ".gemini" / "tmp",
        "data_subdir": "gemini",
    },
}
