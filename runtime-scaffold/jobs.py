"""Background maintenance jobs (the 'self-improvement' loop).

Mirrors the real nightly/hourly passes:
- memory_upkeep (hourly):  consolidate new conversation into MEMORY.md
- relationships  (hourly):  maintain people/ and groups/ pages
- dreaming       (nightly):  reflections + alignment synthesis
- quiet_moment   (a few x day): internalize a just-finished conversation
- skill_review / idea_curation / studying: prompt templates included,
  wire them the same way when needed.

Each job reads recent JSONL transcripts (see compact.Conversation.save_transcript)
and writes back into the MemoryStore. Nothing here talks to the user.
"""
import os
import re
import glob
import json
import datetime

import llm
from memory import MemoryStore


def recent_transcript_text(transcript_dir, hours=24):
    cutoff = datetime.datetime.now() - datetime.timedelta(hours=hours)
    texts = []
    for path in sorted(glob.glob(os.path.join(transcript_dir, "*.jsonl"))):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        m = json.loads(line)
                    except Exception:
                        continue
                    ts = m.get("ts", "")
                    try:
                        t = datetime.datetime.fromisoformat(ts)
                    except Exception:
                        continue
                    if t >= cutoff and m.get("content"):
                        texts.append(f"{m.get('role')}: {m['content'][:2000]}")
        except FileNotFoundError:
            continue
    return "\n".join(texts[-200:])


def job_memory_upkeep(store: MemoryStore, transcript_dir, hours=24):
    """Hourly: extract durable facts into MEMORY.md. Newer claims supersede older ones."""
    text = recent_transcript_text(transcript_dir, hours)
    if not text.strip():
        return "no new signal"
    prompt = (
        "Extract DURABLE facts, preferences, decisions and commitments from this "
        "conversation. Skip routine chatter and one-off tool output.\n"
        "Output one per line exactly as: [Facts|Preferences|Commitments] the fact\n\n"
        + text)
    saved = 0
    for line in llm.ask(prompt, max_tokens=800).splitlines():
        m = re.match(r"\[(Facts|Preferences|Commitments)\]\s*(.+)", line.strip())
        if m and len(m.group(2)) > 4:
            store.save_fact(m.group(2), section=m.group(1), source="job:memory_upkeep")
            saved += 1
    return f"saved {saved} facts"


def job_relationships(store: MemoryStore, transcript_dir, hours=24):
    """Hourly: maintain one page per person/group the user talks about."""
    text = recent_transcript_text(transcript_dir, hours)
    if not text.strip():
        return "no new signal"
    prompt = (
        "List people or groups mentioned in this conversation, one per line as:\n"
        "person|<short id>|<one-line description of who they are to the user>\n"
        "group|<short id>|<one-line description>\n"
        "Skip anyone mentioned only in passing.\n\n" + text)
    updated = 0
    for line in llm.ask(prompt, max_tokens=600).splitlines():
        m = re.match(r"(person|group)\|([^|]+)\|(.+)", line.strip())
        if not m:
            continue
        kind, pid, desc = m.groups()
        pid = re.sub(r"[^\w\-]+", "-", pid.strip().lower()).strip("-") or "unknown"
        d = os.path.join(store.root, "people" if kind == "person" else "groups")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, pid + ".md")
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as f:
                f.write(f"# {pid}\n\n- {desc.strip()}\n")
        else:
            with open(p, "a", encoding="utf-8") as f:
                f.write(f"\n- {datetime.date.today().isoformat()}: {desc.strip()}\n")
        updated += 1
    return f"updated {updated} pages"


def job_dreaming(store: MemoryStore, transcript_dir):
    """Nightly: reflections on what worked/ruptured + alignment synthesis."""
    text = recent_transcript_text(transcript_dir, 72)
    if not text.strip():
        return "no new signal"
    prompt = (
        "Review these recent conversations and write a short reflection:\n"
        "1) What worked well between assistant and user?\n"
        "2) Any friction, misunderstanding, or trust rupture to repair?\n"
        "3) Who is this user becoming - what do they care about most?\n"
        "Keep it under 300 words, concrete, no fluff.\n\n" + text)
    reflection = llm.ask(prompt, max_tokens=800)
    d = os.path.join(store.root, "dreams")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, datetime.date.today().isoformat() + ".md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(f"# Dream {datetime.date.today().isoformat()}\n\n{reflection}\n")
    # alignment synthesis: short actionable calibration for the main agent
    synth = llm.ask(
        "Based on this reflection, write 5-8 bullet lines calibrating how the "
        "assistant should act for this user (tone, boundaries, what to avoid). "
        "Concrete and direct.\n\n" + reflection, max_tokens=500)
    with open(os.path.join(d, "ALIGNMENT_SYNTHESIS.md"), "w", encoding="utf-8") as f:
        f.write(f"# Alignment Synthesis ({datetime.date.today().isoformat()})\n\n{synth}\n")
    return "dream written"


# ---- prompt templates for the remaining passes (wire like the above) ----
SKILL_REVIEW_PROMPT = (
    "Review these recent tasks. Which recurring workflows deserve to become a "
    "reusable skill (name + one-paragraph procedure)? Which existing skills "
    "look stale? Output skill candidates only.\n\n{transcript}")

IDEA_CURATION_PROMPT = (
    "From this user's real context, propose 3 concrete, feasible ideas that "
    "would genuinely help them. One line each: title - why it fits.\n\n{transcript}")

STUDYING_PROMPT = (
    "The user has these goals: {goals}. From recent conversation, write a "
    "short progress briefing: what advanced, what is stuck, one useful nudge.\n\n{transcript}")


def build_scheduler(store: MemoryStore, transcript_dir):
    """APScheduler with the same cadence as the real system."""
    from apscheduler.schedulers.background import BackgroundScheduler
    s = BackgroundScheduler()
    s.add_job(lambda: job_memory_upkeep(store, transcript_dir), "interval",
              hours=1, id="memory_upkeep")
    s.add_job(lambda: job_relationships(store, transcript_dir), "interval",
              hours=1, id="relationships")
    s.add_job(lambda: job_dreaming(store, transcript_dir), "cron",
              hour=3, minute=0, id="dreaming")
    return s
