import json
from pathlib import Path


def parse_claude_conversation(session_file: Path, session_id: str) -> dict:
    """Parse Claude Code JSONL conversation format."""
    messages = []
    summaries = []

    with open(session_file, "r") as f:
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
                        "gitBranch": entry.get("gitBranch"),
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
                                    "input": block.get("input", {}),
                                })

                    messages.append({
                        "role": "assistant",
                        "content": "\n".join(text_content),
                        "thinking": "\n".join(thinking_content) if thinking_content else None,
                        "tool_uses": tool_uses if tool_uses else None,
                        "timestamp": entry.get("timestamp"),
                        "uuid": entry.get("uuid"),
                        "model": msg.get("model"),
                        "usage": msg.get("usage"),
                    })

            except json.JSONDecodeError as e:
                print(f"Error parsing line {line_num}: {e}")
                continue

    return {"summaries": summaries, "messages": messages, "session_id": session_id}
