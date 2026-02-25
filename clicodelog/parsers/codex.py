import json
from pathlib import Path


def parse_codex_conversation(session_file: Path, session_id: str) -> dict:
    """Parse OpenAI Codex JSONL conversation format."""
    messages = []
    summaries = []
    session_meta = {}

    with open(session_file, "r") as f:
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
                    model = session_meta.get("model_provider", "openai")

                    if payload_type == "message" and role == "user":
                        text_parts = []
                        for block in payload.get("content", []):
                            if isinstance(block, dict) and block.get("type") == "input_text":
                                text = block.get("text", "")
                                if (
                                    text.startswith("<")
                                    or text.startswith("# AGENTS.md")
                                    or text.startswith("<environment_context")
                                    or "<permissions instructions>" in text
                                    or len(text) > 1000
                                ):
                                    continue
                                text_parts.append(text)
                        if text_parts:
                            messages.append({
                                "role": "user",
                                "content": "\n".join(text_parts),
                                "timestamp": timestamp,
                            })

                    elif payload_type == "message" and role == "assistant":
                        text_parts = [
                            block.get("text", "")
                            for block in payload.get("content", [])
                            if isinstance(block, dict) and block.get("type") == "output_text"
                        ]
                        if text_parts:
                            messages.append({
                                "role": "assistant",
                                "content": "\n".join(text_parts),
                                "timestamp": timestamp,
                                "model": model,
                            })

                    elif payload_type == "function_call":
                        messages.append({
                            "role": "assistant",
                            "content": "",
                            "timestamp": timestamp,
                            "tool_uses": [{"name": payload.get("name", ""), "input": payload.get("arguments", "")}],
                            "model": model,
                        })

                    elif payload_type == "reasoning":
                        if payload.get("encrypted_content"):
                            thinking_text = (
                                "[Reasoning content is encrypted and cannot be displayed]\n\n"
                                "OpenAI Codex encrypts extended thinking for privacy."
                            )
                        else:
                            parts = [
                                part.get("text", "")
                                for part in payload.get("summary", [])
                                if isinstance(part, dict) and part.get("type") == "summary_text"
                            ]
                            thinking_text = "\n".join(parts)

                        if thinking_text:
                            messages.append({
                                "role": "assistant",
                                "content": "",
                                "thinking": thinking_text.strip(),
                                "timestamp": timestamp,
                                "model": model,
                            })

                elif entry_type == "event_msg":
                    payload = entry.get("payload", {})
                    if payload.get("type") == "agent_message":
                        messages.append({
                            "role": "assistant",
                            "content": payload.get("message", ""),
                            "timestamp": timestamp,
                            "model": session_meta.get("model_provider", "openai"),
                        })

                elif entry_type == "turn_context":
                    payload = entry.get("payload", {})
                    if payload.get("model"):
                        session_meta["model"] = payload.get("model")

            except json.JSONDecodeError as e:
                print(f"Error parsing line {line_num}: {e}")
                continue

    # Merge consecutive assistant-only tool_use / thinking blocks into the previous message
    consolidated = []
    for msg in messages:
        if msg["role"] == "assistant" and consolidated and consolidated[-1]["role"] == "assistant":
            prev = consolidated[-1]
            if msg.get("tool_uses") and not msg.get("content"):
                prev.setdefault("tool_uses", []).extend(msg["tool_uses"])
                continue
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
            "cli_version": session_meta.get("cli_version"),
        },
    }
