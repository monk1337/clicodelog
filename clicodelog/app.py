"""
AI Conversation History Viewer
A web app to browse and view Claude Code, OpenAI Codex, and Google Gemini conversation history.
Data is copied from source directories to ~/.ai-history-viewer/data/ for backup and local use.
Background sync runs every hour to keep data updated.
"""

import base64
import json
import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from flask_cors import CORS

# Package directory for templates
PACKAGE_DIR = Path(__file__).parent

# User data directory
APP_DATA_DIR = Path.home() / ".ai-history-viewer"
DATA_DIR = APP_DATA_DIR / "data"

# Sync interval in seconds (1 hour = 3600 seconds)
SYNC_INTERVAL = 3600

# Source configurations for different tools
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
        "name": "Google Gemini",
        "source_dir": Path.home() / ".gemini" / "tmp",
        "data_subdir": "gemini"
    }
}

# Lock for thread-safe sync operations
sync_lock = threading.Lock()
last_sync_time = {}  # Track per-source sync times
current_source = "claude-code"  # Default source

# Create Flask app with template folder from package
app = Flask(__name__, template_folder=str(PACKAGE_DIR / "templates"))
CORS(app)


def sync_data(source_id=None, silent=False):
    """Copy data from source directory to data dir for backup."""
    global last_sync_time

    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        if not silent:
            print(f"Unknown source: {source_id}")
        return False

    source_config = SOURCES[source_id]
    source_dir = source_config["source_dir"]
    dest_dir = DATA_DIR / source_config["data_subdir"]

    with sync_lock:
        if not source_dir.exists():
            if not silent:
                print(f"Source directory not found: {source_dir}")
            return False

        # Create data directory if it doesn't exist
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        # Copy source directory
        if not silent:
            print(f"Syncing {source_config['name']} data from {source_dir} to {dest_dir}...")

        if dest_dir.exists():
            # Remove old data and replace with fresh copy
            shutil.rmtree(dest_dir)

        shutil.copytree(source_dir, dest_dir)

        # Count what was copied
        if source_id == "claude-code":
            project_count = sum(1 for p in dest_dir.iterdir() if p.is_dir())
            session_count = sum(1 for p in dest_dir.iterdir() if p.is_dir() for _ in p.glob("*.jsonl"))
        elif source_id == "codex":
            session_files = list(dest_dir.rglob("*.jsonl"))
            session_count = len(session_files)
            # Count unique cwds as projects
            project_count = len(set(get_codex_cwd(f) for f in session_files if get_codex_cwd(f)))
        else:  # gemini - sessions are in {hash}/chats/session-*.json
            session_files = list(dest_dir.rglob("chats/session-*.json"))
            session_count = len(session_files)
            # Count unique project hashes as projects
            project_count = len(set(get_gemini_project_hash(f) for f in session_files if get_gemini_project_hash(f)))

        last_sync_time[source_id] = datetime.now()

        if not silent:
            print(f"Synced {project_count} projects with {session_count} sessions")
        else:
            print(f"[{last_sync_time[source_id].strftime('%Y-%m-%d %H:%M:%S')}] Background sync ({source_config['name']}): {project_count} projects, {session_count} sessions")

        return True


def get_codex_cwd(session_file):
    """Extract cwd from a Codex session file for grouping."""
    try:
        with open(session_file, 'r') as f:
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


def get_gemini_project_hash(session_file):
    """Extract projectHash from a Gemini session file for grouping."""
    try:
        with open(session_file, 'r') as f:
            data = json.load(f)
            return data.get("projectHash", "")
    except Exception:
        pass
    return None


def background_sync():
    """Background thread that syncs data every SYNC_INTERVAL seconds."""
    while True:
        time.sleep(SYNC_INTERVAL)
        for source_id in SOURCES:
            try:
                sync_data(source_id=source_id, silent=True)
            except Exception as e:
                print(f"[Background sync error for {source_id}] {e}")


