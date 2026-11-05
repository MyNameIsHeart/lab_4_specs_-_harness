#!/usr/bin/env python3
"""monitor.py: the course proxy plus a live dashboard of the agent's traffic.

    /usr/bin/python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]
    ANTHROPIC_BASE_URL=http://localhost:8041 claude
    open http://localhost:8042

Relays every request exactly like proxy.py. Relay threads only hand raw events
to one capture worker (a queue); the worker parses, pairs, summarizes and
publishes to the page over Server-Sent Events. Standard library only (3.9+).
"""

import argparse
import codecs
import hashlib
import http.client
import json
import os
import queue
import re
import signal
import socket
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# Same hop-by-hop list as proxy.py: never forwarded.
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}
SECRET = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}
HARNESS_RE = re.compile(
    r"<(system-reminder|task-notification|command-name|command-message|command-args|"
    r"local-command-stdout|local-command-caveat)>([\s\S]*?)</\1>")
ARG_KEYS = ("file_path", "command", "pattern", "url", "query", "description", "prompt")
AGENT_TOOLS = ("Agent", "Task")
FINAL = ("done", "error", "aborted")
MAX_BODIES = 300 * 1024 * 1024

UPSTREAM = "https://api.anthropic.com"
VERBOSE = False
UI_PORT = 8042
BOOT = uuid.uuid4().hex[:16]
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")

LOCK = threading.RLock()        # guards everything below; UI handlers read under it
EVENTS = queue.Queue()          # relay threads -> the capture worker
EXCHANGES = {}                  # id -> Exchange
SESSIONS = {}                   # session key -> Session
CALLS = {}                      # tool_use id -> (Exchange, call dict)
CALL_INPUTS = {}                # tool_use id -> input, for Agent calls (parent links)
NEXT_ID = [1]
BODY_BYTES = [0]
DIRTY = set()                   # streaming exchanges with unpublished changes
CLIENTS = []                    # one queue per /events connection
CLIENTS_LOCK = threading.Lock()


# ---------------------------------------------------------------- helpers

def redact(items):
    return [[k, "[redacted]" if k.lower() in SECRET else v] for k, v in items]


def hms(t):
    return datetime.fromtimestamp(t).strftime("%H:%M:%S")


def kfmt(n):
    if n >= 1000000:
        return "%.1fM" % (n / 1e6)
    if n >= 1000:
        return "%.1fk" % (n / 1e3)
    return str(n)


