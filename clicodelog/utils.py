import base64
import json


def encode_path_id(path: str) -> str:
    return base64.urlsafe_b64encode(path.encode()).decode().rstrip("=")


def decode_path_id(encoded_id: str) -> str:
    padding = 4 - len(encoded_id) % 4
    if padding != 4:
        encoded_id += "=" * padding
    return base64.urlsafe_b64decode(encoded_id.encode()).decode()


def get_codex_cwd(session_file) -> str | None:
    """Extract cwd from a Codex session file for project grouping."""
    try:
        with open(session_file, "r") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if entry.get("type") == "session_meta":
                        return entry.get("payload", {}).get("cwd", "")
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return None


def get_gemini_project_hash(session_file) -> str | None:
    """Extract projectHash from a Gemini session file for project grouping."""
    try:
        with open(session_file, "r") as f:
            data = json.load(f)
            return data.get("projectHash", "")
    except Exception:
        pass
    return None