def encode_path_id(path):
    """Encode a path as a safe ID using base64."""
    return base64.urlsafe_b64encode(path.encode()).decode().rstrip('=')


def decode_path_id(encoded_id):
    """Decode a base64-encoded path ID."""
    # Add back padding if needed
    padding = 4 - len(encoded_id) % 4
    if padding != 4:
        encoded_id += '=' * padding
    return base64.urlsafe_b64decode(encoded_id.encode()).decode()


def get_projects(source_id=None):
    """Get all project directories for the specified source."""
    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]

    if not data_dir.exists():
        return []

    projects = []

    if source_id == "claude-code":
        # Claude Code: projects are directories
        for project_dir in sorted(data_dir.iterdir()):
            if project_dir.is_dir():
                # Convert directory name back to readable path
                readable_name = project_dir.name.replace("-", "/").lstrip("/")
                sessions = list(project_dir.glob("*.jsonl"))
                projects.append({
                    "id": project_dir.name,
                    "name": readable_name,
                    "session_count": len(sessions),
                    "path": str(project_dir)
                })
    elif source_id == "codex":
        # Codex: group sessions by cwd
        session_files = list(data_dir.rglob("*.jsonl"))
        cwd_sessions = {}

        for session_file in session_files:
            cwd = get_codex_cwd(session_file)
            if cwd:
                if cwd not in cwd_sessions:
                    cwd_sessions[cwd] = []
                cwd_sessions[cwd].append(session_file)

        for cwd, sessions in sorted(cwd_sessions.items()):
            # Create a safe ID from the cwd path using base64 encoding
            project_id = encode_path_id(cwd)
            projects.append({
                "id": project_id,
                "name": cwd,
                "session_count": len(sessions),
                "path": cwd
            })
    else:  # gemini
        # Gemini: group sessions by projectHash
        session_files = list(data_dir.rglob("chats/session-*.json"))
        hash_sessions = {}

        for session_file in session_files:
            project_hash = get_gemini_project_hash(session_file)
            if project_hash:
                if project_hash not in hash_sessions:
                    hash_sessions[project_hash] = []
                hash_sessions[project_hash].append(session_file)

        for project_hash, sessions in sorted(hash_sessions.items()):
            # Use the hash as ID, show shortened hash as name
            projects.append({
                "id": project_hash,
                "name": f"Project {project_hash[:8]}...",
                "session_count": len(sessions),
                "path": str(data_dir / project_hash)
            })

    return projects


def get_sessions(project_id, source_id=None):
    """Get all sessions for a project."""
    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        return []

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]

    if source_id == "claude-code":
        project_dir = data_dir / project_id
        if not project_dir.exists():
            return []
        session_files = sorted(project_dir.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)
    elif source_id == "codex":
        # Decode the project_id to get the actual cwd
        try:
            target_cwd = decode_path_id(project_id)
        except Exception:
            return []

        all_sessions = list(data_dir.rglob("*.jsonl"))
        session_files = [f for f in all_sessions if get_codex_cwd(f) == target_cwd]
        session_files = sorted(session_files, key=lambda x: x.stat().st_mtime, reverse=True)
    else:  # gemini
        # project_id is the projectHash
        all_sessions = list(data_dir.rglob("chats/session-*.json"))
        session_files = [f for f in all_sessions if get_gemini_project_hash(f) == project_id]
        session_files = sorted(session_files, key=lambda x: x.stat().st_mtime, reverse=True)

    sessions = []
    for session_file in session_files:
        session_info = parse_session_info(session_file, source_id)
        if session_info:
            sessions.append(session_info)

    return sessions


