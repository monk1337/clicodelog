#!/usr/bin/env python3
"""
Claude Conversation History Viewer
A web app to browse and view Claude Code conversation history.
Data is copied from ~/.claude/projects/ to ./data/ for backup and local use.
Background sync runs every hour to keep data updated.
"""

import json
import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Sync interval in seconds (1 hour = 3600 seconds)
SYNC_INTERVAL = 3600

# Source directory (original Claude data)
CLAUDE_DIR = Path.home() / ".claude"
SOURCE_PROJECTS_DIR = CLAUDE_DIR / "projects"

# Local data directory (backup/working copy)
APP_DIR = Path(__file__).parent
DATA_DIR = APP_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"


# Lock for thread-safe sync operations
sync_lock = threading.Lock()
last_sync_time = None


def sync_data(silent=False):
    """Copy data from ~/.claude/projects/ to ./data/projects/ for backup."""
    global last_sync_time

    with sync_lock:
        if not SOURCE_PROJECTS_DIR.exists():
            if not silent:
                print(f"Source directory not found: {SOURCE_PROJECTS_DIR}")
            return False

        # Create data directory if it doesn't exist
        DATA_DIR.mkdir(exist_ok=True)

        # Copy projects directory
        if not silent:
            print(f"Syncing data from {SOURCE_PROJECTS_DIR} to {PROJECTS_DIR}...")

        if PROJECTS_DIR.exists():
            # Remove old data and replace with fresh copy
            shutil.rmtree(PROJECTS_DIR)

        shutil.copytree(SOURCE_PROJECTS_DIR, PROJECTS_DIR)

        # Count what was copied
        project_count = sum(1 for p in PROJECTS_DIR.iterdir() if p.is_dir())
        session_count = sum(1 for p in PROJECTS_DIR.iterdir() if p.is_dir() for _ in p.glob("*.jsonl"))

        last_sync_time = datetime.now()

        if not silent:
            print(f"Synced {project_count} projects with {session_count} sessions")
        else:
            print(f"[{last_sync_time.strftime('%Y-%m-%d %H:%M:%S')}] Background sync: {project_count} projects, {session_count} sessions")

        return True


def background_sync():
    """Background thread that syncs data every SYNC_INTERVAL seconds."""
    while True:
        time.sleep(SYNC_INTERVAL)
        try:
            sync_data(silent=True)
        except Exception as e:
            print(f"[Background sync error] {e}")


def get_projects():
    """Get all project directories."""
    if not PROJECTS_DIR.exists():
        return []

    projects = []
    for project_dir in sorted(PROJECTS_DIR.iterdir()):
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

    return projects


def get_sessions(project_id):
    """Get all sessions for a project."""
    project_dir = PROJECTS_DIR / project_id
    if not project_dir.exists():
        return []

    sessions = []
    for session_file in sorted(project_dir.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True):
        # Read first few lines to get session info
        first_summary = None
        message_count = 0
        first_timestamp = None
        last_timestamp = None

        try:
            with open(session_file, 'r') as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                        if entry.get("type") == "summary" and not first_summary:
                            first_summary = entry.get("summary", "")
                        if entry.get("timestamp"):
                            if not first_timestamp:
                                first_timestamp = entry.get("timestamp")
                            last_timestamp = entry.get("timestamp")
                        if entry.get("type") in ("user", "assistant"):
                            message_count += 1
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            print(f"Error reading {session_file}: {e}")
            continue

        sessions.append({
            "id": session_file.stem,
            "filename": session_file.name,
            "summary": first_summary or "No summary",
            "message_count": message_count,
            "first_timestamp": first_timestamp,
            "last_timestamp": last_timestamp,
            "size": session_file.stat().st_size,
            "modified": datetime.fromtimestamp(session_file.stat().st_mtime).isoformat()
        })

    return sessions


def get_conversation(project_id, session_id):
    """Get all messages in a conversation."""
    session_file = PROJECTS_DIR / project_id / f"{session_id}.jsonl"
    if not session_file.exists():
        return {"error": "Session not found"}

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


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/projects')
def api_projects():
    return jsonify(get_projects())


@app.route('/api/projects/<project_id>/sessions')
def api_sessions(project_id):
    return jsonify(get_sessions(project_id))


@app.route('/api/projects/<project_id>/sessions/<session_id>')
def api_conversation(project_id, session_id):
    return jsonify(get_conversation(project_id, session_id))


@app.route('/api/search')
def api_search():
    """Search across all conversations."""
    query = request.args.get('q', '').lower()
    if not query:
        return jsonify([])

    results = []
    for project_dir in PROJECTS_DIR.iterdir():
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

    return jsonify(results[:50])  # Limit results


@app.route('/api/sync', methods=['POST'])
def api_sync():
    """Manually trigger a data sync."""
    try:
        sync_data(silent=True)
        return jsonify({
            "status": "success",
            "last_sync": last_sync_time.isoformat() if last_sync_time else None
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/status')
def api_status():
    """Get sync status."""
    return jsonify({
        "last_sync": last_sync_time.isoformat() if last_sync_time else None,
        "sync_interval_hours": SYNC_INTERVAL / 3600,
        "data_dir": str(PROJECTS_DIR)
    })


if __name__ == '__main__':
    print("=" * 60)
    print("Claude History Viewer")
    print("=" * 60)

    # Sync data from source to local data folder
    print(f"\nSource: {SOURCE_PROJECTS_DIR}")
    print(f"Backup: {PROJECTS_DIR}")
    print()

    if sync_data():
        print("\nInitial data sync completed!")
    else:
        print("\nWarning: Could not sync data. Using existing local data if available.")

    # Start background sync thread
    print(f"\nBackground sync: Every {SYNC_INTERVAL // 3600} hour(s)")
    sync_thread = threading.Thread(target=background_sync, daemon=True)
    sync_thread.start()
    print("Background sync thread started.")

    print(f"\nStarting server...")
    print(f"Open http://localhost:5050 in your browser")
    print("=" * 60)
    app.run(debug=True, port=5050, use_reloader=False)
