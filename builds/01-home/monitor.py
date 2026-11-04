#!/usr/bin/env python3
"""monitor.py: live agent traffic dashboard for Lab 4.

A relay that behaves like proxy.py (same upstream, path and headers, reply
streamed back chunk by chunk) and also captures every exchange and serves a
live dashboard on a second port. Standard library only.

    python3 monitor.py                         # proxy :8041, dashboard :8042
    ANTHROPIC_BASE_URL=http://localhost:8041 claude
    open http://localhost:8042

Relay threads never parse anything: they hand raw events (request, response
headers, chunks, end, error) to one capture worker thread through a queue.
The worker parses, pairs, summarizes and publishes; UI handlers read
snapshots under a lock.
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
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

# Same hop-by-hop list as proxy.py (plus accept-encoding, so replies are plain).
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}
SECRET_HEADERS = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}
HARNESS_TAGS = ("system-reminder", "task-notification", "command-name", "command-message",
                "command-args", "local-command-stdout", "local-command-caveat")
TAG_RE = re.compile(r"<(" + "|".join(HARNESS_TAGS) + r")>[\s\S]*?</\1>")
ARG_KEYS = ("file_path", "command", "pattern", "url", "query", "description", "prompt")
AGENT_TOOLS = ("Agent", "Task")
BODY_LIMIT = 300 * 1024 * 1024        # bytes of raw bodies kept before evicting the oldest
REPLY_PUSH_INTERVAL = 0.25            # at most 4 `reply` events per second per exchange
PING_INTERVAL = 15.0
CLIENT_QUEUE_MAX = 20000
FINAL = ("done", "error", "aborted")

UPSTREAM = "https://api.anthropic.com"
UI_PORT = 8042
VERBOSE = False
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
STOP = threading.Event()
BOOT = "%x" % int(time.time() * 1000)   # lets a page notice that the monitor restarted


# ----------------------------------------------------------------------------
# small helpers

def stamp(t: Optional[float] = None) -> str:
    return datetime.fromtimestamp(t if t is not None else time.time()).strftime("%H:%M:%S")


def redact(headers: List[Tuple[str, str]]) -> List[List[str]]:
    """A copy of the headers that is safe to display, serve or print."""
    return [[k, "[redacted]" if k.lower() in SECRET_HEADERS else v] for k, v in headers]


def one_line(s: str) -> str:
    return " ".join(s.split())


def cut(s: str, n: int, tail: bool = False) -> str:
    if len(s) <= n:
        return s
    if n <= 1:
        return "…"[:n]
    return ("…" + s[-(n - 1):]) if tail else (s[:n - 1] + "…")


def main_arg(inp: Any, limit: int = 80) -> Tuple[str, str]:
    """(key, value) of a tool call's main argument, value on one line, cut to `limit`."""
    if not isinstance(inp, dict):
        return "", ""
    for k in ARG_KEYS:
        v = inp.get(k)
        if v is None or v == "":
            continue
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        return k, cut(one_line(s), limit, tail=(k == "file_path"))
    return "", ""


def human_k(n: Optional[int]) -> str:
    if n is None:
        return "-"
    if n >= 1_000_000:
        return "%.1fM" % (n / 1_000_000)
    if n >= 1000:
        return "%.1fk" % (n / 1000)
    return str(n)