def parse_session_info(session_file, source_id):
    """Parse session file to extract metadata."""
    first_summary = None
    message_count = 0
    first_timestamp = None
    last_timestamp = None
    first_user_message = None

    try:
        if source_id == "gemini":
            # Gemini uses regular JSON files
            with open(session_file, 'r') as f:
                data = json.load(f)
                first_timestamp = data.get("startTime")
                last_timestamp = data.get("lastUpdated")
                messages = data.get("messages", [])
                for msg in messages:
                    msg_type = msg.get("type")
                    if msg_type in ("user", "gemini"):
                        message_count += 1
                        if msg_type == "user" and not first_user_message:
                            content = msg.get("content", "")
                            if isinstance(content, str) and len(content) < 500:
                                first_user_message = content[:100]
        else:
            # JSONL format for claude-code and codex
            with open(session_file, 'r') as f:
                for line in f:
                    try:
                        entry = json.loads(line)

                        if source_id == "claude-code":
                            if entry.get("type") == "summary" and not first_summary:
                                first_summary = entry.get("summary", "")
                            if entry.get("timestamp"):
                                if not first_timestamp:
                                    first_timestamp = entry.get("timestamp")
                                last_timestamp = entry.get("timestamp")
                            if entry.get("type") in ("user", "assistant"):
                                message_count += 1
                                # Get first user message as fallback summary
                                if entry.get("type") == "user" and not first_user_message:
                                    msg = entry.get("message", {})
                                    content = msg.get("content", "")
                                    if isinstance(content, list):
                                        for block in content:
                                            if isinstance(block, dict) and block.get("type") == "text":
                                                first_user_message = block.get("text", "")[:100]
                                                break
                                    elif isinstance(content, str):
                                        first_user_message = content[:100]
                        else:  # codex
                            entry_type = entry.get("type")
                            timestamp = entry.get("timestamp")

                            if timestamp:
                                if not first_timestamp:
                                    first_timestamp = timestamp
                                last_timestamp = timestamp

                            if entry_type == "response_item":
                                payload = entry.get("payload", {})
                                role = payload.get("role")
                                if role in ("user", "assistant"):
                                    message_count += 1
                                    # Get first user message as summary
                                    if role == "user" and not first_user_message:
                                        content = payload.get("content", [])
                                        for block in content:
                                            if isinstance(block, dict) and block.get("type") == "input_text":
                                                text = block.get("text", "")
                                                # Skip system messages
                                                if not text.startswith("<") and len(text) < 500:
                                                    first_user_message = text[:100]
                                                    break
                            elif entry_type == "event_msg":
                                payload = entry.get("payload", {})
                                if payload.get("type") == "user_message" and not first_user_message:
                                    first_user_message = payload.get("message", "")[:100]

                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        print(f"Error reading {session_file}: {e}")
        return None

    # Use first user message as summary if no summary found
    if not first_summary:
        first_summary = first_user_message or "No summary"

    return {
        "id": session_file.stem,
        "filename": session_file.name,
        "summary": first_summary,
        "message_count": message_count,
        "first_timestamp": first_timestamp,
        "last_timestamp": last_timestamp,
        "size": session_file.stat().st_size,
        "modified": datetime.fromtimestamp(session_file.stat().st_mtime).isoformat(),
        "full_path": str(session_file)  # Store full path for codex sessions
    }


def get_conversation(project_id, session_id, source_id=None):
    """Get all messages in a conversation."""
    if source_id is None:
        source_id = current_source

    if source_id not in SOURCES:
        return {"error": "Unknown source"}

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]

    if source_id == "claude-code":
        session_file = data_dir / project_id / f"{session_id}.jsonl"
    elif source_id == "codex":
        # Decode the project_id to get the actual cwd
        try:
            target_cwd = decode_path_id(project_id)
        except Exception:
            return {"error": "Invalid project ID"}

        session_file = None
        for f in data_dir.rglob("*.jsonl"):
            if f.stem == session_id and get_codex_cwd(f) == target_cwd:
                session_file = f
                break
    else:  # gemini
        # project_id is the projectHash
        session_file = None
        for f in data_dir.rglob("chats/session-*.json"):
            if f.stem == session_id and get_gemini_project_hash(f) == project_id:
                session_file = f
                break

    if not session_file or not session_file.exists():
        return {"error": "Session not found"}

    if source_id == "claude-code":
        return parse_claude_conversation(session_file, session_id)
    elif source_id == "codex":
        return parse_codex_conversation(session_file, session_id)
    else:
        return parse_gemini_conversation(session_file, session_id)


