"""Markdown-backed personal memory with BM25 retrieval and provenance.

Layout (mirrors the real system):
    <root>/MEMORY.md            curated long-term memory (Facts / Preferences / Commitments)
    <root>/daily/YYYY-MM-DD.md  dated logs
    <root>/people/<name>.md     relationship pages
    <root>/groups/<name>.md
    <root>/bank/<topic>.md      background-maintained knowledge

Retrieval = chunk markdown -> BM25 rank -> top-k with source paths.
Provenance: every saved fact carries a machine-readable source comment;
chunk ids are content hashes, stable across re-indexes.
"""
import os
import re
import math
import json
import hashlib
import datetime
from collections import Counter

TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[a-zA-Z0-9]+")


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


class BM25:
    def __init__(self, docs, k1=1.5, b=0.75):
        """docs: list of (doc_id, text)."""
        self.k1, self.b = k1, b
        self.docs = docs
        self.tf = [Counter(tokenize(t)) for _, t in docs]
        self.df = Counter()
        for tf in self.tf:
            for tok in tf:
                self.df[tok] += 1
        self.n = len(docs)
        self.avgdl = sum(sum(tf.values()) for tf in self.tf) / max(1, self.n)

    def search(self, query, k=6):
        scores = []
        qt = tokenize(query)
        for i, tf in enumerate(self.tf):
            dl = sum(tf.values()) or 1
            s = 0.0
            for tok in qt:
                df = self.df.get(tok, 0)
                if not df:
                    continue
                idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
                f = tf.get(tok, 0)
                s += idf * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
            if s > 0:
                scores.append((s, i))
        scores.sort(reverse=True)
        return [(self.docs[i][0], s) for s, i in scores[:k]]


def chunk_markdown(path, rel):
    """Split a markdown file into headed/bullet chunks."""
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    chunks, cur_head, buf = [], "", []
    for line in text.splitlines():
        if re.match(r"^#{1,3}\s+", line):
            if buf:
                chunks.append((cur_head, "\n".join(buf)))
            cur_head, buf = line.strip(), []
        elif line.strip().startswith(("- ", "* ")) or re.match(r"^\d+\.", line.strip()):
            buf.append(line.strip())
        elif line.strip():
            buf.append(line.strip())
    if buf:
        chunks.append((cur_head, "\n".join(buf)))
    out = []
    for head, body in chunks:
        full = (head + "\n" + body).strip()
        if not full or full.startswith("<!--"):
            continue
        cid = hashlib.md5(f"{rel}::{full}".encode()).hexdigest()[:12]
        out.append({"id": cid, "text": full, "path": rel})
    return out


class MemoryStore:
    def __init__(self, root):
        self.root = root
        for d in ("daily", "people", "groups", "bank"):
            os.makedirs(os.path.join(root, d), exist_ok=True)
        mem = os.path.join(root, "MEMORY.md")
        if not os.path.exists(mem):
            with open(mem, "w", encoding="utf-8") as f:
                f.write("# MEMORY.md\n\n## Facts\n\n## Preferences\n\n## Commitments\n")
        self._index = None  # (bm25, chunks, provenance)

    # ---------- writes ----------
    def save_fact(self, text, section="Facts", source=None):
        """Append one durable fact under a ## section, with provenance comment."""
        p = os.path.join(self.root, "MEMORY.md")
        with open(p, encoding="utf-8") as f:
            content = f.read()
        line = f"- {text.strip()}"
        if source:
            line += f"\n  <!-- source: {source} -->"
        marker = f"## {section}"
        if marker not in content:
            content = content.rstrip() + f"\n\n{marker}\n"
        content = content.replace(marker, marker + "\n" + line, 1)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        self._index = None

    def log_daily(self, text):
        p = os.path.join(self.root, "daily", datetime.date.today().isoformat() + ".md")
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"- {datetime.datetime.now().strftime('%H:%M')} {text.strip()}\n")
        self._index = None

    def save_person(self, name, text):
        p = os.path.join(self.root, "people", f"{name}.md")
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        self._index = None

    # ---------- reads ----------
    def _build_index(self):
        chunks, prov = [], {}
        for dirpath, _, files in os.walk(self.root):
            for fn in sorted(files):
                if not fn.endswith(".md"):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, self.root)
                for c in chunk_markdown(full, rel):
                    chunks.append(c)
                    m = re.search(r"<!--\s*source:\s*(.*?)\s*-->", c["text"])
                    if m:
                        prov[c["id"]] = m.group(1)
        bm25 = BM25([(c["id"], c["text"]) for c in chunks])
        self._index = (bm25, {c["id"]: c for c in chunks}, prov)

    def search(self, query, k=6):
        """Like memory_search: ranked chunks with source paths."""
        if self._index is None:
            self._build_index()
        bm25, by_id, _ = self._index
        return [{"id": cid, "score": round(s, 3), **by_id[cid]}
                for cid, s in bm25.search(query, k)]

    def explain(self, chunk_id):
        """Like memory_explain: where did this memory come from?"""
        if self._index is None:
            self._build_index()
        _, by_id, prov = self._index
        c = by_id.get(chunk_id)
        if not c:
            return None
        return {"id": chunk_id, "text": c["text"], "path": c["path"],
                "source": prov.get(chunk_id, "unknown (no provenance recorded)")}
