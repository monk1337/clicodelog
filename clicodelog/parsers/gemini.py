import json
from pathlib import Path


def parse_gemini_conversation(session_file: Path, session_id: str) -> dict:
    """Parse Google Gemini JSON conversation format."""
    messages = []

    with open(session_file, "r") as f:
        data = json.load(f)

    session_meta = {
        "sessionId": data.get("sessionId"),
        "projectHash": data.get("projectHash"),
        "startTime": data.get("startTime"),
        "lastUpdated": data.get("lastUpdated"),
    }

    for msg in data.get("messages", []):
        msg_type = msg.get("type")
        timestamp = msg.get("timestamp")
        content = msg.get("content", "")

        if msg_type == "user":
            messages.append({"role": "user", "content": content, "timestamp": timestamp})

        elif msg_type == "gemini":
            thinking_parts = []
            for thought in msg.get("thoughts", []):
                if isinstance(thought, dict):
                    subject = thought.get("subject", "")
                    desc = thought.get("description", "")
                    if subject or desc:
                        thinking_parts.append(f"**{subject}**: {desc}" if subject else desc)

            tool_uses = [
                {"name": tc.get("name", ""), "input": tc.get("args", {})}
                for tc in msg.get("toolCalls", [])
                if isinstance(tc, dict)
            ]

            messages.append({
                "role": "assistant",
                "content": content,
                "thinking": "\n".join(thinking_parts) if thinking_parts else None,
                "tool_uses": tool_uses if tool_uses else None,
                "timestamp": timestamp,
                "model": msg.get("model", "gemini"),
                "tokens": msg.get("tokens"),
            })

    return {"summaries": [], "messages": messages, "session_id": session_id, "meta": session_meta}