def parse_claude_conversation(session_file, session_id):
    """Parse Claude Code conversation format."""
    messages = []
    summaries = []

    with open(session_file, 'r') as f:
        for line_num, line in enumerate(f):
            try:
                entry = json.loads(line)
                entry_type = entry.get("type")

                if entry_type == "summary":
                    summaries.append(entry.get("summary", ""))

                elif entry_type == "user":
                    msg = entry.get("message", {})
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        # Extract text from content blocks
                        text_parts = []
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text_parts.append(block.get("text", ""))
                            elif isinstance(block, str):
                                text_parts.append(block)
                        content = "\n".join(text_parts)

                    messages.append({
                        "role": "user",
                        "content": content,
                        "timestamp": entry.get("timestamp"),
                        "uuid": entry.get("uuid"),
                        "cwd": entry.get("cwd"),
                        "gitBranch": entry.get("gitBranch")
                    })

                elif entry_type == "assistant":
                    msg = entry.get("message", {})
                    content_blocks = msg.get("content", [])

                    text_content = []
                    thinking_content = []
                    tool_uses = []

                    for block in content_blocks:
                        if isinstance(block, dict):
                            block_type = block.get("type")
                            if block_type == "text":
                                text_content.append(block.get("text", ""))
                            elif block_type == "thinking":
                                thinking_content.append(block.get("thinking", ""))
                            elif block_type == "tool_use":
                                tool_uses.append({
                                    "name": block.get("name", ""),
                                    "input": block.get("input", {})
                                })

                    messages.append({
                        "role": "assistant",
                        "content": "\n".join(text_content),
                        "thinking": "\n".join(thinking_content) if thinking_content else None,
                        "tool_uses": tool_uses if tool_uses else None,
                        "timestamp": entry.get("timestamp"),
                        "uuid": entry.get("uuid"),
                        "model": msg.get("model"),
                        "usage": msg.get("usage")
                    })

            except json.JSONDecodeError as e:
                print(f"Error parsing line {line_num}: {e}")
                continue

    return {
        "summaries": summaries,
        "messages": messages,
        "session_id": session_id
    }


