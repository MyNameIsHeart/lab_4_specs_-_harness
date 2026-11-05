#!/usr/bin/env python3
"""monitor.py: relay proxy + capture + live dashboard for agent API traffic.

    python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]

Standard library only (Python 3.9+).
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
import traceback
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}
REDACT = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}
HARNESS_TAGS = ["system-reminder", "task-notification", "command-name", "command-message",
                "command-args", "local-command-stdout", "local-command-caveat"]
SEG_RE = re.compile(r"<(%s)(?:\s[^>]*)?>(.*?)</\1>" % "|".join(HARNESS_TAGS), re.S)
ARG_KEYS = ("file_path", "command", "pattern", "url", "query", "description", "prompt")
MAX_BODY_BYTES = 300 * 1024 * 1024

UPSTREAM = "https://api.anthropic.com"
VERBOSE = False
UI_PORT = 8042
BOOT = uuid.uuid4().hex[:12]
LOCK = threading.RLock()
EVENTS = queue.Queue()
EXCHANGES = []
CLIENTS = set()
CALLS = {}      # tool_use id -> exchange whose reply holds the call
THREADS = {}    # (session label, thread key) -> Thread
SESSIONS = {}   # session id -> "S1"
SUBS = {}       # session id -> {agent id: "sub-N"}
NOHDR = {}      # first message key -> thread name (agents without headers)
MEM = [0]


# ---------------------------------------------------------------- helpers
def now_str(t=None):
    return datetime.fromtimestamp(t or time.time()).strftime("%H:%M:%S")


def squash(s):
    return re.sub(r"\s+", " ", s or "").strip()


def cut(s, n):
    return s if len(s) <= n else s[:n - 1] + "…"


def fmtk(n):
    return "%.1fk" % (n / 1000.0) if n >= 1000 else str(int(n))


def num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else 0


def redact(items):
    return [[k, "[redacted]" if k.lower() in REDACT else v] for k, v in items]


def strip_cc(x):
    if isinstance(x, dict):
        return {k: strip_cc(v) for k, v in x.items() if k != "cache_control"}
    if isinstance(x, list):
        return [strip_cc(v) for v in x]
    return x


def digest(x):
    return hashlib.md5(json.dumps(strip_cc(x), sort_keys=True).encode("utf-8", "replace")).hexdigest()


def segments(text):
    out, pos = [], 0
    for m in SEG_RE.finditer(text):
        pre = text[pos:m.start()]
        if pre.strip():
            out.append((None, pre))
        out.append((m.group(1), m.group(2)))
        pos = m.end()
    rest = text[pos:]
    if rest.strip():
        out.append((None, rest))
    return out


def call_arg(inp, short=False):
    if not isinstance(inp, dict):
        return ""
    for k in ARG_KEYS:
        v = inp.get(k)
        if v not in (None, ""):
            s = squash(v if isinstance(v, str) else json.dumps(v))
            if short and k == "file_path":
                s = os.path.basename(s) or s
            return cut(s, 80)
    return ""


def blocks_of(msg):
    c = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return [b for b in (c or []) if isinstance(b, dict)]


def _jlen(x):
    return len(json.dumps(x, ensure_ascii=False, separators=(",", ":")))


def text_parts(text, role, tname):
    """(total chars, harness chars, YOU chars) of one text string."""
    h = y = 0
    for tag, txt in segments(text):
        if tag or (role == "user" and tname == "side"):
            h += len(txt)
        elif role == "user" and not tname.startswith("sub-"):
            y += len(txt)
    return len(text), h, y


def block_parts(b, role, tname):
    t = b.get("type")
    if t == "text":
        return text_parts(b.get("text") or "", role, tname)
    if t == "tool_result":
        c, tot, h = b.get("content"), 0, 0
        if isinstance(c, str):
            tot, h, _ = text_parts(c, "tool", tname)
        elif isinstance(c, list):
            for x in c:
                if isinstance(x, dict) and x.get("type") == "text":
                    a, hh, _ = text_parts(x.get("text") or "", "tool", tname)
                    tot, h = tot + a, h + hh
                else:
                    tot += _jlen(x)
        elif c is not None:
            tot = _jlen(c)
        return tot, h, 0
    return _jlen(b), 0, 0


def anatomy(body, msgs, new_from, new_to, tname):
    sysv = body.get("system")
    if isinstance(sysv, str):
        sys_n = len(sysv)
    elif isinstance(sysv, list):
        sys_n = sum(len(x.get("text") or "") if isinstance(x, dict) and "text" in x else _jlen(x) for x in sysv)
    else:
        sys_n = 0
    tools = body.get("tools")
    a = {"system": sys_n, "tools": _jlen(tools) if tools else 0, "harness": 0, "earlier": 0, "new": 0}
    you = 0
    for i, m in enumerate(msgs):
        for b in blocks_of(m):
            tot, h, y = block_parts(b, m.get("role"), tname)
            a["harness"] += h
            a["new" if new_from <= i < new_to else "earlier"] += tot - h
            you += y
    return a, you



# ---------------------------------------------------------------- model
class Thread:
    def __init__(self, name, session, agent_id=None):
        self.name, self.session, self.agent_id = name, session, agent_id
        self.title = ""
        self.parent = None
        self.first_prompt = ""
        self.exs = []


class Exchange:
    def __init__(self, id_, method, path, headers):
        self.id, self.method, self.path = id_, method, path
        self.state = "pending"
        self.status = None
        self.t_start = time.time()
        self.t_first = None
        self.t_end = None
        self.req_headers = redact(headers)
        self.resp_headers = []
        self.req_body = b""
        self.req_size = 0
        self.raw = []
        self.raw_size = 0
        self.evicted = False
        self.error = None
        self.sse_error = None
        self.version = 0
        self.summary = None
        self.pubkey = None
        self.last_pub = 0
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.vdec = codecs.getincrementaldecoder("utf-8")("replace")
        self.linebuf = ""
        self.model = None
        self.blocks = {}
        self.stop_reason = None
        self.usage = {}
        self.unknown = []
        self.results = {}
        self.d = {}
        self.thread = None


# ---------------------------------------------------------------- SSE parsing
def feed(ex, data):
    ex.linebuf += ex.dec.decode(data)
    *lines, ex.linebuf = ex.linebuf.split("\n")
    for ln in lines:
        sse_line(ex, ln.rstrip("\r"))


def sse_line(ex, ln):
    if not ln.startswith("data:"):
        return
    s = ln[5:].strip()
    if not s or s == "[DONE]":
        return
    try:
        obj = json.loads(s)
    except ValueError:
        ex.unknown.append(s[:500])
        return
    if isinstance(obj, dict):
        sse_event(ex, obj)
    else:
        ex.unknown.append(obj)


def new_block(cb):
    t = cb.get("type")
    if t == "text":
        return {"type": "text", "text": cb.get("text") or ""}
    if t == "thinking":
        return {"type": "thinking", "text": cb.get("thinking") or "", "est": 0, "sig": 0}
    if t == "tool_use":
        return {"type": "tool_use", "id": cb.get("id"), "name": cb.get("name"), "json": "", "input": None,
                "init": cb.get("input")}
    return {"type": t or "unknown", "raw": cb}


def register_call(ex, b):
    if b.get("type") == "tool_use" and b.get("id"):
        CALLS[b["id"]] = ex


def sse_event(ex, obj):
    t = obj.get("type")
    if t == "message_start":
        m = obj.get("message") or {}
        ex.model = m.get("model") or ex.model
        ex.usage.update(m.get("usage") or {})
    elif t == "content_block_start":
        b = new_block(obj.get("content_block") or {})
        ex.blocks[obj.get("index", len(ex.blocks))] = b
        register_call(ex, b)
    elif t == "content_block_delta":
        i = obj.get("index", 0)
        delta = obj.get("delta") or {}
        dt = delta.get("type")
        b = ex.blocks.get(i)
        if b is None:
            b = new_block({"type": {"text_delta": "text", "thinking_delta": "thinking",
                                    "input_json_delta": "tool_use"}.get(dt, "unknown")})
            ex.blocks[i] = b
        if dt == "text_delta" and b["type"] == "text":
            b["text"] += delta.get("text") or ""
        elif dt == "thinking_delta" and b["type"] == "thinking":
            b["text"] += delta.get("thinking") or ""
            b["est"] += num(delta.get("estimated_tokens"))
        elif dt == "signature_delta" and b["type"] == "thinking":
            b["sig"] += len(delta.get("signature") or "")
        elif dt == "input_json_delta" and b["type"] == "tool_use":
            b["json"] += delta.get("partial_json") or ""
        else:
            ex.unknown.append(obj)
    elif t == "content_block_stop":
        b = ex.blocks.get(obj.get("index", 0))
        if b and b["type"] == "tool_use":
            try:
                b["input"] = json.loads(b["json"]) if b["json"].strip() else (b.get("init") or {})
            except ValueError:
                pass
    elif t == "message_delta":
        delta = obj.get("delta") or {}
        if delta.get("stop_reason"):
            ex.stop_reason = delta["stop_reason"]
        for k, v in (obj.get("usage") or {}).items():
            if v is not None:
                ex.usage[k] = v
    elif t == "error":
        e = obj.get("error")
        ex.sse_error = (e.get("message") if isinstance(e, dict) else str(e)) or "error event"
        ex.unknown.append(obj)
    elif t in ("ping", "message_stop"):
        pass
    else:
        ex.unknown.append(obj)


def load_json_reply(ex, obj):
    ex.model = obj.get("model")
    ex.stop_reason = obj.get("stop_reason")
    if isinstance(obj.get("usage"), dict):
        ex.usage.update(obj["usage"])
    content = obj.get("content")
    if isinstance(content, list):
        for i, cb in enumerate(content):
            if not isinstance(cb, dict):
                continue
            b = new_block(cb)
            if b["type"] == "tool_use":
                b["input"] = cb.get("input") or {}
            ex.blocks[i] = b
            register_call(ex, b)
    elif obj.get("error"):
        e = obj["error"]
        ex.sse_error = e.get("message") if isinstance(e, dict) else str(e)


def reply_dict(ex):
    blocks = []
    for i in sorted(ex.blocks):
        b = ex.blocks[i]
        t = b["type"]
        if t == "tool_use":
            inp = b.get("input")
            if inp is None:
                try:
                    inp = json.loads(b["json"]) if b["json"].strip() else {}
                except ValueError:
                    inp = None
            blocks.append({"type": "tool_use", "id": b.get("id"), "name": b.get("name"),
                           "input": inp if inp is not None else {}, "partial": inp is None})
        elif t == "thinking":
            blocks.append({"type": "thinking", "thinking": b["text"], "tokens": b["est"], "signature_len": b["sig"]})
        elif t == "text":
            blocks.append({"type": "text", "text": b["text"]})
        else:
            blocks.append({"type": t, "raw": b.get("raw")})
    return {"model": ex.model, "blocks": blocks, "stop_reason": ex.stop_reason, "usage": ex.usage,
            "unknown": ex.unknown[:50], "error": ex.sse_error}


# ---------------------------------------------------------------- analysis
def session_label(sid):
    if sid not in SESSIONS:
        SESSIONS[sid] = "S%d" % (len(SESSIONS) + 1)
    return SESSIONS[sid]


def analyze(ex):
    d = ex.d = {"is_message": False, "session": "", "thread": "", "flags": [], "up": "", "tip_up": "",
                "dot": False, "new_from": 0, "new_to": 0, "reply_of": None, "keys": [], "msgs_n": 0}
    hdr = {k.lower(): v for k, v in ex.req_headers}
    if not (ex.method == "POST" and urlsplit(ex.path).path.rstrip("/").endswith("/v1/messages")):
        return
    try:
        body = json.loads(ex.req_body.decode("utf-8", "replace"))
        assert isinstance(body, dict)
    except (ValueError, AssertionError):
        return
    d["is_message"] = True
    msgs = [m for m in (body.get("messages") or []) if isinstance(m, dict)] if isinstance(body.get("messages"), list) else []
    tools = body.get("tools") if isinstance(body.get("tools"), list) else []
    keys = [digest(m) for m in msgs]
    d.update(keys=keys, msgs_n=len(msgs), req_model=body.get("model"), max_tokens=body.get("max_tokens"),
             sys_sig=digest(body.get("system")), tools_sig=digest(tools))
    sid = hdr.get("x-claude-code-session-id") or ""
    if not sid:
        try:
            uid = (body.get("metadata") or {}).get("user_id")
            sid = (json.loads(uid) if isinstance(uid, str) else {}).get("session_id") or ""
        except (ValueError, AttributeError):
            sid = ""
    agent = hdr.get("x-claude-code-agent-id") or ""
    if not tools:
        label, tkey, tname = session_label(sid), "side#%d" % ex.id, "side"
    elif agent:
        subs = SUBS.setdefault(sid, {})
        tname = subs.setdefault(agent, "sub-%d" % (len(subs) + 1))
        label, tkey = session_label(sid), tname
    elif sid:
        label, tkey, tname = session_label(sid), "main", "main"
    else:
        label = session_label("")
        fk = keys[0] if keys else ""
        tname = NOHDR.setdefault(fk, "main" if not NOHDR else "t%d" % (len(NOHDR) + 1))
        tkey = "nohdr:" + fk
    th = THREADS.get((label, tkey))
    if th is None:
        th = THREADS[(label, tkey)] = Thread(tname, label, agent or None)
        if msgs:
            for b in blocks_of(msgs[0]):
                if b.get("type") == "text":
                    for tag, txt in segments(b.get("text") or ""):
                        if tag is None and not th.first_prompt:
                            th.first_prompt = txt.strip()
    ex.thread = th
    d.update(session=label, thread=tname)

    # prev / new
    prev = None
    same = None
    for e in reversed(th.exs):
        k = e.d.get("keys", [])
        if k == keys:
            same = e
            break
    if same is not None:
        prev = same
        d["flags"].append("retry of #%d" % same.id)
        d["new_from"], d["new_to"] = same.d["new_from"], same.d["new_to"]
        d["reply_of"] = same.d.get("reply_of")
    else:
        for e in reversed(th.exs):
            k = e.d.get("keys", [])
            if len(k) <= len(keys) and keys[:len(k)] == k:
                prev = e
                break
        if prev is not None:
            nf = len(prev.d["keys"])
            if nf < len(msgs) and msgs[nf].get("role") == "assistant":
                d["reply_of"] = prev.id
                nf += 1
            d["new_from"], d["new_to"] = nf, len(msgs)
        elif th.exs:
            last = th.exs[-1].d.get("keys", [])
            i = 0
            while i < len(last) and i < len(keys) and last[i] == keys[i]:
                i += 1
            d["flags"].append("history changed at message %d" % i)
            d["new_from"], d["new_to"] = i, len(msgs)
            prev = th.exs[-1]
        else:
            d["new_from"], d["new_to"] = 0, len(msgs)
    if prev is not None:
        pd = prev.d
        if pd.get("sys_sig") != d["sys_sig"]:
            d["flags"].append("system prompt changed")
        if pd.get("tools_sig") != d["tools_sig"]:
            d["flags"].append("tool list changed")
        if pd.get("req_model") != d["req_model"]:
            d["flags"].append("model changed")
        if pd.get("max_tokens") != d["max_tokens"]:
            d["flags"].append("max_tokens changed")

    # tool names for results
    tmap = {}
    for m in msgs:
        if m.get("role") == "assistant":
            for b in blocks_of(m):
                if b.get("type") == "tool_use" and b.get("id"):
                    tmap[b["id"]] = (b.get("name") or "?", b.get("input"))
    you, results, harness, task = [], [], [], []
    dot = False
    for m in msgs[d["new_from"]:d["new_to"]]:
        if m.get("role") != "user":
            continue
        for b in blocks_of(m):
            if b.get("type") == "text":
                for tag, txt in segments(b.get("text") or ""):
                    if tag:
                        lab = "subagent result" if (tag == "task-notification" or "<task-notification" in txt) \
                            else squash(txt)
                        harness.append(lab)
                    elif tname == "side":
                        harness.append(squash(txt))
                    elif tname.startswith("sub-"):
                        task.append(squash(txt))
                    else:
                        you.append(squash(txt))
            elif b.get("type") == "tool_result":
                nm, inp = tmap.get(b.get("tool_use_id"), ("?", None))
                results.append((nm, inp))
                if b.get("is_error"):
                    dot = True
    d["dot"] = dot
    d["anatomy"], d["you_chars"] = anatomy(body, msgs, d["new_from"], d["new_to"], tname)
    d["prev_ex"] = th.exs[-1] if th.exs else None

    def up_line(short):
        if you:
            return 'YOU "%s"' % you[0]
        if results:
            nm, inp = results[0]
            s = "RESULT %s %s" % (nm, call_arg(inp, short))
            return s.strip() + (" (+%d)" % (len(results) - 1) if len(results) > 1 else "")
        if task:
            return 'TASK "%s"' % task[0]
        if harness:
            return "HARNESS " + ("subagent result" if "subagent result" in harness else harness[0])
        return ""
    d["up"] = cut(up_line(True), 60)
    d["tip_up"] = up_line(False)
    if not th.title:
        if tname == "main" or not tname.startswith("sub-"):
            if you:
                th.title = cut(you[0], 60)
            elif th.first_prompt:
                th.title = cut(squash(th.first_prompt), 60)
    if tname.startswith("sub-") and th.parent is None:
        find_parent(th, label)
    if tname.startswith("sub-") and not th.title:
        th.title = cut(squash(th.first_prompt), 60)

    th.exs.append(ex)
    # pair earlier calls with results carried by this request
    changed = set()
    for m in msgs:
        if m.get("role") != "user":
            continue
        for b in blocks_of(m):
            if b.get("type") == "tool_result":
                owner = CALLS.get(b.get("tool_use_id"))
                if owner is not None and owner.id < ex.id and owner.thread is th \
                        and b["tool_use_id"] not in owner.results:
                    owner.results[b["tool_use_id"]] = {"from": ex.id, "content": b.get("content"),
                                                       "is_error": bool(b.get("is_error"))}
                    changed.add(owner)
    for e in th.exs:
        if e is not ex and e.state != "pending" and any(
                b["type"] == "tool_use" and b.get("id") not in e.results for b in e.blocks.values()):
            changed.add(e)
    for e in changed:
        publish(e)


def find_parent(th, label):
    prompt = squash(th.first_prompt)
    main = THREADS.get((label, "main"))
    if not prompt or main is None:
        return
    for e in reversed(main.exs):
        for b in e.blocks.values():
            if b["type"] == "tool_use" and isinstance(b.get("input"), dict):
                p = b["input"].get("prompt")
                if isinstance(p, str) and squash(p) == prompt:
                    th.parent = [e.id, b.get("id")]
                    th.title = cut(squash(b["input"].get("description") or prompt), 60)
                    return


def call_states(ex):
    th = ex.thread
    later = bool(th and any(e.id > ex.id for e in th.exs))
    out = []
    for i in sorted(ex.blocks):
        b = ex.blocks[i]
        if b["type"] != "tool_use":
            continue
        inp = b.get("input")
        if inp is None:
            try:
                inp = json.loads(b["json"]) if b["json"].strip() else {}
            except ValueError:
                inp = {}
        r = ex.results.get(b.get("id"))
        if r:
            st = "error" if r["is_error"] else "done"
        else:
            st = "noresult" if (later and ex.state in ("done", "aborted", "error")) else "waiting"
        out.append({"id": b.get("id"), "name": b.get("name"), "arg": call_arg(inp), "arg_short": call_arg(inp, True),
                    "state": st, "from": r["from"] if r else None})
    return out


def build_summary(ex):
    d = ex.d or {}
    th = ex.thread
    u = ex.usage
    inp, cr, cw = num(u.get("input_tokens")), num(u.get("cache_read_input_tokens")), num(u.get("cache_creation_input_tokens"))
    tin = inp + cr + cw
    out = num(u.get("output_tokens"))
    det = u.get("output_tokens_details")
    think = num(det.get("thinking_tokens")) if isinstance(det, dict) else 0
    calls = call_states(ex)
    texts = [b["text"] for i, b in sorted(ex.blocks.items()) if b["type"] == "text" and b["text"].strip()]
    err = ex.error or ex.sse_error
    if err:
        down = "ERROR " + squash(err)
        tip_down = down
    elif calls:
        c = calls[0]
        extra = " (+%d)" % (len(calls) - 1) if len(calls) > 1 else ""
        down = ("CALL %s %s" % (c["name"], c["arg_short"])).strip() + extra
        tip_down = ("CALL %s %s" % (c["name"], c["arg"])).strip() + extra
    elif texts:
        down = tip_down = 'MODEL "%s"' % squash(texts[0])
    elif ex.status and ex.status >= 400:
        down = tip_down = "ERROR HTTP %s %s" % (ex.status, squash(b"".join(ex.raw[:2]).decode("utf-8", "replace")))
    else:
        down = tip_down = ""
    if not d.get("is_message"):
        down = tip_down = ""
    pe = d.get("prev_ex")
    tool_time = max(0.0, ex.t_start - pe.t_end) if (pe is not None and pe.t_end) else None
    an = d.get("anatomy")
    csize = sum(an.values()) if an else 0
    cc = u.get("cache_creation")
    cw1h = num(cc.get("ephemeral_1h_input_tokens")) if isinstance(cc, dict) else 0
    red = bool(ex.state == "error" or (ex.status and ex.status >= 400) or ex.sse_error)
    amber = bool(ex.state == "aborted" or ex.stop_reason == "max_tokens" or any(c["state"] == "noresult" for c in calls))
    return {
        "id": ex.id, "session": d.get("session", ""), "thread": d.get("thread", ""),
        "thread_title": th.title if th else "", "agent_id": th.agent_id if th else None,
        "parent": th.parent if th else None, "state": ex.state, "status": ex.status, "method": ex.method,
        "path": ex.path, "is_message": bool(d.get("is_message")), "t_start": ex.t_start, "t_first": ex.t_first,
        "t_end": ex.t_end, "in": tin, "input": inp, "cache_read": cr, "cache_write": cw, "cache_write_1h": min(cw1h, cw), "out": out,
        "thinking_tokens": think, "cached": (cr / tin) if tin else None, "model": ex.model or d.get("req_model"),
        "stop_reason": ex.stop_reason, "up": d.get("up", ""), "down": cut(down, 60),
        "tip": "↑ %s\n↓ %s" % (d.get("tip_up", ""), tip_down) if d.get("is_message") else "%s %s" % (ex.method, ex.path),
        "calls": calls, "flags": d.get("flags", []), "red": red, "amber": amber, "dot": bool(d.get("dot")),
        "size": ex.req_size, "evicted": ex.evicted, "error": err, "msgs": d.get("msgs_n"),
        "new_from": d.get("new_from"), "new_to": d.get("new_to"), "reply_of": d.get("reply_of"),
        "anatomy": an, "content_size": csize, "your_chars": d.get("you_chars", 0), "tool_time": tool_time,
    }


def broadcast(name, data):
    payload = json.dumps(data)
    for c in list(CLIENTS):
        try:
            c.q.put_nowait((name, payload))
        except queue.Full:
            c.dead = True
            CLIENTS.discard(c)


def publish(ex, force=False):
    s = build_summary(ex)
    key = json.dumps(s, sort_keys=True)
    if key == ex.pubkey and not force:
        return
    ex.pubkey = key
    ex.version += 1
    s["version"] = ex.version
    ex.summary = s
    broadcast("exchange", s)


def evict():
    if MEM[0] <= MAX_BODY_BYTES:
        return
    for e in EXCHANGES:
        if MEM[0] <= MAX_BODY_BYTES:
            break
        if not e.evicted and e.state not in ("pending", "streaming"):
            MEM[0] -= len(e.req_body) + e.raw_size
            e.req_body, e.raw, e.raw_size, e.results, e.evicted = b"", [], 0, {}, True
            publish(e, True)


def terminal_line(ex):
    s = ex.summary
    parts = [now_str(ex.t_end), "#%d" % ex.id, s["thread"] or "-", ex.method, urlsplit(ex.path).path,
             str(ex.status or "-"), "%.1fs" % ((ex.t_end or ex.t_start) - ex.t_start)]
    if s["is_message"] and s["in"]:
        parts.append("in %s (%d%% cached) out %s" % (fmtk(s["in"]), round((s["cached"] or 0) * 100), fmtk(s["out"])))
    if ex.state in ("error", "aborted"):
        parts.append("%s%s" % (ex.state.upper(), (": " + ex.error) if ex.error else ""))
    print(" ".join(parts), flush=True)


def handle(evt):
    kind, ex = evt[0], evt[1]
    if kind == "req":
        ex.req_body, ex.req_size = evt[2], len(evt[2])
        MEM[0] += ex.req_size
        analyze(ex)
        publish(ex, True)
        if VERBOSE:
            print("\n%s\n[%s] >>> %s %s" % ("=" * 78, now_str(), ex.method, ex.path))
            for k, v in ex.req_headers:
                print("    %s: %s" % (k, v))
            if ex.req_body:
                try:
                    print(json.dumps(json.loads(ex.req_body), indent=2, ensure_ascii=False))
                except ValueError:
                    print(ex.req_body.decode("utf-8", "replace"))
            sys.stdout.flush()
    elif kind == "hdrs":
        ex.status = evt[2]
        ex.resp_headers = redact(evt[3])
        ex.state = "streaming"
        publish(ex)
        if VERBOSE:
            print("\n[%s] <<< %s" % (now_str(), ex.status), flush=True)
    elif kind == "chunk":
        chunk = evt[2]
        if ex.t_first is None:
            ex.t_first = time.time()
        ex.raw.append(chunk)
        ex.raw_size += len(chunk)
        MEM[0] += len(chunk)
        feed(ex, chunk)
        if VERBOSE:
            sys.stdout.write(ex.vdec.decode(chunk))
            sys.stdout.flush()
        t = time.time()
        if t - ex.last_pub >= 0.25:
            ex.last_pub = t
            publish(ex)
            broadcast("reply", {"id": ex.id, "version": ex.version, "reply": reply_dict(ex)})
    elif kind == "end":
        ex.t_end = time.time()
        if ex.t_first is None:
            ex.t_first = ex.t_end
        if ex.linebuf.strip():
            sse_line(ex, ex.linebuf)
            ex.linebuf = ""
        if not ex.blocks and ex.raw:
            try:
                obj = json.loads(b"".join(ex.raw).decode("utf-8", "replace"))
                if isinstance(obj, dict):
                    load_json_reply(ex, obj)
            except ValueError:
                pass
        ex.state = "done"
        publish(ex)
        broadcast("reply", {"id": ex.id, "version": ex.version, "reply": reply_dict(ex)})
        terminal_line(ex)
        evict()
    elif kind in ("error", "abort"):
        ex.t_end = time.time()
        ex.state = "error" if kind == "error" else "aborted"
        if kind == "error":
            ex.error = evt[2]
        publish(ex)
        terminal_line(ex)
    # pending exchanges that fail must also refresh other calls' states
    if kind in ("end", "error", "abort") and ex.thread:
        for e in ex.thread.exs:
            if e is not ex and e.blocks:
                publish(e)


def worker():
    while True:
        evt = EVENTS.get()
        try:
            with LOCK:
                handle(evt)
        except Exception:
            traceback.print_exc()


# ---------------------------------------------------------------- proxy side
class Tap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def relay(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""
        with LOCK:
            ex = Exchange(len(EXCHANGES) + 1, self.command, self.path, list(self.headers.items()))
            EXCHANGES.append(ex)
        EVENTS.put(("req", ex, body))
        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        up = conn_cls(target.netloc, timeout=10)
        try:
            try:
                up.connect()
                up.sock.settimeout(600)
                headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP}
                up.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
                reply = up.getresponse()
            except Exception as e:
                msg = "cannot reach %s: %s" % (UPSTREAM, squash(str(e))[:200])
                EVENTS.put(("error", ex, msg))
                self.close_connection = True
                try:
                    self.send_error(502, "proxy: " + msg)
                except OSError:
                    pass
                return
            EVENTS.put(("hdrs", ex, reply.status, reply.getheaders()))
            try:
                self.send_response(reply.status, reply.reason)
                for n, v in reply.getheaders():
                    if n.lower() not in SKIP and n.lower() != "content-encoding":
                        self.send_header(n, v)
                self.send_header("Connection", "close")
                self.end_headers()
            except OSError:
                EVENTS.put(("abort", ex))
                self.close_connection = True
                return
            self.close_connection = True
            if self.command == "HEAD":
                EVENTS.put(("end", ex))
                return
            while True:
                try:
                    chunk = reply.read1(4096)
                except Exception as e:
                    EVENTS.put(("error", ex, "upstream stream broke: %s" % squash(str(e))[:200]))
                    return
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except OSError:
                    EVENTS.put(("abort", ex))
                    return
                EVENTS.put(("chunk", ex, chunk))
            EVENTS.put(("end", ex))
        finally:
            try:
                up.close()
            except Exception:
                pass


for _m in ("POST", "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"):
    setattr(Tap, "do_" + _m, Tap.relay)


# ---------------------------------------------------------------- UI side
class Client:
    def __init__(self):
        self.q = queue.Queue(maxsize=2000)
        self.dead = False


def build_detail(ex):
    det = {"id": ex.id, "summary": ex.summary, "evicted": ex.evicted, "req_headers": ex.req_headers,
           "resp_headers": ex.resp_headers, "error": ex.error}
    if ex.evicted:
        return det
    body = None
    if ex.req_body:
        try:
            body = json.loads(ex.req_body.decode("utf-8", "replace"))
        except ValueError:
            det["body_text"] = ex.req_body[:100000].decode("utf-8", "replace")
    det["body"] = body
    d = ex.d or {}
    det.update(new_from=d.get("new_from", 0), new_to=d.get("new_to", 0), reply_of=d.get("reply_of"),
               reply=reply_dict(ex), results=ex.results, raw_reply=b"".join(ex.raw).decode("utf-8", "replace"))
    origins, aorigin = {}, {}
    if isinstance(body, dict) and isinstance(body.get("messages"), list):
        for m in body["messages"]:
            if isinstance(m, dict) and m.get("role") == "assistant":
                for b in blocks_of(m):
                    owner = CALLS.get(b.get("id")) if b.get("type") == "tool_use" else None
                    if owner is not None:
                        origins[b["id"]] = owner.id
    if ex.thread:
        for e in ex.thread.exs:
            if e.id < ex.id:
                aorigin[str(len(e.d.get("keys", [])))] = {"id": e.id, "stop": e.stop_reason}
    det.update(origins=origins, assistant_origin=aorigin)
    return det


STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "application/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}


class UI(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def send_bytes(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        host = self.headers.get("Host", "")
        if host not in ("localhost:%d" % UI_PORT, "127.0.0.1:%d" % UI_PORT):
            return self.send_bytes(403, b"forbidden", "text/plain")
        path = urlsplit(self.path).path
        try:
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(HERE, "static", name), "rb") as f:
                    return self.send_bytes(200, f.read(), ctype)
            if path == "/api/exchanges":
                with LOCK:
                    data = json.dumps([e.summary for e in EXCHANGES if e.summary]).encode()
                return self.send_bytes(200, data, "application/json")
            m = re.match(r"^/api/exchanges/(\d+)$", path)
            if m:
                with LOCK:
                    i = int(m.group(1))
                    ex = EXCHANGES[i - 1] if 1 <= i <= len(EXCHANGES) else None
                    data = json.dumps(build_detail(ex)).encode() if ex and ex.summary else None
                if data is None:
                    return self.send_bytes(404, b"not found", "text/plain")
                return self.send_bytes(200, data, "application/json")
            if path == "/events":
                return self.events()
        except (BrokenPipeError, ConnectionResetError):
            return
        self.send_bytes(404, b"not found", "text/plain")

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        c = Client()
        c.q.put(("hello", json.dumps({"boot": BOOT})))
        with LOCK:
            CLIENTS.add(c)
        try:
            while not c.dead:
                try:
                    name, payload = c.q.get(timeout=15)
                    self.wfile.write(("event: %s\ndata: %s\n\n" % (name, payload)).encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with LOCK:
                CLIENTS.discard(c)


def main():
    global UPSTREAM, VERBOSE, UI_PORT
    ap = argparse.ArgumentParser(description="Live agent traffic dashboard.")
    ap.add_argument("--port", type=int, default=8041)
    ap.add_argument("--ui-port", type=int, default=8042)
    ap.add_argument("--upstream", default=UPSTREAM)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    signal.signal(signal.SIGINT, signal.default_int_handler)  # also when started in the background
    UPSTREAM, VERBOSE, UI_PORT = a.upstream.rstrip("/"), a.verbose, a.ui_port
    proxy = ThreadingHTTPServer(("127.0.0.1", a.port), Tap)
    ui = ThreadingHTTPServer(("127.0.0.1", a.ui_port), UI)
    proxy.daemon_threads = ui.daemon_threads = True
    threading.Thread(target=worker, daemon=True).start()
    for s in (proxy, ui):
        threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True).start()
    print("proxy      http://localhost:%d  ->  %s" % (a.port, UPSTREAM))
    print("run agent  ANTHROPIC_BASE_URL=http://localhost:%d claude" % a.port)
    print("dashboard  http://localhost:%d" % a.ui_port, flush=True)
    try:
        while True:
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\nbye", flush=True)
        os._exit(0)


if __name__ == "__main__":
    main()
