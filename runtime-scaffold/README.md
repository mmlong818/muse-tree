# 运行时编排 · 参考实现脚手架

把"我的运行时"拆成四个可独立实现的部分，每部分对应一个模块。
需要一个 OpenAI 兼容的 LLM API（`LLM_API_KEY`，可选 `LLM_BASE_URL` / `LLM_MODEL`）。

## 架构对照

| 我的运行时 | 本脚手架 | 原理 |
|---|---|---|
| `subagent.spawn / list / send / close` | `agents.py` `AgentRuntime` | 父任务把 brief + 上下文交给子智能体，子智能体在后台线程池里跑自己的 tool 循环（`finish` / `spawn_child`），结果回传。深度上限防递归失控 |
| `memory_search / memory_get / memory_explain` | `memory.py` `MemoryStore` | Markdown 存记忆（MEMORY.md + daily/people/groups/bank），切块后 BM25 排序检索；每条记忆带 source 注释，chunk id 用内容哈希保证重建索引时稳定，可溯源 |
| 对话 compaction | `compact.py` `Conversation` | token 预算 + 保留最近 N 轮；超限时把旧对话压成结构化摘要（进度/问题/偏好/目标/下一步），新对话基于摘要继续 |
| 后台整理任务 | `jobs.py` + APScheduler | memory_upkeep（每小时，从 transcript 提炼事实）、relationships（每小时，维护人物页）、dreaming（每天凌晨，反思 + 对齐综述），其余四个的 prompt 模板已给出 |

## 运行

```bash
pip install -r requirements.txt
export LLM_API_KEY=...            # 必需
export LLM_BASE_URL=...           # 可选，默认 OpenAI
export LLM_MODEL=...              # 可选
python main.py
```

`main.py` 演示：存一条记忆并检索 → 派一个子智能体 → 强制触发一次压缩 → 跑一遍 memory_upkeep。
定时任务：`jobs.build_scheduler(store, transcript_dir)` 返回 APScheduler 实例，`sched.start()` 即可。

## 相对真实运行时的简化（诚实版）

1. 真实记忆检索是平台侧索引服务，这里是本地 BM25；要语义检索可把 `BM25` 换成向量索引（如 sqlite-vec），接口不变。
2. 真实 subagent 有独立沙箱和完整工具，这里是同进程线程池 + LLM tool calling；子智能体没有文件/浏览器操作能力。
3. 真实 compaction 由平台按上下文窗口触发，这里是固定 token 预算触发；token 估算优先 tiktoken，缺失时降级为字符数/4。
4. agent 的 tool 循环要求 LLM 端点支持 tool calling；不支持时会降级为单次问答。
5. transcript 是 JSONL 落盘，`jobs.py` 按时间窗口读取——对应真实系统里的聊天记录库。