def parse_codex_conversation(session_file, session_id):
    """Parse OpenAI Codex conversation format."""
    messages = []
    summaries = []
    session_meta = {}

    with open(session_file, 'r') as f:
        for line_num, line in enumerate(f):
            try:
                entry = json.loads(line)
                entry_type = entry.get("type")
                timestamp = entry.get("timestamp")

                if entry_type == "session_meta":
                    session_meta = entry.get("payload", {})

                elif entry_type == "response_item":
                    payload = entry.get("payload", {})
                    role = payload.get("role")
                    payload_type = payload.get("type")

                    if payload_type == "message" and role == "user":
                        content_blocks = payload.get("content", [])
                        text_parts = []
                        for block in content_blocks:
                            if isinstance(block, dict) and block.get("type") == "input_text":
                                text = block.get("text", "")
                                # Skip system messages
                                if (text.startswith("<") or
                                    text.startswith("# AGENTS.md") or
                                    text.startswith("<environment_context") or
                                    "<permissions instructions>" in text or
                                    len(text) > 1000):  # Very long messages are likely system prompts
                                    continue
                                text_parts.append(text)
                        if text_parts:
                            messages.append({
                                "role": "user",
                                "content": "\n".join(text_parts),
                                "timestamp": timestamp
                            })

                    elif payload_type == "message" and role == "assistant":
                        content_blocks = payload.get("content", [])
                        text_parts = []
                        for block in content_blocks:
                            if isinstance(block, dict) and block.get("type") == "output_text":
                                text_parts.append(block.get("text", ""))
                        if text_parts:
                            messages.append({
                                "role": "assistant",
                                "content": "\n".join(text_parts),
                                "timestamp": timestamp,
                                "model": session_meta.get("model_provider", "openai")
                            })

                    elif payload_type == "function_call":
                        # Tool/function call
                        messages.append({
                            "role": "assistant",
                            "content": "",
                            "timestamp": timestamp,
                            "tool_uses": [{
                                "name": payload.get("name", ""),
                                "input": payload.get("arguments", "")
                            }],
                            "model": session_meta.get("model_provider", "openai")
                        })

                    elif payload_type == "reasoning":
                        # Reasoning/thinking block
                        summary_parts = payload.get("summary", [])
                        thinking_text = ""
                        for part in summary_parts:
                            if isinstance(part, dict) and part.get("type") == "summary_text":
                                thinking_text += part.get("text", "") + "\n"
                        if thinking_text:
                            messages.append({
                                "role": "assistant",
                                "content": "",
                                "thinking": thinking_text.strip(),
                                "timestamp": timestamp,
                                "model": session_meta.get("model_provider", "openai")
                            })

                elif entry_type == "event_msg":
                    payload = entry.get("payload", {})
                    msg_type = payload.get("type")

                    if msg_type == "agent_message":
                        messages.append({
                            "role": "assistant",
                            "content": payload.get("message", ""),
                            "timestamp": timestamp,
                            "model": session_meta.get("model_provider", "openai")
                        })

                elif entry_type == "turn_context":
                    # Extract model info from turn context
                    payload = entry.get("payload", {})
                    if payload.get("model"):
                        session_meta["model"] = payload.get("model")

            except json.JSONDecodeError as e:
                print(f"Error parsing line {line_num}: {e}")
                continue

    # Consolidate consecutive assistant messages with only tool_uses or thinking
    consolidated = []
    for msg in messages:
        if msg["role"] == "assistant" and consolidated and consolidated[-1]["role"] == "assistant":
            prev = consolidated[-1]
            # Merge tool_uses
            if msg.get("tool_uses") and not msg.get("content"):
                if prev.get("tool_uses"):
                    prev["tool_uses"].extend(msg["tool_uses"])
                else:
                    prev["tool_uses"] = msg["tool_uses"]
                continue
            # Merge thinking
            if msg.get("thinking") and not msg.get("content"):
                if prev.get("thinking"):
                    prev["thinking"] += "\n" + msg["thinking"]
                else:
                    prev["thinking"] = msg["thinking"]
                continue
        consolidated.append(msg)

    return {
        "summaries": summaries,
        "messages": consolidated,
        "session_id": session_id,
        "meta": {
            "cwd": session_meta.get("cwd"),
            "model": session_meta.get("model"),
            "cli_version": session_meta.get("cli_version")
        }
    }


def parse_gemini_conversation(session_file, session_id):
    """Parse Google Gemini conversation format."""
    messages = []
    summaries = []
    session_meta = {}

    with open(session_file, 'r') as f:
        data = json.load(f)
        session_meta = {
            "sessionId": data.get("sessionId"),
            "projectHash": data.get("projectHash"),
            "startTime": data.get("startTime"),
            "lastUpdated": data.get("lastUpdated")
        }

        for msg in data.get("messages", []):
            msg_type = msg.get("type")
            timestamp = msg.get("timestamp")
            content = msg.get("content", "")

            if msg_type == "user":
                messages.append({
                    "role": "user",
                    "content": content,
                    "timestamp": timestamp
                })
            elif msg_type == "gemini":
                # Extract thinking from thoughts array
                thinking_parts = []
                thoughts = msg.get("thoughts", [])
                for thought in thoughts:
                    if isinstance(thought, dict):
                        subject = thought.get("subject", "")
                        desc = thought.get("description", "")
                        if subject or desc:
                            thinking_parts.append(f"**{subject}**: {desc}" if subject else desc)

                # Extract tool calls
                tool_uses = []
                tool_calls = msg.get("toolCalls", [])
                for tool_call in tool_calls:
                    if isinstance(tool_call, dict):
                        tool_uses.append({
                            "name": tool_call.get("name", ""),
                            "input": tool_call.get("args", {})
                        })

                messages.append({
                    "role": "assistant",
                    "content": content,
                    "thinking": "\n".join(thinking_parts) if thinking_parts else None,
                    "tool_uses": tool_uses if tool_uses else None,
                    "timestamp": timestamp,
                    "model": msg.get("model", "gemini"),
                    "tokens": msg.get("tokens")
                })

    return {
        "summaries": summaries,
        "messages": messages,
        "session_id": session_id,
        "meta": session_meta
    }


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/sources')
def api_sources():
    """Get available sources."""
    sources = []
    for source_id, config in SOURCES.items():
        sources.append({
            "id": source_id,
            "name": config["name"],
            "available": config["source_dir"].exists()
        })
    return jsonify({
        "sources": sources,
        "current": current_source
    })


