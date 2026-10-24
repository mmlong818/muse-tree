"""Subagent-style orchestration.

Mirrors subagent.spawn / list / send / close:
- spawn(brief, context): child inherits parent context, runs async in background.
- Each agent runs a small tool loop: finish(answer) | spawn_child(brief).
- Depth is capped (MAX_DEPTH) to prevent runaway recursion.
- Parent collects results via result(agent_id); send() steers a running agent.

Simplifications vs the real runtime: same-process thread pool instead of
isolated sandboxes; the "tools" available to children are LLM-only here.
"""
import json
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor

import llm
import config

FINISH_TOOL = {"type": "function", "function": {
    "name": "finish",
    "description": "End your work and return the final answer to your parent.",
    "parameters": {"type": "object", "properties": {
        "answer": {"type": "string", "description": "Final result for the parent."}},
        "required": ["answer"]}}}

SPAWN_TOOL = {"type": "function", "function": {
    "name": "spawn_child",
    "description": "Delegate a self-contained subtask to a child agent.",
    "parameters": {"type": "object", "properties": {
        "brief": {"type": "string", "description": "Task brief for the child."}},
        "required": ["brief"]}}}


class AgentRecord:
    def __init__(self, agent_id, brief, depth):
        self.id = agent_id
        self.brief = brief
        self.depth = depth
        self.status = "running"          # running | done | failed | closed
        self.result_text = None
        self.inbox = []                  # messages from parent via send()
        self.lock = threading.Lock()
        self.messages = []


class AgentRuntime:
    def __init__(self, max_depth=config.MAX_DEPTH, workers=config.AGENT_WORKERS):
        self.max_depth = max_depth
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.agents = {}
        self._lock = threading.Lock()

    # ---- API mirroring subagent.* ----
    def spawn(self, brief, context="", depth=0):
        aid = uuid.uuid4().hex[:8]
        rec = AgentRecord(aid, brief, depth)
        rec.messages = [{
            "role": "system",
            "content": (
                f"You are a subagent (depth {depth}/{self.max_depth}).\n"
                f"YOUR TASK: {brief}\n\n"
                f"INHERITED CONTEXT:\n{context}\n\n"
                "Work autonomously. Call finish(answer) when done. "
                + ("You may call spawn_child(brief) to delegate a subtask." if depth < self.max_depth
                   else "You cannot spawn further children.")
            )}]
        with self._lock:
            self.agents[aid] = rec
        rec.future = self.pool.submit(self._run, rec)
        return aid

    def list(self):
        with self._lock:
            return [{"id": a.id, "status": a.status,
                     "depth": a.depth, "brief": a.brief[:60]}
                    for a in self.agents.values()]

    def send(self, agent_id, message):
        rec = self.agents.get(agent_id)
        if not rec or rec.status != "running":
            return False
        with rec.lock:
            rec.inbox.append(message)
        return True

    def close(self, agent_id):
        rec = self.agents.get(agent_id)
        if not rec:
            return False
        rec.future.cancel()
        rec.status = "closed"
        return True

    def result(self, agent_id, timeout=None):
        rec = self.agents.get(agent_id)
        if not rec:
            return None
        try:
            return rec.future.result(timeout=timeout)
        except Exception as e:
            return f"(result unavailable: {e})"

    # ---- worker loop ----
    def _run(self, rec):
        tools = [FINISH_TOOL] + ([SPAWN_TOOL] if rec.depth < self.max_depth else [])
        try:
            for _ in range(12):  # iteration cap
                with rec.lock:
                    while rec.inbox:
                        rec.messages.append({"role": "user",
                                             "content": "[parent] " + rec.inbox.pop(0)})
                try:
                    msg = llm.chat(rec.messages, tools=tools)
                except Exception:
                    # endpoint without tool support -> single-shot fallback
                    msg = llm.chat(rec.messages)
                    rec.result_text = msg.content or ""
                    rec.status = "done"
                    return rec.result_text

                assistant = {"role": "assistant", "content": msg.content or ""}
                if getattr(msg, "tool_calls", None):
                    assistant["tool_calls"] = [
                        {"id": tc.id, "type": "function",
                         "function": {"name": tc.function.name,
                                      "arguments": tc.function.arguments or "{}"}}
                        for tc in msg.tool_calls]
                rec.messages.append(assistant)

                if not getattr(msg, "tool_calls", None):
                    rec.result_text = msg.content or ""
                    rec.status = "done"
                    return rec.result_text

                for tc in msg.tool_calls:
                    args = json.loads(tc.function.arguments or "{}")
                    if tc.function.name == "finish":
                        rec.result_text = args.get("answer", "")
                        rec.status = "done"
                        return rec.result_text
                    if tc.function.name == "spawn_child":
                        child = self.spawn(args.get("brief", ""),
                                           context=f"parent task: {rec.brief}",
                                           depth=rec.depth + 1)
                        child_out = self.result(child, timeout=300)
                        rec.messages.append({"role": "tool", "tool_call_id": tc.id,
                                             "content": f"child {child} result:\n{child_out}"})
            rec.result_text = "(stopped: iteration cap)"
            rec.status = "done"
            return rec.result_text
        except Exception as e:  # noqa: BLE001
            rec.status = "failed"
            rec.result_text = f"error: {e}"
            return rec.result_text
