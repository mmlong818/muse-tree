"""Demo wiring everything together. Needs LLM_API_KEY (+ optional LLM_BASE_URL/MODEL)."""
import os
import config
from memory import MemoryStore
from agents import AgentRuntime
from compact import Conversation
from jobs import build_scheduler, job_memory_upkeep


def main():
    os.makedirs(config.TRANSCRIPT_DIR, exist_ok=True)
    store = MemoryStore(config.MEMORY_DIR)

    # 1. memory: save + search + explain
    store.save_fact("用户偏好直接、具体的回答，不喜欢客套话",
                    section="Preferences", source="demo")
    for hit in store.search("用户喜欢什么样的回答"):
        print(f"[memory] {hit['score']} {hit['path']}: {hit['text'][:60]}")
        print("  explain:", store.explain(hit["id"])["source"])

    # 2. subagents: parent delegates to a child
    rt = AgentRuntime()
    aid = rt.spawn("用三句话解释 BM25 的核心思想",
                   context="用户是技术背景，回答要直接具体。")
    print("[agent] spawned:", rt.list())
    print("[agent] result:", rt.result(aid, timeout=180)[:200])

    # 3. compaction: tiny budget forces a summary
    conv = Conversation(budget=1500, keep_recent=4)
    for i in range(12):
        conv.add("user", f"这是第 {i} 条测试消息，讨论记忆系统的设计。")
        conv.add("assistant", f"收到，这是第 {i} 条回复，记录了设计要点。")
    print("[compact] summary present:", bool(conv.summary))
    if conv.summary:
        print(conv.summary[:300])
    conv.save_transcript(os.path.join(config.TRANSCRIPT_DIR, conv.session_id + ".jsonl"))

    # 4. background job: run memory upkeep once over the demo transcript
    print("[job]", job_memory_upkeep(store, config.TRANSCRIPT_DIR, hours=1))

    # 5. scheduler (commented: runs forever)
    # sched = build_scheduler(store, config.TRANSCRIPT_DIR)
    # sched.start()
    # input("scheduler running, Enter to stop...\n")


if __name__ == "__main__":
    main()