@app.route('/api/sources/<source_id>', methods=['POST'])
def api_set_source(source_id):
    """Set the current source."""
    global current_source
    if source_id not in SOURCES:
        return jsonify({"error": "Unknown source"}), 400
    current_source = source_id
    return jsonify({"status": "success", "current": current_source})


@app.route('/api/projects')
def api_projects():
    source_id = request.args.get('source', current_source)
    return jsonify(get_projects(source_id))


@app.route('/api/projects/<project_id>/sessions')
def api_sessions(project_id):
    source_id = request.args.get('source', current_source)
    return jsonify(get_sessions(project_id, source_id))


@app.route('/api/projects/<project_id>/sessions/<session_id>')
def api_conversation(project_id, session_id):
    source_id = request.args.get('source', current_source)
    return jsonify(get_conversation(project_id, session_id, source_id))


@app.route('/api/search')
def api_search():
    """Search across all conversations."""
    query = request.args.get('q', '').lower()
    source_id = request.args.get('source', current_source)

    if not query:
        return jsonify([])

    if source_id not in SOURCES:
        return jsonify([])

    data_dir = DATA_DIR / SOURCES[source_id]["data_subdir"]
    if not data_dir.exists():
        return jsonify([])

    results = []

    if source_id == "claude-code":
        for project_dir in data_dir.iterdir():
            if not project_dir.is_dir():
                continue

            for session_file in project_dir.glob("*.jsonl"):
                try:
                    with open(session_file, 'r') as f:
                        content = f.read().lower()
                        if query in content:
                            results.append({
                                "project_id": project_dir.name,
                                "session_id": session_file.stem,
                                "project_name": project_dir.name.replace("-", "/").lstrip("/")
                            })
                except Exception:
                    continue
    elif source_id == "codex":
        for session_file in data_dir.rglob("*.jsonl"):
            try:
                with open(session_file, 'r') as f:
                    content = f.read().lower()
                    if query in content:
                        cwd = get_codex_cwd(session_file)
                        if cwd:
                            project_id = encode_path_id(cwd)
                            results.append({
                                "project_id": project_id,
                                "session_id": session_file.stem,
                                "project_name": cwd
                            })
            except Exception:
                continue
    else:  # gemini
        for session_file in data_dir.rglob("chats/session-*.json"):
            try:
                with open(session_file, 'r') as f:
                    content = f.read().lower()
                    if query in content:
                        project_hash = get_gemini_project_hash(session_file)
                        if project_hash:
                            results.append({
                                "project_id": project_hash,
                                "session_id": session_file.stem,
                                "project_name": f"Project {project_hash[:8]}..."
                            })
            except Exception:
                continue

    return jsonify(results[:50])  # Limit results


