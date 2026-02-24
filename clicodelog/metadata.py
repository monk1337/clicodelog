import json

from .config import APP_DATA_DIR, PROJECT_META_FILE


def load_project_meta() -> dict:
    if PROJECT_META_FILE.exists():
        try:
            with open(PROJECT_META_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_project_meta(meta: dict) -> None:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(PROJECT_META_FILE, "w") as f:
        json.dump(meta, f, indent=2)


def get_project_meta_key(project_id: str, source_id: str) -> str:
    return f"{source_id}:{project_id}"