def strip_cc(x: Any) -> Any:
    """The value without any `cache_control` keys (they move between requests)."""
    if isinstance(x, dict):
        return {k: strip_cc(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [strip_cc(v) for v in x]
    return x


def digest(x: Any) -> str:
    s = json.dumps(strip_cc(x), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha1(s.encode("ascii")).hexdigest()


def blocks_of(msg: Any) -> List[Any]:
    """A message's content as a list of blocks (a string becomes one text block)."""
    if not isinstance(msg, dict):
        return []
    c = msg.get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    if isinstance(c, list):
        return c
    return []


def segments(text: str) -> List[Tuple[str, str, str]]:
    """Split text into ('harness', tag, span) and ('text', '', span) segments."""
    out = []
    pos = 0
    for m in TAG_RE.finditer(text):
        if m.start() > pos:
            out.append(("text", "", text[pos:m.start()]))
        out.append(("harness", m.group(1), m.group(0)))
        pos = m.end()
    if pos < len(text):
        out.append(("text", "", text[pos:]))
    return [s for s in out if s[0] == "harness" or s[2].strip()]


def result_text(block: Any) -> str:
    c = block.get("content") if isinstance(block, dict) else None
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def first_prompt(msgs: List[Any]) -> str:
    """The non-harness text of the first user message (the human's or the task's prompt)."""
    for m in msgs:
        if isinstance(m, dict) and m.get("role") == "user":
            parts = []
            for b in blocks_of(m):
                if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                    parts.extend(s[2] for s in segments(b["text"]) if s[0] == "text")
            return "\n".join(p.strip() for p in parts if p.strip())
    return ""


def system_text(system: Any) -> str:
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "\n".join(b.get("text", "") for b in system if isinstance(b, dict))
    return ""


ID_RE = re.compile(r"^[0-9a-fA-F][0-9a-fA-F-]{7,}$")


def metadata_ids(body: Any) -> Tuple[Optional[str], List[str]]:
    """(session id, every id) found in metadata.user_id (a JSON string, or the older
    `user_<hex>_account_<uuid>_session_<uuid>` form)."""
    meta = body.get("metadata") if isinstance(body, dict) else None
    uid = meta.get("user_id") if isinstance(meta, dict) else None
    if not isinstance(uid, str) or not uid:
        return None, []
    session, ids = None, []
    try:
        obj = json.loads(uid)
    except ValueError:
        obj = None
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and ID_RE.match(v):
                ids.append(v)
                if "session" in k.lower():
                    session = v
    else:
        for m in re.finditer(r"(user|account|session)_([0-9a-fA-F-]{8,})", uid):
            ids.append(m.group(2))
            if m.group(1) == "session":
                session = m.group(2)
    return session, ids


# ----------------------------------------------------------------------------
# reply assembly (runs on the capture worker only)

class Assembler:
    """Assembles a reply from SSE chunks. Chunks may split an event or a UTF-8
    character, so it uses an incremental decoder and a line buffer. Unknown or
    malformed events are counted and never raise."""

    def __init__(self) -> None:
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.buf = ""
        self.ev_name: Optional[str] = None
        self.ev_data: List[str] = []
        self.model: Optional[str] = None
        self.msg_id: Optional[str] = None
        self.blocks: Dict[Any, Dict[str, Any]] = {}
        self.order: List[Any] = []
        self.stop_reason: Optional[str] = None
        self.stop_sequence: Optional[str] = None
        self.usage: Dict[str, Any] = {}
        self.error: Any = None
        self.unknown: List[str] = []
        self.events = 0
        self.pings = 0
        self.stopped = False
        self.is_json = False

    # -- feeding
    def feed(self, chunk: bytes) -> List[Dict[str, Any]]:
        """Feed raw bytes; return the tool_use blocks completed by this chunk."""
        return self._text(self.decoder.decode(chunk))

    def finish(self) -> List[Dict[str, Any]]:
        done = self._text(self.decoder.decode(b"", final=True))
        if self.buf:
            done += self._line(self.buf)
            self.buf = ""
        if self.ev_data or self.ev_name:
            done += self._dispatch()
        return done

    def _text(self, text: str) -> List[Dict[str, Any]]:
        if not text:
            return []
        self.buf += text
        if "\n" not in self.buf:
            return []
        lines = self.buf.split("\n")
        self.buf = lines.pop()
        done: List[Dict[str, Any]] = []
        for line in lines:
            done += self._line(line[:-1] if line.endswith("\r") else line)
        return done

    def _line(self, line: str) -> List[Dict[str, Any]]:
        if line == "":
            return self._dispatch() if (self.ev_data or self.ev_name) else []
        if line.startswith(":"):
            return []
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            self.ev_name = value.strip()
        elif name == "data":
            self.ev_data.append(value)
        return []

    def _dispatch(self) -> List[Dict[str, Any]]:
        name, data = self.ev_name, "\n".join(self.ev_data)
        self.ev_name, self.ev_data = None, []
        self.events += 1
        try:
            obj = json.loads(data) if data.strip() else None
        except ValueError:
            obj = None
        etype = obj.get("type") if isinstance(obj, dict) and isinstance(obj.get("type"), str) else name
        if not isinstance(obj, dict):
            if etype == "ping":
                self.pings += 1
            elif etype == "error":                   # an error event whose data is not JSON
                self.error = {"message": data.strip()[:500] or "error event"}
            else:
                self.unknown.append(etype or "?")
            return []
        try:
            return self._event(etype or "?", obj)
        except Exception:  # never let a strange event break capture
            self.unknown.append(etype or "?")
            return []

    def _event(self, etype: str, obj: Dict[str, Any]) -> List[Dict[str, Any]]:
        if etype == "message_start":
            m = obj.get("message") or {}
            self.model = m.get("model") or self.model
            self.msg_id = m.get("id") or self.msg_id
            if isinstance(m.get("usage"), dict):
                self.usage = dict(m["usage"])
        elif etype == "content_block_start":
            idx = obj.get("index", len(self.order))
            blk = dict(obj.get("content_block") or {})
            blk.setdefault("type", "unknown")
            if blk["type"] in ("tool_use", "server_tool_use", "mcp_tool_use"):
                blk["_json"] = []
            blk["_open"] = True
            if idx not in self.blocks:
                self.order.append(idx)
            self.blocks[idx] = blk
        elif etype == "content_block_delta":
            idx = obj.get("index", 0)
            d = obj.get("delta") or {}
            dt = d.get("type")
            blk = self.blocks.get(idx)
            if blk is None:
                blk = {"type": {"text_delta": "text", "thinking_delta": "thinking",
                                "input_json_delta": "tool_use"}.get(dt, "unknown"), "_open": True}
                if blk["type"] == "tool_use":
                    blk["_json"] = []
                self.blocks[idx] = blk
                self.order.append(idx)
            if dt == "text_delta":
                blk["text"] = (blk.get("text") or "") + str(d.get("text") or "")
            elif dt == "thinking_delta":
                blk["thinking"] = (blk.get("thinking") or "") + str(d.get("thinking") or "")
                est = d.get("estimated_tokens")
                if isinstance(est, (int, float)):
                    blk["estimated_tokens"] = max(int(est), int(blk.get("estimated_tokens") or 0))
            elif dt == "signature_delta":
                blk["signature"] = (blk.get("signature") or "") + str(d.get("signature") or "")
            elif dt == "input_json_delta":
                blk.setdefault("_json", []).append(str(d.get("partial_json") or ""))
            elif dt == "citations_delta":
                blk.setdefault("citations", []).append(d.get("citation"))
            else:
                self.unknown.append("delta:%s" % dt)
        elif etype == "content_block_stop":
            blk = self.blocks.get(obj.get("index", 0))
            if blk is not None and blk.get("_open"):
                blk["_open"] = False
                if "_json" in blk:
                    s = "".join(blk.pop("_json"))
                    try:
                        blk["input"] = json.loads(s) if s.strip() else (blk.get("input") or {})
                    except ValueError:
                        blk["input_raw"] = s
                        blk["input_error"] = True
                if blk.get("type") == "tool_use":
                    return [blk]
        elif etype == "message_delta":
            d = obj.get("delta") or {}
            if d.get("stop_reason") is not None:
                self.stop_reason = d["stop_reason"]
            if d.get("stop_sequence") is not None:
                self.stop_sequence = d["stop_sequence"]
            if isinstance(obj.get("usage"), dict):
                for k, v in obj["usage"].items():
                    if v is not None:
                        self.usage[k] = v
        elif etype == "message_stop":
            self.stopped = True
        elif etype == "ping":
            self.pings += 1
        elif etype == "error":
            self.error = obj.get("error") or obj
        else:
            self.unknown.append(etype)
        return []

    def load_json(self, text: str) -> List[Dict[str, Any]]:
        """A non-stream (JSON) reply is used as is."""
        try:
            obj = json.loads(text)
        except ValueError:
            return []
        if not isinstance(obj, dict):
            return []
        self.is_json = True
        if obj.get("type") == "error" or ("error" in obj and "content" not in obj):
            self.error = obj.get("error") or obj
            return []
        self.model = obj.get("model") or self.model
        self.msg_id = obj.get("id") or self.msg_id
        self.stop_reason = obj.get("stop_reason")
        self.stop_sequence = obj.get("stop_sequence")
        if isinstance(obj.get("usage"), dict):
            self.usage = dict(obj["usage"])
        calls = []
        for i, b in enumerate(obj.get("content") or []):
            if isinstance(b, dict):
                blk = dict(b)
                blk["_open"] = False
                self.blocks[i] = blk
                self.order.append(i)
                if blk.get("type") == "tool_use":
                    calls.append(blk)
        self.stopped = True
        return calls

    # -- reading
    def block_list(self) -> List[Dict[str, Any]]:
        return [self.blocks[i] for i in self.order if i in self.blocks]

    def snapshot(self) -> Dict[str, Any]:
        out = []
        for b in self.block_list():
            c = {k: v for k, v in b.items() if not k.startswith("_")}
            if "_json" in b:
                c["input_partial"] = "".join(b["_json"])
            if b.get("_open"):
                c["streaming"] = True
            if isinstance(c.get("signature"), str):
                c["signature_len"] = len(c.pop("signature"))
            if isinstance(c.get("data"), str) and len(c["data"]) > 200:   # redacted_thinking
                c["data"] = "[%d chars]" % len(c["data"])
            out.append(c)
        return {"model": self.model, "id": self.msg_id, "blocks": out,
                "stop_reason": self.stop_reason, "stop_sequence": self.stop_sequence,
                "usage": dict(self.usage), "error": self.error, "unknown": list(self.unknown[:50]),
                "events": self.events, "pings": self.pings, "complete": self.stopped,
                "json": self.is_json}


def tokens_of(usage: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not usage:
        return None

    def num(k: str) -> int:
        v = usage.get(k)
        return int(v) if isinstance(v, (int, float)) else 0

    inp, cr, cw, out = num("input_tokens"), num("cache_read_input_tokens"), \
        num("cache_creation_input_tokens"), num("output_tokens")
    total = inp + cr + cw
    otd = usage.get("output_tokens_details")
    thinking = otd.get("thinking_tokens") if isinstance(otd, dict) else None
    return {"in": total, "input": inp, "cache_read": cr, "cache_write": cw,
            "cached": (cr / total) if total else 0.0, "out": out, "thinking": thinking}


# ----------------------------------------------------------------------------
# data model (owned by the capture worker; UI handlers read under STORE.lock)

class Call:
    """A tool_use block of a reply, joined later to its tool_result."""

    def __init__(self, xid: int, block: Dict[str, Any]) -> None:
        self.xid = xid
        self.id = str(block.get("id") or "")
        self.name = str(block.get("name") or "?")
        self.input = block.get("input")
        self.arg_key, self.arg = main_arg(self.input)
        self.state = "waiting"          # waiting | ok | error | none
        self.result_from: Optional[int] = None
        self.result_block: Any = None
        self.child: Optional[str] = None  # thread key of the subagent an Agent call started

    def public(self) -> Dict[str, Any]:
        return {"id": self.id, "name": self.name, "arg": self.arg, "arg_key": self.arg_key,
                "state": self.state, "from": self.result_from, "child": self.child}


class Thread:
    def __init__(self, key: str, name: str, session: str, kind: str) -> None:
        self.key, self.name, self.session, self.kind = key, name, session, kind
        self.title = ""
        self.agent_id: Optional[str] = None
        self.parent: Optional[Dict[str, Any]] = None   # {"xid", "call", "description"}
        self.xids: List[int] = []
        self.calls: Dict[str, Call] = {}               # tool_use id -> Call
        self.open_calls: Dict[str, Call] = {}          # waiting or "no result"


class Session:
    def __init__(self, label: str) -> None:
        self.label = label
        self.agents: Dict[str, str] = {}               # agent id -> thread key
        self.subs = 0
        self.others: Dict[str, str] = {}               # first-message digest -> thread key
        self.agent_calls: List[Call] = []
        self.pending_links: Dict[str, Call] = {}       # agent id named by a result -> Call


class Exchange:
    def __init__(self, xid: int, t: float, method: str, path: str,
                 headers: List[Tuple[str, str]], body: bytes) -> None:
        self.id = xid
        self.version = 0
        self.state = "pending"
        self.method, self.path = method, path
        self.status: Optional[int] = None
        self.reason = ""
        self.t_start, self.t_headers, self.t_first, self.t_end = t, None, None, None
        self.req_headers = redact(headers)
        self.resp_headers: List[List[str]] = []
        self.content_type = ""
        self.body: Optional[bytes] = body
        self.req_size = len(body)
        self.raw = bytearray()
        self.evicted = False
        self.error: Optional[str] = None
        self.asm = Assembler()
        self.last_push = 0.0
        # derived once per exchange
        self.is_message = False
        self.session = ""
        self.tkey: Optional[str] = None
        self.hashes: Optional[List[str]] = None
        self.new_start = 0
        self.reply_of: Optional[int] = None
        self.retry_of: Optional[int] = None
        self.history_at: Optional[int] = None
        self.prev_id: Optional[int] = None
        self.changes: List[str] = []
        self.up: Optional[Dict[str, str]] = None
        self.dot = False
        self.calls: List[Call] = []
        self.asst_src: Dict[int, int] = {}
        self.sys_hash = self.tools_hash = ""
        self.tool_names: List[str] = []
        self.model_req: Optional[str] = None
        self.max_tokens: Any = None
        self.summary: Dict[str, Any] = {}
        self.line_printed = False


class Client:
    def __init__(self) -> None:
        self.q: "queue.Queue[bytes]" = queue.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.dead = False


class Store:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.ex: Dict[int, Exchange] = {}
        self.order: List[int] = []
        self.sessions: Dict[str, Session] = {}
        self.threads: Dict[str, Thread] = {}
        self.body_bytes = 0
        self.mask_ids: set = set()
        self.clients: List[Client] = []
        self.clients_lock = threading.Lock()
        self.dirty: set = set()

    # -- SSE fan-out: the worker only enqueues, never blocks on a slow tab
    def broadcast(self, event: str, payload: Any) -> None:
        data = ("event: %s\ndata: %s\n\n" % (event, json.dumps(payload))).encode("utf-8")
        with self.clients_lock:
            clients = list(self.clients)
        for c in clients:
            if c.dead:
                continue
            try:
                c.q.put_nowait(data)
            except queue.Full:
                c.dead = True        # the tab reconnects and re-fetches the list

    def session_of(self, sid: Optional[str]) -> Optional[Session]:
        if not sid:
            return None
        s = self.sessions.get(sid)
        if s is None:
            s = Session("S%d" % (len(self.sessions) + 1))
            self.sessions[sid] = s
        return s

    def thread(self, key: str, name: str, session: str, kind: str) -> Thread:
        th = self.threads.get(key)
        if th is None:
            th = Thread(key, name, session, kind)
            self.threads[key] = th
        return th


STORE = Store()
CAPTURE: "queue.Queue[tuple]" = queue.Queue()
_id_lock = threading.Lock()
_next_id = [0]


def next_id() -> int:
    with _id_lock:
        _next_id[0] += 1
        return _next_id[0]


# ----------------------------------------------------------------------------
# request analysis (capture worker, under STORE.lock)

NO_SESSION = Session("")


def line_obj(kind: str, label: str, text: str, quote: bool = False) -> Dict[str, str]:
    """One of the two row lines, at most 60 characters in all."""
    room = 60 - len(label) - 1
    text = one_line(text)
    text = ('"%s"' % cut(text, room - 2)) if quote else cut(text, room)
    return {"kind": kind, "label": label, "text": text}


def call_label(name: str, inp: Any, extra: int, room: int = 55) -> str:
    """`Tool arg (+N)` fitted into `room` characters; a file path keeps its end."""
    suffix = " (+%d)" % extra if extra > 0 else ""
    key, arg = main_arg(inp, max(8, room - len(name) - 1 - len(suffix)))
    return name + (" " + arg if arg else "") + suffix


def find_tool_use(msgs: List[Any], tool_use_id: str) -> Optional[Dict[str, Any]]:
    for m in reversed(msgs):
        if isinstance(m, dict) and m.get("role") == "assistant":
            for b in blocks_of(m):
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id") == tool_use_id:
                    return b
    return None


def analyze(ex: Exchange, headers: List[Tuple[str, str]], obj: Any) -> set:
    """Session, thread, prefix/new range, change flags, tool pairing, row line.
    Returns the ids of other exchanges whose summary changed."""
    S = STORE
    hdr = {k.lower(): v for k, v in headers}
    meta_session, ids = metadata_ids(obj)
    S.mask_ids.update(ids)
    sid = hdr.get("x-claude-code-session-id") or meta_session
    sess = S.session_of(sid) or NO_SESSION
    ex.sess = sess
    ex.session = sess.label
    msgs = obj.get("messages") if isinstance(obj, dict) else None
    ex.is_message = (ex.method == "POST" and urlsplit(ex.path).path.rstrip("/") == "/v1/messages"
                     and isinstance(msgs, list))
    if not ex.is_message:
        return set()
    pfx = sess.label or "-"
    tools = obj.get("tools")
    ex.model_req = obj.get("model")
    ex.max_tokens = obj.get("max_tokens")
    ex.sys_hash = hashlib.sha1(system_text(obj.get("system")).encode("utf-8", "replace")).hexdigest()
    ex.tools_hash = digest(tools or [])
    ex.tool_names = [str(t.get("name")) for t in (tools or []) if isinstance(t, dict)]
    agent = hdr.get("x-claude-code-agent-id")
    touched: set = set()

    if not tools:                                   # side request: a one-off thread
        ex.tkey = pfx + "/side"
        ex.up = up_line(ex, "side", msgs, None)
        return touched
    if agent:
        key = sess.agents.get(agent)
        if key is None:
            sess.subs += 1
            key = "%s/sub-%d" % (pfx, sess.subs)
            sess.agents[agent] = key
        th = S.thread(key, key.split("/", 1)[1], sess.label, "sub")
        th.agent_id = agent
    elif "x-claude-code-session-id" in hdr:
        th = S.thread(pfx + "/main", "main", sess.label, "main")
    else:                                           # another agent: thread per first user message
        first = next((m for m in msgs if isinstance(m, dict) and m.get("role") == "user"), None)
        d = digest(first)
        key = sess.others.get(d)
        if key is None:
            n = len(sess.others) + 1
            key = "%s/%s" % (pfx, "main" if n == 1 else "main-%d" % n)
            sess.others[d] = key
        th = S.thread(key, key.split("/", 1)[1], sess.label, "other")
    ex.tkey = th.key
    earlier = [S.ex[i] for i in th.xids if S.ex[i].hashes is not None]
    th.xids.append(ex.id)
    if not th.title and th.kind in ("main", "other"):
        th.title = cut(one_line(first_prompt(msgs)), 60)
    if th.kind == "sub" and th.parent is None:
        touched |= link_sub(th, sess, msgs)

    # prefix: prev = latest earlier request of the thread whose messages are a prefix of these
    hashes = [digest(m) for m in msgs]
    ex.hashes = hashes
    ref = None
    for p in reversed(earlier):
        n = len(p.hashes)
        if n <= len(hashes) and hashes[:n] == p.hashes:
            ref = p
            if n == len(hashes):                    # same messages: a retry
                ex.retry_of = p.id
                ex.new_start, ex.reply_of, ex.prev_id = p.new_start, p.reply_of, p.prev_id
                ex.asst_src = dict(p.asst_src)
            else:
                ex.prev_id = p.id
                ns = n
                ex.asst_src = dict(p.asst_src)
                if ns < len(msgs) and isinstance(msgs[ns], dict) and msgs[ns].get("role") == "assistant":
                    ex.reply_of = p.id
                    ex.asst_src[ns] = p.id
                    ns += 1
                ex.new_start = ns
            break
    if ref is None and earlier:                     # no prefix: the history changed
        last = earlier[-1]
        i = 0
        while i < min(len(hashes), len(last.hashes)) and hashes[i] == last.hashes[i]:
            i += 1
        ex.history_at = i
        ex.new_start = i
        ex.asst_src = {k: v for k, v in last.asst_src.items() if k < i}
        ref = last
    if ref is not None:
        ex.changes = changes_between(ref, ex)

    touched |= pair_results(ex, th, sess, msgs)
    ex.up = up_line(ex, th.kind, msgs, th)
    return touched


def changes_between(a: Exchange, b: Exchange) -> List[str]:
    out = []
    if a.model_req != b.model_req:
        out.append("model %s → %s" % (a.model_req, b.model_req))
    if a.max_tokens != b.max_tokens:
        out.append("max_tokens %s → %s" % (a.max_tokens, b.max_tokens))
    if a.sys_hash != b.sys_hash:
        out.append("system changed")
    if a.tools_hash != b.tools_hash:
        diff = ["+" + n for n in b.tool_names if n not in a.tool_names] + \
               ["−" + n for n in a.tool_names if n not in b.tool_names]
        out.append("tools changed" + (": " + " ".join(diff) if diff else ""))
    return out


def pair_results(ex: Exchange, th: Thread, sess: Session, msgs: List[Any]) -> set:
    """Join earlier calls of the thread to the tool_results of this request."""
    results: Dict[str, Any] = {}
    for m in msgs:
        if isinstance(m, dict) and m.get("role") == "user":
            for b in blocks_of(m):
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results[str(b.get("tool_use_id"))] = b
    touched = set()
    for cid, c in list(th.open_calls.items()):
        if c.xid >= ex.id:
            continue
        b = results.get(cid)
        if b is not None:
            c.state = "error" if b.get("is_error") else "ok"
            c.result_from, c.result_block = ex.id, b
            del th.open_calls[cid]
            touched.add(c.xid)
            if c.name in AGENT_TOOLS and c.child is None:
                touched |= link_from_result(c, b, sess)
        elif c.state == "waiting" and STORE.ex[c.xid].state in FINAL:
            c.state = "none"
            touched.add(c.xid)
    touched.discard(ex.id)
    return touched


def do_link(c: Call, th: Thread) -> set:
    c.child = th.key
    desc = c.input.get("description") if isinstance(c.input, dict) else None
    th.parent = {"xid": c.xid, "call": c.id, "description": desc or c.arg}
    th.title = cut(one_line(str(desc or c.arg or th.name)), 60)
    return {c.xid} | set(th.xids)


def link_sub(th: Thread, sess: Session, msgs: List[Any]) -> set:
    """Link a subagent thread to the Agent call that started it."""
    c = sess.pending_links.pop(th.agent_id or "", None)
    if c is None:
        prompt = first_prompt(msgs).strip()
        cands = [x for x in reversed(sess.agent_calls) if x.child is None and isinstance(x.input, dict)]
        for x in cands:
            if str(x.input.get("prompt") or "").strip() == prompt and prompt:
                c = x
                break
        if c is None and len(prompt) >= 20:
            for x in cands:
                p = str(x.input.get("prompt") or "").strip()
                if len(p) >= 20 and (p in prompt or prompt in p):
                    c = x
                    break
    return do_link(c, th) if c is not None else set()


def link_from_result(c: Call, block: Any, sess: Session) -> set:
    """An Agent call's result names the agent id."""
    text = result_text(block)
    for aid, key in sess.agents.items():
        th = STORE.threads.get(key)
        if aid and aid in text and th is not None and th.parent is None:
            return do_link(c, th)
    m = re.search(r"agent[_ ]?id[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9_-]{6,})", text, re.I)
    if m:
        sess.pending_links[m.group(1)] = c
    return set()


def up_line(ex: Exchange, kind: str, msgs: List[Any], th: Optional[Thread]) -> Optional[Dict[str, str]]:
    """What the agent sent: YOU, else the first RESULT (+N), else TASK or HARNESS."""
    you = task = None
    harness: Optional[Tuple[str, str]] = None
    notification = False
    results = []
    for m in msgs[ex.new_start:]:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        for b in blocks_of(m):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and isinstance(b.get("text"), str):
                for sk, tag, span in segments(b["text"]):
                    if sk == "harness" and "<task-notification>" in span:
                        notification = True     # a subagent result, often wrapped in a system-reminder
                    if sk == "harness" or kind == "side":
                        harness = harness or (tag, span)
                    elif kind == "sub":
                        task = task or span
                    else:
                        you = you or span
            elif b.get("type") == "tool_result":
                results.append(b)
                if b.get("is_error"):
                    ex.dot = True
    if you:
        return line_obj("you", "YOU", you, quote=True)
    if results:
        r = results[0]
        rid = str(r.get("tool_use_id"))
        c = th.calls.get(rid) if th else None
        if c is not None:
            text = call_label(c.name, c.input, len(results) - 1, 53)
        else:
            tu = find_tool_use(msgs, rid) or {}
            text = call_label(str(tu.get("name") or "?"), tu.get("input"), len(results) - 1, 53)
        return line_obj("result", "RESULT", text)
    if task:
        return line_obj("task", "TASK", task, quote=True)
    if notification:
        return line_obj("harness", "HARNESS", "subagent result")
    if harness:
        tag, span = harness
        if tag:
            inner = span[len(tag) + 2:-(len(tag) + 3)]       # span is exactly <tag>…</tag>
            first = next((ln.strip() for ln in inner.splitlines() if ln.strip()), "")
            return line_obj("harness", "HARNESS", tag + (": " + first if first else ""))
        return line_obj("harness", "HARNESS", span, quote=True)
    return None


def down_line(ex: Exchange) -> Optional[Dict[str, str]]:
    """What the model answered: the first CALL (+N), else the first MODEL text."""
    blocks = ex.asm.block_list()
    calls = [b for b in blocks if b.get("type") == "tool_use"]
    if calls:
        return line_obj("call", "CALL", call_label(str(calls[0].get("name") or "?"),
                                                   calls[0].get("input"), len(calls) - 1))
    for b in blocks:
        if b.get("type") == "text" and (b.get("text") or "").strip():
            return line_obj("model", "MODEL", b["text"], quote=True)
    if ex.asm.error is not None:
        err = ex.asm.error
        msg = err.get("message") if isinstance(err, dict) else str(err)
        return line_obj("error", "ERROR", str(msg or err))
    if ex.state == "error" and ex.error:
        return line_obj("error", "ERROR", ex.error)
    if any(b.get("type") in ("thinking", "redacted_thinking") for b in blocks):
        return line_obj("thinking", "THINKING", "…")
    return None


# ----------------------------------------------------------------------------
# summaries and publishing (capture worker, under STORE.lock)

def build_summary(ex: Exchange) -> Dict[str, Any]:
    th = STORE.threads.get(ex.tkey) if ex.tkey else None
    asm = ex.asm
    flags: List[Dict[str, Any]] = []
    if ex.retry_of:
        flags.append({"code": "retry", "level": "info", "text": "retry of #%d" % ex.retry_of, "ref": ex.retry_of})
    if ex.history_at is not None:
        flags.append({"code": "history", "level": "info", "text": "history changed at message %d" % ex.history_at})
    for ch in ex.changes:
        flags.append({"code": "change", "level": "info", "text": ch})
    if ex.state == "error":
        flags.append({"code": "error", "level": "red", "text": ex.error or "error"})
    if ex.status is not None and ex.status >= 400:
        flags.append({"code": "http", "level": "red", "text": "HTTP %d %s" % (ex.status, ex.reason)})
    if asm.error is not None:
        e = asm.error
        msg = e.get("message") if isinstance(e, dict) else None
        flags.append({"code": "sse_error", "level": "red", "text": "error event: %s" % (msg or json.dumps(e))})
    if ex.state == "aborted":
        flags.append({"code": "aborted", "level": "amber", "text": "aborted: the agent disconnected"})
    if asm.stop_reason == "max_tokens":
        flags.append({"code": "max_tokens", "level": "amber", "text": "stop_reason max_tokens"})
    none = [c for c in ex.calls if c.state == "none"]
    if none:
        flags.append({"code": "no_result", "level": "amber", "text": "%d call(s) with no result" % len(none)})
    if ex.dot:
        flags.append({"code": "tool_error", "level": "red", "text": "a tool_result in this request has is_error"})
    if ex.evicted:
        flags.append({"code": "evicted", "level": "info", "text": "bodies evicted (memory limit)"})
    red = ex.state == "error" or (ex.status is not None and ex.status >= 400) or asm.error is not None
    amber = ex.state == "aborted" or asm.stop_reason == "max_tokens" or bool(none)
    name = th.name if th else ("side" if ex.tkey and ex.tkey.endswith("/side") else None)
    return {
        "id": ex.id, "version": ex.version, "state": ex.state, "status": ex.status, "reason": ex.reason,
        "method": ex.method, "path": ex.path, "is_message": ex.is_message,
        "session": ex.session, "thread": name, "thread_key": ex.tkey,
        "thread_kind": th.kind if th else ("side" if name == "side" else None),
        "thread_title": th.title if th else "", "parent": th.parent if th else None,
        "t_start": ex.t_start, "t_headers": ex.t_headers, "t_first": ex.t_first, "t_end": ex.t_end,
        "model": asm.model or ex.model_req, "stop_reason": asm.stop_reason,
        "tokens": tokens_of(asm.usage), "req_size": ex.req_size, "reply_size": len(ex.raw),
        "up": ex.up, "down": down_line(ex), "calls": [c.public() for c in ex.calls],
        "flags": flags, "red": red, "dot": ex.dot, "amber": amber, "error": ex.error,
        "retry_of": ex.retry_of, "reply_of": ex.reply_of, "history_at": ex.history_at,
        "prev_id": ex.prev_id, "new_start": ex.new_start, "evicted": ex.evicted,
    }


def publish(ex: Exchange) -> None:
    ex.version += 1
    ex.summary = build_summary(ex)
    STORE.broadcast("exchange", ex.summary)


def push_live(ex: Exchange) -> None:
    """The throttled live update of a streaming exchange: summary and reply so far."""
    ex.last_push = time.monotonic()
    STORE.dirty.discard(ex.id)
    publish(ex)
    STORE.broadcast("reply", {"id": ex.id, "version": ex.version, "reply": ex.asm.snapshot()})


def register_call(ex: Exchange, blk: Dict[str, Any]) -> None:
    c = Call(ex.id, blk)
    if not c.id or any(x.id == c.id for x in ex.calls):
        return
    ex.calls.append(c)
    th = STORE.threads.get(ex.tkey) if ex.tkey else None
    if th is not None:
        th.calls[c.id] = c
        th.open_calls[c.id] = c
    sess = getattr(ex, "sess", None)
    if c.name in AGENT_TOOLS and sess is not None:
        sess.agent_calls.append(c)


def is_json_reply(ex: Exchange) -> bool:
    return "json" in ex.content_type.lower() and "event-stream" not in ex.content_type.lower()


# ----------------------------------------------------------------------------
# the capture worker

def on_request(xid: int, t: float, method: str, path: str, headers: List[Tuple[str, str]], body: bytes) -> None:
    S = STORE
    ex = Exchange(xid, t, method, path, headers, body)
    ex.sess = None
    S.ex[xid] = ex
    S.order.append(xid)
    S.body_bytes += len(body)
    obj = None
    if body:
        try:
            obj = json.loads(body)
        except ValueError:
            obj = None
    touched: set = set()
    try:
        touched = analyze(ex, headers, obj)
    except Exception:
        if VERBOSE:
            import traceback
            traceback.print_exc()
    publish(ex)
    for x in sorted(touched):
        if x in S.ex and x != xid:
            publish(S.ex[x])
    if VERBOSE:
        out = ["\n%s\n[%s] >>> #%d %s %s" % ("=" * 78, stamp(t), xid, method, path)]
        out += ["    %s: %s" % (k, v) for k, v in redact(headers)]
        if body:
            out.append(json.dumps(obj, indent=2, ensure_ascii=False) if obj is not None
                       else body.decode("utf-8", "replace"))
        print("\n".join(out), flush=True)
    evict()


def on_response(xid: int, t: float, status: int, reason: str, headers: List[Tuple[str, str]]) -> None:
    ex = STORE.ex[xid]
    ex.status, ex.reason, ex.t_headers = status, reason, t
    ex.resp_headers = redact(headers)
    ex.content_type = next((v for k, v in headers if k.lower() == "content-type"), "")
    ex.state = "streaming"
    publish(ex)
    if VERBOSE:
        out = ["\n[%s] <<< #%d %s %s" % (stamp(t), xid, status, reason)]
        out += ["    %s: %s" % (k, v) for k, v in ex.resp_headers]
        print("\n".join(out), flush=True)
        ex.vdec = codecs.getincrementaldecoder("utf-8")(errors="replace")


def on_chunk(xid: int, t: float, chunk: bytes) -> None:
    ex = STORE.ex[xid]
    if ex.t_first is None:
        ex.t_first = t
    if not ex.evicted:
        ex.raw += chunk
        STORE.body_bytes += len(chunk)
    if not is_json_reply(ex):
        for blk in ex.asm.feed(chunk):
            register_call(ex, blk)
    if VERBOSE and hasattr(ex, "vdec"):
        sys.stdout.write(ex.vdec.decode(chunk))
        sys.stdout.flush()
    if time.monotonic() - ex.last_push >= REPLY_PUSH_INTERVAL:
        push_live(ex)
    else:
        STORE.dirty.add(xid)


def finalize(xid: int, t: float, state: str, status: Optional[int] = None, error: Optional[str] = None) -> None:
    ex = STORE.ex[xid]
    if ex.state in FINAL:
        return
    ex.state, ex.t_end = state, t
    if status is not None:
        ex.status = status
    if error:
        ex.error = error
    try:
        if is_json_reply(ex):
            calls = ex.asm.load_json(bytes(ex.raw).decode("utf-8", "replace"))
        else:
            calls = ex.asm.finish()
        for blk in calls:
            register_call(ex, blk)
    except Exception:
        pass
    STORE.dirty.discard(xid)
    publish(ex)
    STORE.broadcast("reply", {"id": ex.id, "version": ex.version, "reply": ex.asm.snapshot()})
    if VERBOSE:
        print("\n[%s] --- #%d %s%s" % (stamp(t), xid, state, (": " + error) if error else ""), flush=True)
    print(term_line(ex), flush=True)
    evict()


def term_line(ex: Exchange) -> str:
    name = ex.summary.get("thread") or "-"
    if name != "-" and ex.session and len(STORE.sessions) > 1:
        name = "%s:%s" % (ex.session, name)
    dur = (ex.t_end or time.time()) - ex.t_start
    parts = [stamp(ex.t_start), "#%d" % ex.id, name, ex.method, urlsplit(ex.path).path,
             str(ex.status) if ex.status is not None else "-", "%.1fs" % dur]
    tok = tokens_of(ex.asm.usage)
    if tok:
        parts.append("in %s (%d%% cached) out %s" % (human_k(tok["in"]), round(tok["cached"] * 100),
                                                    human_k(tok["out"])))
    if ex.state == "aborted":
        parts.append("ABORTED")
    elif ex.state == "error":
        parts.append("ERROR %s" % (ex.error or ""))
    if ex.asm.error is not None:
        e = ex.asm.error
        parts.append("ERROR %s" % (e.get("message") if isinstance(e, dict) else e))
    return " ".join(parts)


def evict() -> None:
    """Above BODY_LIMIT, drop the oldest bodies; their summaries stay."""
    S = STORE
    if S.body_bytes <= BODY_LIMIT:
        return
    for xid in S.order:
        if S.body_bytes <= BODY_LIMIT:
            break
        ex = S.ex[xid]
        if ex.evicted or ex.state not in FINAL:
            continue
        S.body_bytes -= ex.req_size + len(ex.raw)
        ex.body, ex.raw, ex.evicted = None, bytearray(), True
        publish(ex)


def handle(ev: tuple) -> None:
    kind = ev[0]
    if kind == "req":
        on_request(*ev[1:])
    elif ev[1] not in STORE.ex:
        return
    elif kind == "resp":
        on_response(*ev[1:])
    elif kind == "chunk":
        on_chunk(*ev[1:])
    elif kind == "end":
        finalize(ev[1], ev[2], "done")
    elif kind == "abort":
        finalize(ev[1], ev[2], "aborted")
    elif kind == "fail":
        finalize(ev[1], ev[2], "error", status=ev[3], error=ev[4])


def worker() -> None:
    S = STORE
    while True:
        try:
            ev = CAPTURE.get(timeout=0.05 if S.dirty else 0.5)
        except queue.Empty:
            ev = None
        with S.lock:
            if ev is not None:
                try:
                    handle(ev)
                except Exception:
                    if VERBOSE:
                        import traceback
                        traceback.print_exc()
            if S.dirty:
                now = time.monotonic()
                for xid in list(S.dirty):
                    ex = S.ex.get(xid)
                    if ex is None or ex.state in FINAL:
                        S.dirty.discard(xid)
                    elif now - ex.last_push >= REPLY_PUSH_INTERVAL:
                        push_live(ex)


# ----------------------------------------------------------------------------
# the relay (proxy port): forwarding comes first, capture only gets raw events

class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def do_GET(self) -> None:
        self.relay()

    do_POST = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET

    def relay(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        items = list(self.headers.items())
        xid = next_id()
        CAPTURE.put(("req", xid, time.time(), self.command, self.path, items, body))

        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        upstream = conn_cls(target.netloc, timeout=10)
        try:
            upstream.connect()
        except OSError as e:
            self.fail_early(xid, upstream, "cannot reach %s: %s" % (UPSTREAM, e))
            return
        try:
            upstream.sock.settimeout(600)
            headers = {k: v for k, v in items if k.lower() not in SKIP}
            upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
            reply = upstream.getresponse()
        except (OSError, http.client.HTTPException) as e:
            self.fail_early(xid, upstream, "upstream failed before the reply headers: %s" % (e or type(e).__name__))
            return
        resp_headers = reply.getheaders()
        CAPTURE.put(("resp", xid, time.time(), reply.status, reply.reason, resp_headers))
        self.close_connection = True
        try:
            self.send_response(reply.status, reply.reason)
            for name, value in resp_headers:
                if name.lower() not in SKIP and name.lower() != "content-encoding":
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command == "HEAD":
                self.wfile.flush()
        except OSError:
            upstream.close()
            CAPTURE.put(("abort", xid, time.time()))
            return
        if self.command == "HEAD":
            upstream.close()
            CAPTURE.put(("end", xid, time.time()))
            return
        while True:
            try:
                chunk = reply.read1(4096)  # each chunk as it lands
            except (OSError, http.client.HTTPException) as e:
                upstream.close()             # upstream broke after the headers: close both sides
                self.kill_client()
                CAPTURE.put(("fail", xid, time.time(), None,
                             "upstream broke mid-reply: %s" % (repr(e) if not str(e) else e)))
                return
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except OSError:                  # the agent went away (Esc): aborted, no traceback
                upstream.close()
                CAPTURE.put(("chunk", xid, time.time(), chunk))
                CAPTURE.put(("abort", xid, time.time()))
                return
            CAPTURE.put(("chunk", xid, time.time(), chunk))
        missing = reply.length if isinstance(reply.length, int) else 0
        upstream.close()
        if missing:
            self.kill_client()
            CAPTURE.put(("fail", xid, time.time(), None, "upstream closed %d bytes early" % missing))
        else:
            CAPTURE.put(("end", xid, time.time()))

    def fail_early(self, xid: int, upstream: http.client.HTTPConnection, msg: str) -> None:
        """Upstream unreachable or failing before the reply headers: 502, as proxy.py does."""
        upstream.close()
        CAPTURE.put(("fail", xid, time.time(), 502, msg))
        try:
            self.send_error(502, "proxy: %s" % msg)
        except OSError:
            pass
        self.close_connection = True

    def kill_client(self) -> None:
        self.close_connection = True
        try:
            self.wfile.flush()
            self.connection.shutdown(2)
        except OSError:
            pass


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        if VERBOSE:
            import traceback
            print("[%s] connection error from %s: %s" % (stamp(), client_address,
                                                       traceback.format_exc().splitlines()[-1]), flush=True)


# ----------------------------------------------------------------------------
# the dashboard (UI port)

def detail(xid: int) -> Optional[Dict[str, Any]]:
    S = STORE
    with S.lock:
        ex = S.ex.get(xid)
        if ex is None:
            return None
        body, raw = ex.body, bytes(ex.raw)
        sess = getattr(ex, "sess", None)
        out: Dict[str, Any] = {
            "summary": ex.summary, "req_headers": ex.req_headers, "resp_headers": ex.resp_headers,
            "new_start": ex.new_start, "reply_of": ex.reply_of, "retry_of": ex.retry_of,
            "history_at": ex.history_at, "prev_id": ex.prev_id, "evicted": ex.evicted,
            "asst_src": {str(k): v for k, v in ex.asst_src.items()},
            "reply": ex.asm.snapshot(), "content_type": ex.content_type,
            "results": {c.id: {"from": c.result_from, "state": c.state, "block": c.result_block,
                               "child": c.child, "name": c.name, "arg": c.arg} for c in ex.calls},
            "agents": {aid: {"key": k, "name": S.threads[k].name}
                       for aid, k in (sess.agents.items() if sess else []) if k in S.threads},
            "mask_ids": sorted(S.mask_ids),
        }
    out["body"] = None
    if body is not None:
        try:
            out["body"] = json.loads(body) if body else None
        except ValueError:
            out["body_text"] = body.decode("utf-8", "replace")
    out["raw"] = None if out["evicted"] else raw.decode("utf-8", "replace")
    return out


class UI(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def host_ok(self) -> bool:
        return self.headers.get("Host", "") in ("localhost:%d" % UI_PORT, "127.0.0.1:%d" % UI_PORT)

    def send_bytes(self, code: int, data: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj: Any, code: int = 200) -> None:
        self.send_bytes(code, json.dumps(obj).encode("ascii"), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        if not self.host_ok():
            self.send_bytes(403, b"forbidden: bad Host header\n", "text/plain; charset=utf-8")
            return
        path = urlsplit(self.path).path
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                with open(os.path.join(STATIC_DIR, name), "rb") as f:
                    data = f.read()
            except OSError:
                self.send_bytes(404, b"not found\n", "text/plain; charset=utf-8")
                return
            csp = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                   "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.send_bytes(200, data, ctype, {"Content-Security-Policy": csp})
        elif path == "/api/exchanges":
            with STORE.lock:
                items = [STORE.ex[i].summary for i in STORE.order]
                mask = sorted(STORE.mask_ids)
            self.send_json({"exchanges": items, "mask_ids": mask, "upstream": UPSTREAM, "boot": BOOT})
        elif path.startswith("/api/exchanges/"):
            try:
                d = detail(int(path.rsplit("/", 1)[1]))
            except ValueError:
                d = None
            if d is None:
                self.send_json({"error": "no such exchange"}, 404)
            else:
                self.send_json(d)
        elif path == "/events":
            self.events()
        else:
            self.send_bytes(404, b"not found\n", "text/plain; charset=utf-8")

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_POST(self) -> None:
        code = 405 if self.host_ok() else 403
        self.send_bytes(code, b"method not allowed\n" if code == 405 else b"forbidden\n", "text/plain; charset=utf-8")

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_POST

    def events(self) -> None:
        client = Client()
        with STORE.clients_lock:
            STORE.clients.append(client)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(("retry: 1500\nevent: hello\ndata: %s\n\n" % json.dumps({"boot": BOOT})).encode("ascii"))
            self.wfile.flush()
            last = time.monotonic()
            while not STOP.is_set() and not client.dead:
                batch: List[bytes] = []
                try:
                    batch.append(client.q.get(timeout=0.5))
                    while len(batch) < 200:
                        batch.append(client.q.get_nowait())
                except queue.Empty:
                    pass
                if batch:
                    self.wfile.write(b"".join(batch))
                    self.wfile.flush()
                if time.monotonic() - last >= PING_INTERVAL:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last = time.monotonic()
        except OSError:
            pass
        finally:
            with STORE.clients_lock:
                if client in STORE.clients:
                    STORE.clients.remove(client)


# ----------------------------------------------------------------------------

def main() -> None:
    global UPSTREAM, UI_PORT, VERBOSE
    parser = argparse.ArgumentParser(description="Relay an agent's API traffic and show it live in the browser.")
    parser.add_argument("--port", type=int, default=8041, help="proxy port (default 8041)")
    parser.add_argument("--ui-port", type=int, default=8042, help="dashboard port (default 8042)")
    parser.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    parser.add_argument("--verbose", action="store_true", help="also print proxy.py's full dump, headers redacted")
    args = parser.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    UI_PORT = args.ui_port
    VERBOSE = args.verbose
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    try:
        proxy = QuietServer(("127.0.0.1", args.port), Relay)
        ui = QuietServer(("127.0.0.1", args.ui_port), UI)
    except OSError as e:
        print("monitor: cannot listen: %s" % e, file=sys.stderr)
        sys.exit(1)
    threading.Thread(target=worker, name="capture", daemon=True).start()
    for srv in (proxy, ui):
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True).start()
    print("proxy listening on http://localhost:%d  ->  %s" % (args.port, UPSTREAM))
    print("run the agent with:  ANTHROPIC_BASE_URL=http://localhost:%d claude" % args.port)
    print("dashboard:  http://localhost:%d" % args.ui_port, flush=True)

    def on_term(signum: int, frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, signal.default_int_handler)  # Ctrl-C even if started with SIGINT ignored
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    STOP.set()
    for srv in (proxy, ui):
        try:
            srv.socket.close()
        except OSError:
            pass
    print("\nmonitor: stopped", flush=True)
    os._exit(0)  # daemon threads (open streams, dashboard tabs) must not delay the exit


if __name__ == "__main__":
    main()
