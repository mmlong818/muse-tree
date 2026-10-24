"""Thin OpenAI-compatible chat client. Swap base_url/model via env."""
import config

_client = None


def get_client():
    global _client
    if _client is None:
        try:
            from openai import OpenAI
        except ImportError:
            raise RuntimeError("pip install openai  (see requirements.txt)")
        if not config.LLM_API_KEY:
            raise RuntimeError("Set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL).")
        _client = OpenAI(api_key=config.LLM_API_KEY, base_url=config.LLM_BASE_URL)
    return _client


def chat(messages, model=None, temperature=0.7, max_tokens=2000, tools=None):
    """Return the raw assistant message object (may carry tool_calls)."""
    resp = get_client().chat.completions.create(
        model=model or config.LLM_MODEL,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools or None,
    )
    return resp.choices[0].message


def ask(prompt, system="You are a helpful assistant.", **kw):
    m = chat([{"role": "system", "content": system},
              {"role": "user", "content": prompt}], **kw)
    return m.content or ""
