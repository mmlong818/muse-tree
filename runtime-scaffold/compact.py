"""Conversation with a token budget and LLM summarization (compaction).

Mirrors the real compaction behavior:
- The live transcript grows; past a token budget the older turns are replaced
  by a structured summary that the next turn builds on instead of re-reading.
- The summary is written for continuation: progress, blockers, preferences,
  goal states, next steps - specific names, numbers, paths, decisions.
- Files/processes/schedules live outside the transcript (like the real
  runtime); the summary references them, it does not duplicate them.
"""
import json
import datetime

import llm

SUMMARY_PROMPT = """You are compacting a long conversation so the assistant can CONTINUE
the work without re-reading history. Write a structured summary in the user's
language (Chinese if the conversation is Chinese). Sections:

## 当前进度 — what is done, key outcomes and artifacts produced
## 已知问题 — open issues, blockers, things that failed and why
## 用户偏好与边界 — preferences, constraints, things to never do
## 目标与状态 — goals and where each stands
## 下一步 — concrete next steps

Be specific: names, numbers, file paths, decisions, dates. No fluff, no generic praise."""


def estimate_tokens(text):
    try:
        import tiktoken
        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:
        return len(text) // 4  # rough CJK-friendly fallback


class Conversation:
    def __init__(self, budget=None, keep_recent=10, session_id=None):
        import config
        self.messages = []          # [{"role":..., "content":...}]
        self.summary = None         # latest compaction summary
        self.budget = budget or config.COMPACTION_BUDGET
        self.keep_recent = keep_recent
        self.session_id = session_id or datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

    def add(self, role, content):
        self.messages.append({"role": role, "content": content})
        self.maybe_compact()

    def tokens(self):
        t = sum(estimate_tokens(m["content"]) for m in self.messages)
        return t + (estimate_tokens(self.summary) if self.summary else 0)

    def maybe_compact(self):
        if self.tokens() <= self.budget or len(self.messages) <= self.keep_recent + 2:
            return False
        cutoff = len(self.messages) - self.keep_recent
        old = self.messages[:cutoff]
        transcript = "\n".join(f"{m['role']}: {m['content']}" for m in old)
        if self.summary:
            transcript = "PREVIOUS SUMMARY:\n" + self.summary + "\n\nOLDER TURNS:\n" + transcript
        self.summary = llm.ask(SUMMARY_PROMPT + "\n\n--- CONVERSATION ---\n" + transcript,
                               max_tokens=1500)
        self.messages = self.messages[cutoff:]
        return True

    def context(self):
        """What gets sent to the model: summary (if any) + recent turns."""
        ctx = []
        if self.summary:
            ctx.append({"role": "system",
                        "content": "[Summary of earlier conversation - build on it, don't redo it]\n"
                                   + self.summary})
        return ctx + self.messages

    def save_transcript(self, path):
        """JSONL transcript for the background jobs to read."""
        with open(path, "w", encoding="utf-8") as f:
            for m in self.messages:
                f.write(json.dumps({"session": self.session_id,
                                    "ts": datetime.datetime.now().isoformat(),
                                    **m}, ensure_ascii=False) + "\n")