def strip_cc(x):
    if isinstance(x, dict):
        return {k: strip_cc(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [strip_cc(v) for v in x]
    return x


def sig(x):
    return hashlib.sha1(json.dumps(strip_cc(x), sort_keys=True).encode()).hexdigest()[:20]


def blocks_of(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def split_harness(text):
    """[(is_harness, tag, text)] in order."""
    out, last = [], 0
    for m in HARNESS_RE.finditer(text):
        if m.start() > last:
            out.append((False, None, text[last:m.start()]))
        out.append((True, m.group(1), m.group(0)))
        last = m.end()
    if last < len(text):
        out.append((False, None, text[last:]))
    return out


def plain_text(content):
    """The non-harness text of a user message."""
    parts = []
    for b in blocks_of(content):
        if b.get("type") == "text" and isinstance(b.get("text"), str):
            for h, _, t in split_harness(b["text"]):
                if not h and t.strip():
                    parts.append(t.strip())
    return "\n".join(parts)


def result_text(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text") or "" for b in blocks_of(content) if b.get("type") == "text")


def main_arg(inp, limit=80):
    if isinstance(inp, dict):
        for k in ARG_KEYS:
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                return k, " ".join(v.split())[:limit]
    return None, ""


def short_arg(inp):
    """The main argument for rows: a file path shows as its file name only."""
    k, v = main_arg(inp, 100000)
    if k == "file_path":
        v = os.path.basename(v.rstrip("/")) or v
    return v[:80]


def mkline(kind, label, text, quote=False, plus=0, title=None):
    """One timeline line: label + text, at most 60 characters."""
    full = " ".join(str(text).split())
    tail = " (+%d)" % plus if plus else ""
    room = 60 - len(label) - 1 - len(tail) - (2 if quote else 0)
    t = full if len(full) <= room else full[:max(room - 1, 1)] + "…"
    if quote:
        t = '"%s"' % t
    return {"kind": kind, "label": label, "text": t + tail,
            "title": (title or ("%s %s" % (label, full)))[:600]}


# ---------------------------------------------------------------- records

class Session:
    def __init__(self, key, label):
        self.key, self.label = key, label
        self.main = None
        self.subs = {}          # agent id -> Thread
        self.by_first = {}      # first user text -> Thread (agents without headers)
        self.agent_calls = []   # (Exchange, call) of Agent tool calls


class Thread:
    def __init__(self, session, label, kind, agent_id=None):
        self.session, self.label, self.kind, self.agent_id = session, label, kind, agent_id
        self.key = "%s/%s" % (session.label, "side" if kind == "side" else label)
        self.title = ""
        self.parent = None      # {"ex": id, "call": tool_use id}
        self.first_prompt = ""
        self.ex_ids = []
        self.waiting = set()    # tool_use ids still waiting for a result
        self.sub_index = 0


class SSEParser:
    """Line buffer + incremental UTF-8 decoder: chunks may split events and characters."""

    def __init__(self):
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.buf = ""
        self.event = None
        self.data = []

    def feed(self, chunk, final=False):
        text = self.dec.decode(chunk, final)
        if final:
            text += "\n\n"
        lines = (self.buf + text).split("\n")
        self.buf = lines.pop()
        out = []
        for line in lines:
            if line.endswith("\r"):
                line = line[:-1]
            if line == "":
                if self.data or self.event:
                    out.append((self.event, "\n".join(self.data)))
                self.event, self.data = None, []
            elif line.startswith(":"):
                continue
            else:
                name, _, val = line.partition(":")
                if val.startswith(" "):
                    val = val[1:]
                if name == "event":
                    self.event = val.strip()
                elif name == "data":
                    self.data.append(val)
        return out


class Reply:
    """The reply assembled from SSE events (or a plain JSON reply)."""

    def __init__(self):
        self.model = None
        self.blocks = []
        self.by_index = {}
        self.stop_reason = None
        self.usage = {}
        self.error = None
        self.unknown = 0
        self.stopped = False

    def event(self, name, data):
        """Apply one event; returns a block when it is complete."""
        try:
            d = json.loads(data)
        except ValueError:
            self.unknown += 1
            return None
        if not isinstance(d, dict):
            self.unknown += 1
            return None
        t = d.get("type") or name
        if t == "message_start":
            m = d.get("message") if isinstance(d.get("message"), dict) else {}
            self.model = m.get("model") or self.model
            if isinstance(m.get("usage"), dict):
                self.usage = dict(m["usage"])
        elif t == "content_block_start":
            cb = dict(d.get("content_block") or {}) if isinstance(d.get("content_block"), dict) else {}
            if cb.get("type") == "tool_use":
                cb["partial_json"] = ""
            if "signature" in cb:
                cb["signature_len"] = len(cb.pop("signature") or "")
            self.by_index[d.get("index", len(self.blocks))] = cb
            self.blocks.append(cb)
        elif t == "content_block_delta":
            cb = self.by_index.get(d.get("index"))
            delta = d.get("delta") if isinstance(d.get("delta"), dict) else {}
            if cb is None:
                self.unknown += 1
                return None
            dt = delta.get("type")
            if dt == "text_delta":
                cb["text"] = (cb.get("text") or "") + (delta.get("text") or "")
            elif dt == "thinking_delta":
                cb["thinking"] = (cb.get("thinking") or "") + (delta.get("thinking") or "")
                if delta.get("estimated_tokens") is not None:
                    cb["estimated_tokens"] = delta["estimated_tokens"]
            elif dt == "signature_delta":
                cb["signature_len"] = cb.get("signature_len", 0) + len(delta.get("signature") or "")
            elif dt == "input_json_delta":
                cb["partial_json"] = (cb.get("partial_json") or "") + (delta.get("partial_json") or "")
            else:
                self.unknown += 1
        elif t == "content_block_stop":
            cb = self.by_index.get(d.get("index"))
            if cb is not None:
                if "partial_json" in cb:
                    raw = cb.pop("partial_json")
                    if raw.strip():
                        try:
                            cb["input"] = json.loads(raw)
                        except ValueError:
                            cb["input"], cb["input_raw"] = {}, raw
                return cb
        elif t == "message_delta":
            delta = d.get("delta") if isinstance(d.get("delta"), dict) else {}
            if delta.get("stop_reason"):
                self.stop_reason = delta["stop_reason"]
            if isinstance(d.get("usage"), dict):
                for k, v in d["usage"].items():
                    if v is not None:
                        self.usage[k] = v
        elif t == "message_stop":
            self.stopped = True
        elif t == "ping":
            pass
        elif t == "error":
            self.error = d.get("error") if isinstance(d.get("error"), dict) else d
        else:
            self.unknown += 1
        return None

    def from_json(self, d):
        if not isinstance(d, dict):
            return
        if d.get("type") == "error" or ("error" in d and "content" not in d):
            self.error = d.get("error") if isinstance(d.get("error"), dict) else d
            return
        self.model = d.get("model")
        self.blocks = [dict(b) for b in d.get("content") or [] if isinstance(b, dict)]
        self.stop_reason = d.get("stop_reason")
        self.usage = dict(d["usage"]) if isinstance(d.get("usage"), dict) else {}
        self.stopped = True

    def snapshot(self):
        return {"model": self.model, "blocks": [dict(b) for b in self.blocks],
                "stop_reason": self.stop_reason, "usage": dict(self.usage),
                "error": self.error, "unknown": self.unknown}


class Exchange:
    def __init__(self, xid, method, path, headers, body, t0):
        self.id, self.version, self.state = xid, 0, "pending"
        self.method, self.path = method, path
        self.req_headers = headers          # already redacted
        self.resp_headers = []
        self.body, self.req_size = body, len(body)
        self.t_start, self.t_first, self.t_end = t0, None, None
        self.status, self.reason, self.error = None, "", None
        self.raw = bytearray()
        self.reply, self.parser, self.sse, self.vdec = None, None, False, None
        self.is_msg = False
        self.session, self.thread = None, None
        self.hashes, self.n_msgs = [], 0
        self.prev, self.new_start, self.reply_of = None, 0, None
        self.model = self.max_tokens = self.sys_sig = self.tools_sig = None
        self.flags = {}
        self.calls = []                     # [{id, name, arg, short, state, from, thread}]
        self.results = {}                   # tool_use id -> {from, is_error, content}
        self.up = None
        self.dot = False
        self.ids = []
        self.evicted = False
        self.summary = None


# ---------------------------------------------------------------- publishing

def publish(kind, data):
    payload = ("event: %s\ndata: %s\n\n" % (kind, json.dumps(data, separators=(",", ":")))).encode()
    with CLIENTS_LOCK:
        for q in list(CLIENTS):
            if q.qsize() > 5000:          # a tab that stopped reading: drop it, it reconnects
                CLIENTS.remove(q)
                q.put(None)
            else:
                q.put(payload)


def summarize(ex):
    r = ex.reply
    u = r.usage if r else {}

    def n(k):
        v = u.get(k)
        return v if isinstance(v, int) else 0

    tin = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens")
    det = u.get("output_tokens_details") if isinstance(u.get("output_tokens_details"), dict) else {}
    th = ex.thread
    err = ex.error
    if not err and r and r.error:
        e = r.error
        err = "%s: %s" % (e.get("type", "error"), e.get("message", "")) if isinstance(e, dict) else str(e)
    red = (ex.status or 0) >= 400 or ex.state == "error" or bool(r and r.error)
    amber = (ex.state == "aborted" or bool(r and r.stop_reason == "max_tokens")
             or any(c["state"] == "none" for c in ex.calls))
    down = down_line(ex)
    if down is None and err:
        down = mkline("error", "ERROR", err)
    return {
        "id": ex.id, "version": ex.version, "msg": ex.is_msg,
        "session": ex.session.label if ex.session else "",
        "thread": th.label if th else "", "thread_key": th.key if th else "",
        "thread_kind": th.kind if th else "", "thread_title": th.title if th else "",
        "thread_agent": th.agent_id if th else None, "thread_parent": th.parent if th else None,
        "sub_index": th.sub_index if th else 0,
        "state": ex.state, "status": ex.status, "method": ex.method, "path": ex.path,
        "t_start": ex.t_start, "t_first": ex.t_first, "t_end": ex.t_end,
        "tokens": {"in": tin, "cached": (n("cache_read_input_tokens") / tin) if tin else 0,
                   "out": n("output_tokens"), "input": n("input_tokens"),
                   "cache_read": n("cache_read_input_tokens"),
                   "cache_write": n("cache_creation_input_tokens"),
                   "thinking": det.get("thinking_tokens") or 0},
        "stop_reason": r.stop_reason if r else None,
        "model": (r.model if r and r.model else ex.model),
        "up": ex.up, "down": down,
        "calls": [dict(c) for c in ex.calls],
        "flags": dict(ex.flags), "red": red, "amber": amber, "dot": ex.dot, "error": err,
        "n_msgs": ex.n_msgs, "new_start": ex.new_start, "req_size": ex.req_size,
        "ids": ex.ids, "evicted": ex.evicted,
    }


def bump(ex):
    """Re-summarize and send a new `exchange` event (call under LOCK)."""
    ex.version += 1
    ex.summary = summarize(ex)
    publish("exchange", ex.summary)


def down_line(ex):
    r = ex.reply
    if r is None:
        return None
    uses = [b for b in r.blocks if b.get("type") == "tool_use"]
    if uses:
        b = uses[0]
        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
        name = b.get("name") or "?"
        return mkline("call", "CALL", ("%s %s" % (name, short_arg(inp))).strip(), plus=len(uses) - 1,
                      title=("CALL %s %s" % (name, main_arg(inp, 100000)[1])).strip())
    for b in r.blocks:
        text = b.get("text") if b.get("type") == "text" else None
        if isinstance(text, str) and text.strip():
            first = next(l for l in text.splitlines() if l.strip())
            return mkline("model", "MODEL", first.strip(), quote=True, title="MODEL " + text[:600])
    if r.stopped and any(b.get("type") in ("thinking", "redacted_thinking") for b in r.blocks):
        return mkline("thinking", "THINKING", "only, no text (stop %s)" % (r.stop_reason or "?"))
    return None


# ---------------------------------------------------------------- capture worker

def session_for(key):
    s = SESSIONS.get(key)
    if s is None:
        s = SESSIONS[key] = Session(key, "S%d" % (len(SESSIONS) + 1))
    return s


def link(th, cex, call):
    """Link a subagent thread to the Agent call that started it."""
    inp = CALL_INPUTS.get(call["id"]) or {}
    th.parent = {"ex": cex.id, "call": call["id"]}
    th.title = str(inp.get("description") or th.title or "")[:120]
    call["thread"] = th.key
    for xid in th.ex_ids:
        bump(EXCHANGES[xid])
    bump(cex)


def prompt_matches(prompt, first):
    prompt = (prompt or "").strip()
    return bool(prompt) and (prompt == first or (len(prompt) > 20 and prompt in first))


def register_call(ex, b):
    tid = b.get("id")
    name = b.get("name") or "?"
    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    call = {"id": tid, "name": name, "arg": main_arg(inp)[1], "short": short_arg(inp),
            "full": main_arg(inp, 100000)[1],
            "state": "waiting", "from": None, "thread": None}
    ex.calls.append(call)
    if not tid:
        return
    CALLS[tid] = (ex, call)
    if ex.thread:
        ex.thread.waiting.add(tid)
    if name in AGENT_TOOLS and ex.session:
        CALL_INPUTS[tid] = inp
        ex.session.agent_calls.append((ex, call))
        for th in ex.session.subs.values():
            if th.parent is None and prompt_matches(inp.get("prompt"), th.first_prompt):
                link(th, ex, call)
                break


def on_request(ex):
    body = None
    if ex.body:
        try:
            body = json.loads(ex.body)
        except ValueError:
            body = None
    if not isinstance(body, dict):
        body = None
    h = {k.lower(): v for k, v in ex.req_headers}
    msgs = body.get("messages") if body else None
    if VERBOSE:
        dump_request(ex, body)
    if ex.method != "POST" or not isinstance(msgs, list):
        with LOCK:
            if h.get("x-claude-code-session-id"):
                ex.session = session_for(h["x-claude-code-session-id"])
            bump(ex)
        return

    # Heavy work outside the lock.
    meta = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    uid = meta.get("user_id")
    ids, meta_session = [], None
    if isinstance(uid, str) and uid:
        try:
            parsed = json.loads(uid)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            ids = [v for v in parsed.values() if isinstance(v, str) and len(v) >= 8]
            if isinstance(parsed.get("session_id"), str):
                meta_session = parsed["session_id"]
        else:
            ids = re.findall(r"[0-9a-fA-F][0-9a-fA-F-]{15,}", uid)
            m = re.search(r"session_([0-9a-fA-F-]{16,})", uid)
            meta_session = m.group(1) if m else None
    hashes = [sig(m) for m in msgs]
    sys_sig, tools = sig(body.get("system")), body.get("tools")
    tools_sig = sig(tools)
    first_text = plain_text(msgs[0].get("content")) if msgs and isinstance(msgs[0], dict) else ""

    with LOCK:
        ex.is_msg, ex.ids, ex.hashes, ex.n_msgs = True, ids, hashes, len(msgs)
        ex.model, ex.max_tokens = body.get("model"), body.get("max_tokens")
        ex.sys_sig, ex.tools_sig = sys_sig, tools_sig
        sid = h.get("x-claude-code-session-id")
        session = ex.session = session_for(sid or meta_session or "(no session)")
        agent = h.get("x-claude-code-agent-id")

        # Thread.
        if not tools:
            th = Thread(session, "side", "side", agent)
        elif agent:
            th = session.subs.get(agent)
            if th is None:
                th = session.subs[agent] = Thread(session, "sub-%d" % (len(session.subs) + 1), "sub", agent)
                th.sub_index = len(session.subs)
                th.first_prompt = first_text
                for cex, call in reversed(session.agent_calls):
                    if not call.get("thread") and prompt_matches(CALL_INPUTS.get(call["id"], {}).get("prompt"), first_text):
                        link(th, cex, call)
                        break
        elif sid or meta_session:
            th = session.main
            if th is None:
                th = session.main = Thread(session, "main", "main")
                th.title = first_text[:60]
        else:
            key = first_text[:4000]
            th = session.by_first.get(key)
            if th is None:
                k = len(session.by_first) + 1
                th = session.by_first[key] = Thread(session, "main" if k == 1 else "main-%d" % k, "main")
                th.title = first_text[:60]
        ex.thread = th

        # New in this request: the latest earlier request whose messages are a prefix.
        flags, base = {}, None
        prev = None
        for pid in reversed(th.ex_ids):
            p = EXCHANGES[pid]
            if p.n_msgs <= len(hashes) and hashes[:p.n_msgs] == p.hashes:
                prev = p
                break
        if prev is not None and prev.n_msgs == len(hashes):
            flags["retry_of"] = prev.id
            ex.prev, ex.new_start, ex.reply_of = prev.prev, prev.new_start, prev.reply_of
            base = prev
        elif prev is not None:
            ns = prev.n_msgs
            if ns < len(msgs) and isinstance(msgs[ns], dict) and msgs[ns].get("role") == "assistant":
                ex.reply_of = prev.id
                ns += 1
            ex.prev, ex.new_start, base = prev, ns, prev
        elif th.ex_ids:
            last = EXCHANGES[th.ex_ids[-1]]
            i = 0
            while i < min(len(hashes), len(last.hashes)) and hashes[i] == last.hashes[i]:
                i += 1
            flags["history_changed_at"] = i
            ex.new_start, base = i, last
        if ex.reply_of:
            flags["reply_of"] = ex.reply_of
        if base is not None:
            changes = [name for name, a, b in (("system", sys_sig, base.sys_sig), ("tools", tools_sig, base.tools_sig),
                                               ("model", ex.model, base.model), ("max_tokens", ex.max_tokens, base.max_tokens))
                       if a != b]
            if changes:
                flags["changes"] = changes
        ex.flags = flags

        # Pair tool results with their calls; mark calls left without a result.
        touched, here, results = set(), set(), []
        text_kind = {"sub": "task", "side": "harness"}.get(th.kind, "you")
        you = task = harness = None
        for mi, m in enumerate(msgs):
            if not isinstance(m, dict) or m.get("role") != "user":
                continue
            is_new = mi >= ex.new_start
            for b in blocks_of(m.get("content")):
                t = b.get("type")
                if t == "tool_result":
                    tid = b.get("tool_use_id")
                    if is_new:
                        results.append(b)
                        if b.get("is_error"):
                            ex.dot = True
                    ref = CALLS.get(tid)
                    if ref is None:
                        continue
                    here.add(tid)
                    cex, call = ref
                    if call["state"] in ("waiting", "none"):
                        call["state"] = "error" if b.get("is_error") else "ok"
                        call["from"] = ex.id
                        cex.results[tid] = {"from": ex.id, "is_error": bool(b.get("is_error")),
                                            "content": b.get("content")}
                        if cex.thread:
                            cex.thread.waiting.discard(tid)
                        touched.add(cex)
                        if call["name"] in AGENT_TOOLS and not call.get("thread") and cex.session:
                            txt = result_text(b.get("content"))
                            for sth in cex.session.subs.values():
                                if sth.parent is None and sth.agent_id and sth.agent_id in txt:
                                    link(sth, cex, call)
                                    break
                elif t == "text" and is_new and isinstance(b.get("text"), str):
                    for hh, tag, seg in split_harness(b["text"]):
                        if hh:
                            notif = tag == "task-notification" or "<task-notification>" in seg
                            if harness is None or (notif and harness != "subagent result"):
                                harness = "subagent result" if notif else tag
                        elif seg.strip():
                            if text_kind == "you" and you is None:
                                you = seg.strip()
                            elif text_kind == "task" and task is None:
                                task = seg.strip()
                            elif text_kind == "harness" and harness is None:
                                harness = '"%s"' % " ".join(seg.split())[:50]
        for tid in list(th.waiting):
            if tid in here:
                continue
            cex, call = CALLS[tid]
            if cex.id < ex.id and cex.state in FINAL:
                call["state"] = "none"
                th.waiting.discard(tid)
                touched.add(cex)

        # The ↑ line.
        if you:
            ex.up = mkline("you", "YOU", you, quote=True)
        elif results:
            ref = CALLS.get(results[0].get("tool_use_id"))
            name, short, full = (ref[1]["name"], ref[1]["short"], ref[1]["full"]) if ref else ("?", "", "")
            ex.up = mkline("result", "RESULT", ("%s %s" % (name, short)).strip(), plus=len(results) - 1,
                           title=("RESULT %s %s" % (name, full)).strip())
        elif task:
            ex.up = mkline("task", "TASK", task, quote=True)
        elif harness:
            ex.up = mkline("harness", "HARNESS", harness)

        th.ex_ids.append(ex.id)
        bump(ex)
        for cex in touched:
            if cex is not ex:
                bump(cex)


def on_headers(ex, status, reason, headers, t):
    ctype = ""
    for k, v in headers:
        if k.lower() == "content-type":
            ctype = v.lower()
    with LOCK:
        ex.status, ex.reason, ex.t_first = status, reason, t
        ex.resp_headers = redact(headers)
        ex.state = "streaming"
        ex.sse = "text/event-stream" in ctype
        ex.reply = Reply()
        ex.parser = SSEParser() if ex.sse else None
        bump(ex)
    if VERBOSE:
        lines = ["", "[%s] <<< #%d %s %s" % (hms(t), ex.id, status, reason)]
        lines += ["    %s: %s" % (k, v) for k, v in ex.resp_headers]
        print("\n".join(lines), flush=True)
        ex.vdec = codecs.getincrementaldecoder("utf-8")("replace")


def on_chunk(ex, chunk):
    with LOCK:
        if ex.raw is not None:
            ex.raw += chunk
            BODY_BYTES[0] += len(chunk)
        if ex.parser is not None:
            for name, data in ex.parser.feed(chunk):
                done = ex.reply.event(name, data)
                if done is not None and done.get("type") == "tool_use":
                    register_call(ex, done)
        DIRTY.add(ex)
    if VERBOSE and ex.vdec is not None:
        sys.stdout.write(ex.vdec.decode(chunk))
        sys.stdout.flush()


def on_end(ex, t, err=None, state="done", status=None):
    with LOCK:
        if ex.reply is None:
            ex.reply = Reply()
        if ex.parser is not None:
            for name, data in ex.parser.feed(b"", final=True):
                done = ex.reply.event(name, data)
                if done is not None and done.get("type") == "tool_use":
                    register_call(ex, done)
        elif ex.raw and state == "done":
            try:
                ex.reply.from_json(json.loads(bytes(ex.raw)))
            except ValueError:
                pass
            for b in ex.reply.blocks:
                if b.get("type") == "tool_use":
                    register_call(ex, b)
        if state == "done" and ex.sse and not ex.reply.stopped and (ex.status or 0) < 400:
            state, err = "error", "stream ended before message_stop"
        if status is not None and ex.status is None:
            ex.status = status
        ex.state, ex.t_end = state, t
        if err:
            ex.error = err
        DIRTY.discard(ex)
        bump(ex)
        if ex.reply.blocks or ex.reply.error:
            publish("reply", {"id": ex.id, "version": ex.version, "reply": ex.reply.snapshot()})
        evict()
        line = terminal_line(ex)
    print(line, flush=True)


def terminal_line(ex):
    s = ex.summary
    tk = s["tokens"]
    parts = [hms(ex.t_start), "#%d" % ex.id, s["thread"] or "-", ex.method, ex.path.split("?")[0],
             str(ex.status or "-"), "%.1fs" % ((ex.t_end or time.time()) - ex.t_start)]
    if ex.is_msg and ex.reply and (tk["in"] or tk["out"]):
        parts.append("in %s (%d%% cached) out %s" % (kfmt(tk["in"]), round(tk["cached"] * 100), kfmt(tk["out"])))
    if ex.state != "done" or s["error"]:
        parts.append("%s%s" % (ex.state, (": " + s["error"]) if s["error"] else ""))
    return " ".join(parts)


def evict():
    if BODY_BYTES[0] <= MAX_BODIES:
        return
    for xid in sorted(EXCHANGES):
        ex = EXCHANGES[xid]
        if ex.state not in FINAL or ex.evicted:
            continue
        BODY_BYTES[0] -= len(ex.body or b"") + len(ex.raw or b"")
        ex.body, ex.raw, ex.evicted = None, None, True
        bump(ex)
        if BODY_BYTES[0] <= MAX_BODIES:
            break


def dump_request(ex, body):
    lines = ["", "=" * 78, "[%s] >>> #%d %s %s" % (hms(ex.t_start), ex.id, ex.method, ex.path)]
    lines += ["    %s: %s" % (k, v) for k, v in ex.req_headers]
    if body is not None:
        lines.append(json.dumps(body, indent=2, ensure_ascii=False))
    elif ex.body:
        lines.append(ex.body.decode("utf-8", "replace"))
    print("\n".join(lines), flush=True)


def handle(ev):
    kind, xid = ev[0], ev[1]
    ex = EXCHANGES.get(xid)
    if ex is None:
        return
    if kind == "request":
        on_request(ex)
    elif kind == "headers":
        on_headers(ex, *ev[2:])
    elif kind == "chunk":
        on_chunk(ex, ev[2])
    elif kind == "end":
        on_end(ex, ev[2])
    elif kind == "error":
        on_end(ex, ev[3], ev[2], "error", ev[4])
    elif kind == "aborted":
        on_end(ex, ev[2], "the agent disconnected", "aborted")


def worker():
    last = 0.0
    while True:
        try:
            ev = EVENTS.get(timeout=0.1)
        except queue.Empty:
            ev = None
        if ev is not None:
            try:
                handle(ev)
            except Exception as e:  # the worker must never die
                print("monitor: capture error on #%s: %r" % (ev[1], e), flush=True)
        now = time.time()
        if DIRTY and now - last >= 0.25:     # `reply` at most 4 times per second
            last = now
            with LOCK:
                for ex in list(DIRTY):
                    bump(ex)
                    publish("reply", {"id": ex.id, "version": ex.version, "reply": ex.reply.snapshot()})
                DIRTY.clear()


# ---------------------------------------------------------------- proxy

class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (OSError, socket.timeout)):
            return
        print("monitor: %s from %s: %r" % (type(exc).__name__, client_address[0], exc), flush=True)


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def do_GET(self):
        self.relay()

    do_POST = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET

    def relay(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b""
        with LOCK:  # the exchange exists before we connect upstream
            xid = NEXT_ID[0]
            NEXT_ID[0] += 1
            EXCHANGES[xid] = Exchange(xid, self.command, self.path, redact(self.headers.items()), body, time.time())
            BODY_BYTES[0] += len(body)
        EVENTS.put(("request", xid))
        self.close_connection = True

        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        upstream = conn_cls(target.netloc, timeout=10)
        try:
            upstream.connect()
            upstream.sock.settimeout(600)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP}
            upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
            reply = upstream.getresponse()
        except (OSError, http.client.HTTPException) as e:
            msg = "cannot reach %s: %s" % (UPSTREAM, e)
            EVENTS.put(("error", xid, msg, time.time(), 502))
            try:
                self.send_error(502, "proxy: " + msg)
            except OSError:
                pass
            upstream.close()
            return

        EVENTS.put(("headers", xid, reply.status, reply.reason, reply.getheaders(), time.time()))
        try:
            self.send_response(reply.status, reply.reason)
            for name, value in reply.getheaders():
                if name.lower() not in SKIP and name.lower() != "content-encoding":
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
        except OSError:
            EVENTS.put(("aborted", xid, time.time()))
            upstream.close()
            return
        if self.command == "HEAD":
            upstream.close()
            EVENTS.put(("end", xid, time.time()))
            return
        while True:
            try:
                chunk = reply.read1(65536)
            except (OSError, http.client.HTTPException, ValueError) as e:
                EVENTS.put(("error", xid, "upstream broke mid-reply: %s" % (e or type(e).__name__), time.time(), None))
                upstream.close()
                return
            if not chunk:
                break
            try:  # forwarding comes first
                self.wfile.write(chunk)
                self.wfile.flush()
            except OSError:
                EVENTS.put(("aborted", xid, time.time()))
                upstream.close()
                return
            EVENTS.put(("chunk", xid, chunk))
        upstream.close()
        EVENTS.put(("end", xid, time.time()))


# ---------------------------------------------------------------- dashboard server

def list_json():
    with LOCK:
        return json.dumps([ex.summary for _, ex in sorted(EXCHANGES.items()) if ex.summary]).encode()


def reply_map(ex):
    """Message index -> the exchange whose reply that (assistant) message is."""
    out, p, guard = {}, ex.prev, 0
    while p is not None and guard < 100000:
        out[p.n_msgs] = p.id
        p, guard = p.prev, guard + 1
    return out


def detail_json(xid):
    with LOCK:
        ex = EXCHANGES.get(xid)
        if ex is None or ex.summary is None:
            return None
        body, raw = ex.body, (bytes(ex.raw) if ex.raw is not None else b"")
        d = {"summary": ex.summary, "req_headers": ex.req_headers, "resp_headers": ex.resp_headers,
             "new_start": ex.new_start, "reply_of": ex.reply_of,
             "reply": ex.reply.snapshot() if ex.reply else None,
             "results": dict(ex.results), "reply_map": reply_map(ex), "evicted": ex.evicted}
        out = json.dumps(d)
    # Parsed on demand, outside the lock.
    extra = {"body": None, "body_text": None, "raw_reply": raw.decode("utf-8", "replace")}
    if body:
        try:
            extra["body"] = json.loads(body)
        except ValueError:
            extra["body_text"] = body.decode("utf-8", "replace")
    return (out[:-1] + "," + json.dumps(extra)[1:]).encode()


class UIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def send_bytes(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def host_ok(self):
        if self.headers.get("Host", "") in ("localhost:%d" % UI_PORT, "127.0.0.1:%d" % UI_PORT):
            return True
        self.send_bytes(403, b"forbidden host\n", "text/plain; charset=utf-8")
        return False

    def do_POST(self):
        if self.host_ok():
            self.send_bytes(405, b"method not allowed\n", "text/plain; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return
        path = urlsplit(self.path).path
        if path in STATIC_FILES:
            name, ctype = STATIC_FILES[path]
            try:
                with open(os.path.join(STATIC, name), "rb") as f:
                    data = f.read()
            except OSError:
                return self.send_bytes(404, b"missing static file\n", "text/plain; charset=utf-8")
            return self.send_bytes(200, data, ctype)
        if path == "/api/exchanges":
            return self.send_bytes(200, list_json(), "application/json")
        m = re.fullmatch(r"/api/exchanges/(\d+)", path)
        if m:
            data = detail_json(int(m.group(1)))
            if data is None:
                return self.send_bytes(404, b'{"error": "no such exchange"}', "application/json")
            return self.send_bytes(200, data, "application/json")
        if path == "/events":
            return self.events()
        self.send_bytes(404, b"not found\n", "text/plain; charset=utf-8")

    def events(self):
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        q = queue.Queue()
        with CLIENTS_LOCK:
            CLIENTS.append(q)
        try:
            self.wfile.write(("event: hello\ndata: %s\n\n" % json.dumps({"boot": BOOT})).encode())
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    item = b": ping\n\n"
                if item is None:
                    break
                self.wfile.write(item)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with CLIENTS_LOCK:
                if q in CLIENTS:
                    CLIENTS.remove(q)


# ---------------------------------------------------------------- main

def _interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    global UPSTREAM, VERBOSE, UI_PORT
    ap = argparse.ArgumentParser(description="Relay an agent's API traffic and show it live in the browser.")
    ap.add_argument("--port", type=int, default=8041, help="proxy port (default 8041)")
    ap.add_argument("--ui-port", type=int, default=8042, help="dashboard port (default 8042)")
    ap.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    ap.add_argument("--verbose", action="store_true", help="also print proxy.py's full dump (headers redacted)")
    a = ap.parse_args()
    UPSTREAM, VERBOSE, UI_PORT = a.upstream.rstrip("/"), a.verbose, a.ui_port
    # Explicit handlers: a shell may start us with SIGINT ignored.
    signal.signal(signal.SIGINT, _interrupt)
    signal.signal(signal.SIGTERM, _interrupt)
    proxy = QuietServer(("127.0.0.1", a.port), ProxyHandler)
    ui = QuietServer(("127.0.0.1", a.ui_port), UIHandler)
    for target in (worker, proxy.serve_forever, ui.serve_forever):
        threading.Thread(target=target, daemon=True).start()
    print("proxy      http://localhost:%d  ->  %s" % (a.port, UPSTREAM))
    print("agent      ANTHROPIC_BASE_URL=http://localhost:%d claude" % a.port)
    print("dashboard  http://localhost:%d" % a.ui_port, flush=True)
    try:
        while True:
            time.sleep(0.2)
    except KeyboardInterrupt:
        print("\nmonitor: stopped", flush=True)
    os._exit(0)  # daemon threads (open streams, tabs) must not delay the exit


if __name__ == "__main__":
    main()