@app.route('/api/projects/<project_id>/sessions/<session_id>/export')
def api_export(project_id, session_id):
    """Export conversation as text file."""
    source_id = request.args.get('source', current_source)
    conversation = get_conversation(project_id, session_id, source_id)

    if "error" in conversation:
        return jsonify(conversation), 404

    # Build text content
    lines = []
    lines.append("=" * 60)
    lines.append(f"Session: {session_id}")
    lines.append(f"Project: {project_id.replace('-', '/').lstrip('/')}")
    lines.append("=" * 60)
    lines.append("")

    # Add summaries if present
    if conversation.get("summaries"):
        lines.append("SUMMARIES:")
        for s in conversation["summaries"]:
            lines.append(f"  * {s}")
        lines.append("")
        lines.append("-" * 60)
        lines.append("")

    # Add messages
    for msg in conversation.get("messages", []):
        role = msg["role"].upper()
        timestamp = msg.get("timestamp", "")

        lines.append(f"[{role}] {timestamp}")
        if msg.get("model"):
            lines.append(f"Model: {msg['model']}")
        lines.append("-" * 40)

        # Content
        if msg.get("content"):
            lines.append(msg["content"])

        # Thinking
        if msg.get("thinking"):
            lines.append("")
            lines.append("--- THINKING ---")
            lines.append(msg["thinking"])
            lines.append("--- END THINKING ---")

        # Tool uses
        if msg.get("tool_uses"):
            lines.append("")
            for tool in msg["tool_uses"]:
                lines.append(f"[TOOL: {tool['name']}]")
                if isinstance(tool.get("input"), dict):
                    for k, v in tool["input"].items():
                        val = str(v)[:200] + "..." if len(str(v)) > 200 else str(v)
                        lines.append(f"  {k}: {val}")
                else:
                    lines.append(f"  {tool.get('input', '')}")

        # Usage stats
        if msg.get("usage"):
            usage = msg["usage"]
            tokens = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
            lines.append(f"\n[Tokens: {tokens}]")

        lines.append("")
        lines.append("=" * 60)
        lines.append("")

    text_content = "\n".join(lines)

    return Response(
        text_content,
        mimetype="text/plain",
        headers={"Content-Disposition": f"attachment; filename={session_id}.txt"}
    )


@app.route('/api/sync', methods=['POST'])
def api_sync():
    """Manually trigger a data sync."""
    source_id = request.args.get('source', current_source)
    try:
        sync_data(source_id=source_id, silent=True)
        return jsonify({
            "status": "success",
            "source": source_id,
            "last_sync": last_sync_time.get(source_id).isoformat() if last_sync_time.get(source_id) else None
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/status')
def api_status():
    """Get sync status."""
    source_id = request.args.get('source', current_source)
    source_config = SOURCES.get(source_id, {})
    data_dir = DATA_DIR / source_config.get("data_subdir", "")

    return jsonify({
        "source": source_id,
        "last_sync": last_sync_time.get(source_id).isoformat() if last_sync_time.get(source_id) else None,
        "sync_interval_hours": SYNC_INTERVAL / 3600,
        "data_dir": str(data_dir)
    })


def run_server(host="127.0.0.1", port=5050, skip_sync=False, debug=False):
    """Run the Flask server."""
    from ai_history_viewer import __version__

    print("=" * 60)
    print(f"AI History Viewer v{__version__}")
    print("=" * 60)

    if not skip_sync:
        # Sync data from all sources
        print("\nSyncing data from all sources...")
        for source_id, config in SOURCES.items():
            print(f"\n{config['name']}:")
            print(f"  Source: {config['source_dir']}")
            print(f"  Backup: {DATA_DIR / config['data_subdir']}")

            if sync_data(source_id=source_id):
                print("  Sync completed!")
            else:
                print("  Warning: Could not sync. Using existing local data if available.")

        # Start background sync thread
        print(f"\nBackground sync: Every {SYNC_INTERVAL // 3600} hour(s)")
        sync_thread = threading.Thread(target=background_sync, daemon=True)
        sync_thread.start()
        print("Background sync thread started.")
    else:
        print("\nSkipping initial sync (--no-sync flag)")

    print(f"\nStarting server...")
    print(f"Open http://{host}:{port} in your browser")
    print("=" * 60)
    app.run(host=host, port=port, debug=debug, use_reloader=False)


if __name__ == '__main__':
    run_server()
