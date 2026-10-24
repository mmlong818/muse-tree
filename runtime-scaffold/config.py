"""Configuration: environment variables with sane defaults."""
import os

LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

MEMORY_DIR = os.environ.get("MEMORY_DIR", "./memory_data")
TRANSCRIPT_DIR = os.environ.get("TRANSCRIPT_DIR", "./transcripts")

MAX_DEPTH = int(os.environ.get("MAX_AGENT_DEPTH", "2"))   # subagent nesting cap
AGENT_WORKERS = int(os.environ.get("AGENT_WORKERS", "4"))
COMPACTION_BUDGET = int(os.environ.get("COMPACTION_BUDGET", "12000"))  # tokens
