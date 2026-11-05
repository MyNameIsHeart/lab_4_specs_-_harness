#!/usr/bin/env python3
"""monitor.py: proxy + capture + live dashboard for agent (Claude Code) traffic.

    python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]
"""
import argparse
import codecs
import hashlib
import http.client
import json
import os
import queue
import re
import secrets
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM = "https://api.anthropic.com"
VERBOSE = False
UI_PORT = 8042
HERE = os.path.dirname(os.path.abspath(__file__))
BOOT_ID = secrets.token_hex(6)
MAX_BODIES = 300 * 1024 * 1024

SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authenticate", "accept-encoding", "content-length", "proxy-authorization",
}
REDACT = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}
HARNESS_TAGS = ("system-reminder", "task-notification", "command-name", "command-message",
                "command-args", "local-command-stdout", "local-command-caveat")
HARN_RE = re.compile(r"<(" + "|".join(HARNESS_TAGS) + r")>(.*?)</\1>", re.S)
ARG_KEYS = ("file_path", "command", "pattern", "url", "query", "description", "prompt")

LOCK = threading.RLock()          # guards all capture state
EXCHANGES = []                    # in id order
EX_BY_ID = {}
SESSIONS = {}                     # session key -> record
THREADS = {}                      # thread key -> record
NEXT_ID = [1]
BODY_BYTES = [0]
EVENTS = queue.Queue()            # relay threads -> capture worker
CLIENTS = []
CLIENTS_LOCK = threading.Lock()


def stamp():
    return datetime.now().strftime("%H:%M:%S")


def redact(pairs):
    return [[k, "[redacted]" if k.lower() in REDACT else v] for k, v in pairs]


# ---------------------------------------------------------------- helpers
def strip_cc(o):
    if isinstance(o, dict):
        return {k: strip_cc(v) for k, v in o.items() if k != "cache_control"}
    if isinstance(o, list):
        return [strip_cc(v) for v in o]
    return o


def mkey(m):
    return hashlib.md5(json.dumps(strip_cc(m), sort_keys=True, ensure_ascii=False).encode("utf-8", "replace")).hexdigest()


def main_arg(inp):
    if isinstance(inp, dict):
        for k in ARG_KEYS:
            v = inp.get(k)
            if v not in (None, ""):
                s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                return k, s
    return "", ""


def short_arg(k, s):
    if k == "file_path":
        s = s.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return s[:80]


def one_line(s, n=60):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def split_segments(text):
    out, pos = [], 0
    for m in HARN_RE.finditer(text):
        if m.start() > pos:
            out.append((False, "", text[pos:m.start()]))
        out.append((True, m.group(1), m.group(0)))
        pos = m.end()
    if pos < len(text):
        out.append((False, "", text[pos:]))
    return out


def content_text(content):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
                elif b.get("type") == "image":
                    src = b.get("source") or {}
                    data = src.get("data", "")
                    parts.append("[%s, %d KB]" % (src.get("media_type", "image"), len(data) * 3 // 4 // 1024))
                else:
                    parts.append(json.dumps(b, ensure_ascii=False))
            else:
                parts.append(str(b))
    elif content is not None:
        parts.append(json.dumps(content, ensure_ascii=False))
    return "\n".join(parts)


def other_block(b):
    t = b.get("type", "?") if isinstance(b, dict) else "?"
    if isinstance(b, dict) and t == "image":
        return {"kind": "other", "type": t, "text": content_text([b])}
    s = json.dumps(b, ensure_ascii=False, indent=2) if not isinstance(b, str) else b
    return {"kind": "other", "type": t, "text": s}


# ---------------------------------------------------------------- normalization
def harness_block(tag, span, session_threads):
    inner = re.sub(r"^<[^>]+>|</[^>]+>$", "", span).strip()
    first = next((l.strip() for l in inner.splitlines() if l.strip()), "")
    blk = {"kind": "harness", "tag": tag, "text": span, "summary": one_line("%s %s" % (tag, first), 110), "chars": len(span)}
    if tag == "task-notification" or "<task-notification>" in span:
        blk["label"] = "HARNESS · subagent result"
        for th in session_threads:
            if th.get("agent_id") and th["agent_id"] in span:
                blk["link"] = th["name"]
                blk["link_ex"] = th["exs"][0].id if th["exs"] else None
                break
    return blk


def norm_user_text(text, kind, msg_idx, state, ctx):
    """Split text into harness / plain blocks. Returns list of blocks."""
    out = []
    for is_h, tag, seg in split_segments(text):
        if is_h:
            out.append(harness_block(tag, seg, ctx["threads"]))
        elif seg.strip():
            if kind == "main":
                k = "you"
            elif kind == "sub" and msg_idx == 0 and not state.get("task"):
                k = "task"
                state["task"] = True
            elif kind == "sub":
                k = "harness"
            else:
                k = "harness"
            b = {"kind": k, "text": seg, "chars": len(seg)}
            if k == "harness":
                b.update({"tag": "", "summary": one_line(seg, 110)})
            out.append(b)
        else:
            out.append({"kind": "ws", "chars": len(seg)})
    return out


def norm_result(b, tool_map, call_index):
    tid = b.get("tool_use_id", "")
    info = tool_map.get(tid) or {}
    text = content_text(b.get("content"))
    blocks = []
    plain = ""
    harn = []
    for is_h, tag, seg in split_segments(text):
        if is_h:
            harn.append((tag, seg))
        else:
            plain += seg
    plain = plain.rstrip("\n") if harn else plain
    blk = {"kind": "result", "tool": info.get("name", ""), "arg": info.get("arg", ""), "arg_full": info.get("arg_full", ""),
           "text": plain, "is_error": bool(b.get("is_error")), "id": tid, "from": call_index.get(tid), "chars": len(plain)}
    blocks.append(blk)
    for tag, seg in harn:
        blocks.append(harness_block(tag, seg, []))
    return blocks


def build_tool_map(msgs, call_index_extra=None):
    tm = {}
    for m in msgs:
        if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    k, v = main_arg(b.get("input"))
                    tm[b.get("id")] = {"name": b.get("name", ""), "arg": short_arg(k, v), "arg_full": v}
    return tm


def norm_blocks_for_message(m, idx, kind, state, tool_map, call_index, ctx):
    """Return (blocks, harness_chars, other_chars, you_chars)."""
    role = m.get("role")
    content = m.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        content = []
    blocks = []
    for b in content:
        if not isinstance(b, dict):
            blocks.append(other_block(b))
            continue
        t = b.get("type")
        if t == "text":
            if role == "user":
                blocks.extend(norm_user_text(b.get("text", ""), kind, idx, state, ctx))
            else:
                blocks.append({"kind": "model", "text": b.get("text", ""), "chars": len(b.get("text", ""))})
        elif t == "thinking":
            th = b.get("thinking", "")
            blocks.append({"kind": "thinking", "text": th, "sig": len(b.get("signature", "")), "chars": len(th) + len(b.get("signature", ""))})
        elif t == "tool_use":
            k, v = main_arg(b.get("input"))
            blocks.append({"kind": "call", "tool": b.get("name", ""), "arg": short_arg(k, v), "arg_full": v, "id": b.get("id"),
                           "input": b.get("input"), "chars": len(b.get("name", "")) + len(json.dumps(b.get("input"), ensure_ascii=False))})
        elif t == "tool_result":
            blocks.extend(norm_result(b, tool_map, call_index))
        else:
            ob = other_block(b)
            ob["chars"] = len(ob["text"])
            blocks.append(ob)
    h = sum(b["chars"] for b in blocks if b["kind"] == "harness")
    y = sum(b["chars"] for b in blocks if b["kind"] == "you")
    o = sum(b.get("chars", 0) for b in blocks if b["kind"] != "harness")
    blocks = [b for b in blocks if b["kind"] != "ws"]
    return blocks, h, o, y


def norm_reply(rep, results=None, call_index=None):
    blocks = []
    for b in rep["blocks"]:
        t = b.get("type")
        if t == "text":
            blocks.append({"kind": "model", "text": b.get("text", "")})
        elif t == "thinking":
            blocks.append({"kind": "thinking", "text": b.get("thinking", ""), "sig": len(b.get("signature", "")), "tokens": b.get("est", 0)})
        elif t == "tool_use":
            inp = b.get("input")
            if inp is None:
                inp = {}
                try:
                    inp = json.loads(b.get("json") or "{}")
                except ValueError:
                    inp = {"_partial_json": b.get("json", "")}
            k, v = main_arg(inp)
            blocks.append({"kind": "call", "tool": b.get("name", ""), "arg": short_arg(k, v), "arg_full": v, "id": b.get("id"), "input": inp})
        else:
            ob = other_block({kk: vv for kk, vv in b.items() if not kk.startswith("_")})
            blocks.append(ob)
    th = ((rep["usage"].get("output_tokens_details") or {}).get("thinking_tokens"))
    return {"model": rep["model"], "stop_reason": rep["stop_reason"], "usage": rep["usage"], "blocks": blocks,
            "error": rep["error"], "thinking_tokens": th, "unknown": rep["unknown"][:20]}


# ---------------------------------------------------------------- records
class Exchange:
    def __init__(self, id_, method, path, headers):
        self.id = id_
        self.version = 1
        self.method = method
        self.path = path
        self.req_headers = redact(headers)
        self.resp_headers = []
        self.state = "pending"
        self.status = None
        self.t0 = time.time()
        self.t_first = None
        self.t_end = None
        self.req_body = b""
        self.req_size = 0
        self.raw_parts = []
        self.raw_size = 0
        self.evicted = False
        self.is_msg = method == "POST" and path.split("?")[0] == "/v1/messages"
        self.ctype = ""
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.buf = ""
        self.ev_name = None
        self.ev_data = []
        self.reply = {"model": None, "blocks": [], "stop_reason": None, "usage": {}, "error": None, "unknown": []}
        self.err = None
        self.last_pub = 0
        # analysis
        self.analyzed = False
        self.session = None
        self.thread = None
        self.nmsgs = 0
        self.mkeys = []
        self.prev = None
        self.retry_of = None
        self.hist_changed = None
        self.changes = []
        self.new_start = 0
        self.anatomy = None
        self.you_chars = 0
        self.up = {"text": "", "title": ""}
        self.results = {}
        self.err_results = 0
        self.pair = {}
        self.nores = set()
        self.tool_time = None
        self.sys_hash = None
        self.tools_hash = None
        self.model_req = None
        self.max_tokens = None
        self.done_reply = False


def touch(ex):
    ex.version += 1


def publish(event, data):
    msg = ("event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=True))).encode("ascii")
    with CLIENTS_LOCK:
        for q in list(CLIENTS):
            try:
                q.put_nowait(msg)
            except queue.Full:
                CLIENTS.remove(q)


def usage_of(ex):
    u = ex.reply["usage"] or {}
    inp = int(u.get("input_tokens") or 0)
    cr = int(u.get("cache_read_input_tokens") or 0)
    cw = int(u.get("cache_creation_input_tokens") or 0)
    out = int(u.get("output_tokens") or 0)
    cc = u.get("cache_creation") or {}
    cw5 = int(cc.get("ephemeral_5m_input_tokens") or 0) if isinstance(cc, dict) else 0
    cw1 = int(cc.get("ephemeral_1h_input_tokens") or 0) if isinstance(cc, dict) else 0
    if cw and not (cw5 or cw1):
        cw5 = cw
    th = (u.get("output_tokens_details") or {}).get("thinking_tokens")
    if th is None:
        th = sum(b.get("est", 0) for b in ex.reply["blocks"] if b.get("type") == "thinking")
    tin = inp + cr + cw
    return {"input": inp, "cache_read": cr, "cache_write": cw, "cw5": cw5, "cw1": cw1, "in": tin,
            "cached": (cr / tin) if tin else 0, "out": out, "thinking": int(th or 0)}


def summary(ex):
    th = ex.thread
    calls = []
    for b in ex.reply["blocks"]:
        if b.get("type") == "tool_use":
            tid = b.get("id")
            if tid in ex.pair:
                st = "error" if ex.pair[tid]["is_error"] else "ok"
            elif tid in ex.nores:
                st = "none"
            else:
                st = "waiting"
            inp = b.get("input")
            if inp is None:
                try:
                    inp = json.loads(b.get("json") or "{}")
                except ValueError:
                    inp = {}
            k, v = main_arg(inp)
            calls.append({"id": tid, "name": b.get("name", ""), "arg": short_arg(k, v), "arg_full": v, "state": st})
    down = {"text": "", "title": ""}
    if calls:
        c = calls[0]
        full = "CALL %s %s" % (c["name"], c["arg_full"])
        t = "CALL %s %s" % (c["name"], c["arg"])
        if len(calls) > 1:
            t = one_line(t, 54) + " (+%d)" % (len(calls) - 1)
        down = {"text": one_line(t, 60) if len(calls) == 1 else t, "title": full}
    else:
        for b in ex.reply["blocks"]:
            if b.get("type") == "text" and b.get("text", "").strip():
                down = {"text": one_line('MODEL "%s"' % one_line(b["text"], 52), 60), "title": b["text"][:500]}
                break
        else:
            if any(b.get("type") == "thinking" for b in ex.reply["blocks"]):
                down = {"text": "THINKING (hidden)", "title": "the model only thought"}
    sse_err = ex.reply["error"]
    red = bool(ex.state == "error" or (ex.status or 0) >= 400 or sse_err)
    amber = bool(ex.state == "aborted" or ex.reply["stop_reason"] == "max_tokens" or any(c["state"] == "none" for c in calls))
    flags = {}
    if ex.retry_of:
        flags["retry_of"] = ex.retry_of
    if ex.hist_changed is not None:
        flags["history_changed"] = ex.hist_changed
    if ex.changes:
        flags["changes"] = ex.changes
    return {
        "id": ex.id, "version": ex.version,
        "session": ex.session["n"] if ex.session else None,
        "thread": th["name"] if th else "-", "thread_key": th["id"] if th else None,
        "thread_kind": th["kind"] if th else None, "title": th["title"] if th else "",
        "parent_ex": (th.get("parent") or {}).get("ex") if th else None,
        "state": ex.state, "status": ex.status, "method": ex.method, "path": ex.path, "is_msg": ex.is_msg,
        "t0": ex.t0, "t_first": ex.t_first, "t_end": ex.t_end, "tool_time": ex.tool_time,
        "tokens": usage_of(ex), "model": ex.reply["model"] or ex.model_req, "stop_reason": ex.reply["stop_reason"],
        "up": ex.up, "down": down, "calls": calls, "flags": flags, "anatomy": ex.anatomy, "you_chars": ex.you_chars,
        "req_size": ex.req_size, "red": red, "amber": amber, "red_dot": ex.err_results > 0,
        "error": ex.err or (json.dumps(sse_err) if sse_err else None), "evicted": ex.evicted,
        "agent_id": th.get("agent_id") if th else None, "new_start": ex.new_start, "nmsgs": ex.nmsgs,
    }


def emit(ex):
    touch(ex)
    publish("exchange", summary(ex))


# ---------------------------------------------------------------- capture worker
def session_for(headers_l, body):
    sid = headers_l.get("x-claude-code-session-id")
    if not sid and isinstance(body, dict):
        uid = (body.get("metadata") or {}).get("user_id")
        if isinstance(uid, str):
            try:
                sid = (json.loads(uid) or {}).get("session_id")
            except ValueError:
                sid = None
        elif isinstance(uid, dict):
            sid = uid.get("session_id")
    return sid


def get_session(sid):
    key = sid or "none"
    s = SESSIONS.get(key)
    if not s:
        s = {"key": key, "n": len(SESSIONS) + 1, "subs": 0, "threads": [], "anon": 0}
        SESSIONS[key] = s
    return s


def first_user_text(msgs):
    for m in msgs[:1]:
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, str):
            c = [{"type": "text", "text": c}]
        for b in c or []:
            if isinstance(b, dict) and b.get("type") == "text":
                for is_h, tag, seg in split_segments(b.get("text", "")):
                    if not is_h and seg.strip():
                        return seg.strip()
    return ""


def analyze(ex, headers_l):
    body = None
    if ex.req_body:
        try:
            body = json.loads(ex.req_body)
        except ValueError:
            body = None
    sid = session_for(headers_l, body)
    sess = get_session(sid)
    ex.session = sess
    agent = headers_l.get("x-claude-code-agent-id")
    if not (ex.is_msg and isinstance(body, dict) and isinstance(body.get("messages"), list)):
        key = ("misc", sess["key"])
        th = THREADS.get(key)
        if not th:
            th = {"id": "t%d" % (len(THREADS) + 1), "key": key, "name": "-", "kind": "misc", "agent_id": None, "exs": [], "title": "", "session": sess}
            THREADS[key] = th
        th["exs"].append(ex)
        ex.thread = th
        ex.analyzed = True
        return
    msgs = body["messages"]
    tools = body.get("tools") or []
    ex.model_req = body.get("model")
    ex.max_tokens = body.get("max_tokens")
    ex.nmsgs = len(msgs)
    ex.mkeys = [mkey(m) for m in msgs]
    ftext = first_user_text(msgs)
    if not tools:
        kind, key = "side", ("side", ex.id)
    elif agent:
        kind, key = "sub", (sess["key"], agent)
    elif sid:
        kind, key = "main", (sess["key"], "main")
    else:
        kind, key = "main", ("anon", hashlib.md5(ftext.encode("utf-8", "replace")).hexdigest())
    th = THREADS.get(key)
    if not th:
        if kind == "sub":
            sess["subs"] += 1
            name = "sub-%d" % sess["subs"]
        elif kind == "side":
            name = "side"
        elif key[0] == "anon":
            sess["anon"] += 1
            name = "main" if sess["anon"] == 1 else "t-%d" % sess["anon"]
        else:
            name = "main"
        th = {"id": "t%d" % (len(THREADS) + 1), "key": key, "name": name, "kind": kind, "agent_id": agent if kind == "sub" else None,
              "exs": [], "title": "", "session": sess, "call_index": {}, "parent": None, "first_prompt": ftext if kind == "sub" else ""}
        THREADS[key] = th
        sess["threads"].append(th)
    ex.thread = th
    earlier = [e for e in th["exs"] if e.analyzed and e.mkeys]
    # prev / retry / history
    prev, retry = None, None
    for e in reversed(earlier):
        if e.mkeys == ex.mkeys:
            if retry is None:
                retry = e
            continue
        if len(e.mkeys) < len(ex.mkeys) and ex.mkeys[:len(e.mkeys)] == e.mkeys:
            prev = e
            break
    if retry is not None:
        ex.retry_of = retry.id
        prev = retry.prev
        ex.new_start = retry.new_start
        ex.hist_changed = retry.hist_changed
    elif prev is not None:
        ns = len(prev.mkeys)
        if ns < len(msgs) and isinstance(msgs[ns], dict) and msgs[ns].get("role") == "assistant":
            ns += 1
        ex.new_start = ns
    elif earlier:
        last = earlier[-1]
        i = 0
        while i < min(len(last.mkeys), len(ex.mkeys)) and last.mkeys[i] == ex.mkeys[i]:
            i += 1
        ex.hist_changed = i
        ex.new_start = i
    else:
        ex.new_start = 0
    ex.prev = prev
    # system / tools
    sysv = body.get("system")
    if isinstance(sysv, list):
        stext = "\n".join(b.get("text", "") for b in sysv if isinstance(b, dict))
    else:
        stext = sysv if isinstance(sysv, str) else ""
    tools_json = json.dumps(tools, separators=(",", ":"), ensure_ascii=False)
    ex.sys_hash = hashlib.md5(stext.encode("utf-8", "replace")).hexdigest()
    ex.tools_hash = hashlib.md5(tools_json.encode("utf-8", "replace")).hexdigest()
    if prev is not None:
        if ex.sys_hash != prev.sys_hash:
            ex.changes.append("system changed")
        if ex.tools_hash != prev.tools_hash:
            ex.changes.append("tools changed")
        if ex.model_req != prev.model_req:
            ex.changes.append("model changed")
        if ex.max_tokens != prev.max_tokens:
            ex.changes.append("max_tokens changed")
    # normalization of all messages for anatomy and summary
    ctx = {"threads": sess["threads"]}
    tool_map = build_tool_map(msgs)
    state = {}
    harness = earlier_c = new_c = you = 0
    new_blocks = []
    for i, m in enumerate(msgs):
        if not isinstance(m, dict):
            continue
        blocks, h, o, y = norm_blocks_for_message(m, i, kind, state, tool_map, th["call_index"], ctx)
        harness += h
        you += y
        if i < ex.new_start:
            earlier_c += o
        else:
            new_c += o
            new_blocks.extend(blocks)
            for b in blocks:
                if b["kind"] == "result" and b["id"]:
                    ex.results[b["id"]] = {"is_error": b["is_error"], "msg": i}
                    if b["is_error"]:
                        ex.err_results += 1
            if m.get("role") == "user" and isinstance(m.get("content"), list):
                for b in m["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        ex.results[b.get("tool_use_id")] = b
    ex.you_chars = you
    sysc, toolc = len(stext), len(tools_json)
    ex.anatomy = {"system": sysc, "tools": toolc, "harness": harness, "earlier": earlier_c, "new": new_c,
                  "total": sysc + toolc + harness + earlier_c + new_c}
    # summary line "up"
    ex.up = up_line(new_blocks)
    # thread title
    if not th["title"]:
        if kind == "main" or kind == "side":
            yb = next((b for b in new_blocks if b["kind"] == "you"), None)
            th["title"] = one_line(yb["text"], 60) if yb else ""
        else:
            th["title"] = one_line(th.get("first_prompt", ""), 60)
    # tool time
    if earlier:
        pe = earlier[-1]
        if pe.t_end:
            ex.tool_time = max(0.0, ex.t0 - pe.t_end)
    th["exs"].append(ex)
    ex.analyzed = True
    ex.new_blocks_n = len(new_blocks)


def up_line(blocks):
    def mk(prefix, text, title=None):
        return {"text": one_line('%s "%s"' % (prefix, one_line(text, 50)), 60), "title": title or text[:500]}
    for b in blocks:
        if b["kind"] == "you":
            return mk("YOU", b["text"])
    res = [b for b in blocks if b["kind"] == "result"]
    if res:
        r = res[0]
        t = "RESULT %s %s" % (r["tool"], r["arg"])
        if len(res) > 1:
            t = one_line(t, 54) + " (+%d)" % (len(res) - 1)
        else:
            t = one_line(t, 60)
        return {"text": t, "title": "RESULT %s %s" % (r["tool"], r["arg_full"])}
    for b in blocks:
        if b["kind"] == "task":
            return mk("TASK", b["text"])
    for b in blocks:
        if b["kind"] == "harness":
            if b.get("label"):
                return {"text": "HARNESS subagent result", "title": b["summary"]}
            return {"text": one_line("HARNESS " + b["summary"], 60), "title": b["summary"]}
    return {"text": "", "title": ""}


def resolve_parents(sess):
    changed = []
    for th in sess["threads"]:
        if th["kind"] == "sub" and not th.get("parent") and th.get("first_prompt"):
            fp = th["first_prompt"].strip()
            for mt in sess["threads"]:
                if mt["kind"] != "main":
                    continue
                for e in mt["exs"]:
                    for b in e.reply["blocks"]:
                        if b.get("type") == "tool_use" and isinstance(b.get("input"), dict):
                            p = b["input"].get("prompt")
                            if isinstance(p, str) and p.strip() == fp:
                                th["parent"] = {"ex": e.id, "call_id": b.get("id")}
                                desc = b["input"].get("description")
                                if desc:
                                    th["title"] = one_line(str(desc), 60)
                                changed.append(th)
                                break
                    if th.get("parent"):
                        break
                if th.get("parent"):
                    break
    for th in changed:
        for e in th["exs"]:
            emit(e)


def pair_thread(th):
    for e in th["exs"]:
        if not e.done_reply:
            continue
        calls = [b.get("id") for b in e.reply["blocks"] if b.get("type") == "tool_use"]
        ch = False
        for cid in calls:
            if cid in e.pair or cid in e.nores:
                continue
            later = [x for x in th["exs"] if x.id > e.id and x.analyzed and x.mkeys]
            for x in later:
                r = x.results.get(cid)
                if isinstance(r, dict) and "tool_use_id" in r:
                    e.pair[cid] = {"from": x.id, "block": r, "is_error": bool(r.get("is_error"))}
                    ch = True
                    break
            else:
                if later:
                    e.nores.add(cid)
                    ch = True
        if ch:
            emit(e)


def parse_event(ex, name, data_lines):
    raw = "\n".join(data_lines).strip()
    if not raw:
        return
    try:
        d = json.loads(raw)
    except ValueError:
        ex.reply["unknown"].append({"event": name, "raw": raw[:500]})
        return
    if not isinstance(d, dict):
        return
    rep = ex.reply
    t = d.get("type") or name
    if t == "message_start":
        msg = d.get("message") or {}
        rep["model"] = msg.get("model") or rep["model"]
        rep["usage"].update({k: v for k, v in (msg.get("usage") or {}).items() if v is not None})
    elif t == "content_block_start":
        idx = d.get("index", len(rep["blocks"]))
        cb = dict(d.get("content_block") or {})
        cb.setdefault("type", "text")
        if cb["type"] == "tool_use":
            cb["json"] = ""
            cb.pop("input", None) if cb.get("input") == {} else None
        if cb["type"] == "thinking":
            cb.setdefault("thinking", "")
            cb["est"] = 0
        if cb["type"] == "text":
            cb.setdefault("text", "")
        while len(rep["blocks"]) <= idx:
            rep["blocks"].append({"type": "unknown"})
        rep["blocks"][idx] = cb
    elif t == "content_block_delta":
        idx = d.get("index", 0)
        dl = d.get("delta") or {}
        if idx >= len(rep["blocks"]):
            return
        b = rep["blocks"][idx]
        dt = dl.get("type")
        if dt == "text_delta":
            b["text"] = b.get("text", "") + (dl.get("text") or "")
        elif dt == "thinking_delta":
            b["thinking"] = b.get("thinking", "") + (dl.get("thinking") or "")
            b["est"] = b.get("est", 0) + int(dl.get("estimated_tokens") or 0)
        elif dt == "signature_delta":
            b["signature"] = b.get("signature", "") + (dl.get("signature") or "")
        elif dt == "input_json_delta":
            b["json"] = b.get("json", "") + (dl.get("partial_json") or "")
    elif t == "content_block_stop":
        idx = d.get("index", 0)
        if idx < len(rep["blocks"]):
            b = rep["blocks"][idx]
            if b.get("type") == "tool_use":
                try:
                    b["input"] = json.loads(b.get("json") or "{}")
                except ValueError:
                    pass
    elif t == "message_delta":
        dl = d.get("delta") or {}
        if dl.get("stop_reason"):
            rep["stop_reason"] = dl["stop_reason"]
        for k, v in (d.get("usage") or {}).items():
            if v is not None:
                rep["usage"][k] = v
    elif t == "error":
        rep["error"] = d.get("error") or d
    elif t in ("message_stop", "ping"):
        pass
    else:
        rep["unknown"].append({"event": name, "data": d})


def feed(ex, text):
    ex.buf += text
    lines = ex.buf.split("\n")
    ex.buf = lines.pop()
    for line in lines:
        line = line.rstrip("\r")
        if line == "":
            if ex.ev_data or ex.ev_name:
                parse_event(ex, ex.ev_name, ex.ev_data)
            ex.ev_name, ex.ev_data = None, []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            ex.ev_name = line[6:].strip()
        elif line.startswith("data:"):
            ex.ev_data.append(line[5:])


def finish_reply(ex):
    tail = ex.dec.decode(b"", final=True)
    if tail:
        ex.raw_parts.append(tail)
        feed(ex, tail)
    if ex.buf:
        feed(ex, "\n")
    if ex.ev_data:
        parse_event(ex, ex.ev_name, ex.ev_data)
        ex.ev_data = []
    if "event-stream" not in ex.ctype and ex.raw_parts:
        try:
            d = json.loads("".join(ex.raw_parts))
        except ValueError:
            d = None
        if isinstance(d, dict):
            rep = ex.reply
            if d.get("type") == "error" or ("error" in d and "content" not in d):
                rep["error"] = d.get("error") or d
            rep["model"] = d.get("model") or rep["model"]
            rep["stop_reason"] = d.get("stop_reason")
            rep["usage"] = d.get("usage") or {}
            for b in d.get("content") or []:
                if isinstance(b, dict):
                    nb = dict(b)
                    if nb.get("type") == "tool_use":
                        nb["json"] = json.dumps(nb.get("input"))
                    rep["blocks"].append(nb)
    ex.done_reply = True


def evict():
    if BODY_BYTES[0] <= MAX_BODIES:
        return
    for e in EXCHANGES:
        if BODY_BYTES[0] <= MAX_BODIES:
            break
        if not e.evicted and e.state in ("done", "error", "aborted"):
            BODY_BYTES[0] -= len(e.req_body) + e.raw_size
            e.req_body = b""
            e.raw_parts = []
            e.raw_size = 0
            e.evicted = True
            emit(e)


def log_line(ex):
    s = summary(ex)
    dur = (ex.t_end or time.time()) - ex.t0
    t = s["tokens"]
    tok = ""
    if ex.is_msg and (t["in"] or t["out"]):
        tok = " in %s (%d%% cached) out %d" % (fmt_k(t["in"]), round(t["cached"] * 100), t["out"])
    st = ex.status if ex.status else ex.state
    print("%s #%d %s %s %s %s %.1fs%s" % (datetime.fromtimestamp(ex.t_end or time.time()).strftime("%H:%M:%S"), ex.id,
                                           s["thread"], ex.method, ex.path.split("?")[0], st, dur, tok), flush=True)


def fmt_k(n):
    return "%.1fk" % (n / 1000.0) if n >= 1000 else str(n)


def worker():
    while True:
        item = EVENTS.get()
        try:
            handle(item)
        except Exception as e:  # never die
            print("capture error: %r" % (e,), file=sys.stderr, flush=True)


def handle(item):
    kind, ex = item[0], item[1]
    with LOCK:
        if kind == "req":
            hl = item[2]
            analyze(ex, hl)
            BODY_BYTES[0] += len(ex.req_body)
            if VERBOSE:
                print("\n%s\n[%s] >>> #%d %s %s" % ("=" * 78, stamp(), ex.id, ex.method, ex.path))
                for k, v in ex.req_headers:
                    print("    %s: %s" % (k, v))
                if ex.req_body:
                    try:
                        print(json.dumps(json.loads(ex.req_body), indent=2, ensure_ascii=False))
                    except ValueError:
                        print(ex.req_body.decode("utf-8", "replace"))
                sys.stdout.flush()
            if ex.thread:
                pair_thread(ex.thread)
            emit(ex)
            evict()
        elif kind == "head":
            ex.status = item[2]
            ex.resp_headers = redact(item[3])
            ex.ctype = next((v for k, v in item[3] if k.lower() == "content-type"), "")
            ex.state = "streaming"
            if VERBOSE:
                print("\n[%s] <<< #%d %s" % (stamp(), ex.id, ex.status))
                for k, v in ex.resp_headers:
                    print("    %s: %s" % (k, v))
            emit(ex)
        elif kind == "chunk":
            chunk = item[2]
            if ex.t_first is None:
                ex.t_first = time.time()
            text = ex.dec.decode(chunk)
            if text:
                ex.raw_parts.append(text)
                ex.raw_size += len(chunk)
                BODY_BYTES[0] += len(chunk)
                feed(ex, text)
                if VERBOSE:
                    sys.stdout.write(text)
                    sys.stdout.flush()
            now = time.time()
            if now - ex.last_pub >= 0.25:
                ex.last_pub = now
                emit(ex)
                publish("reply", {"id": ex.id, "version": ex.version, "reply": norm_reply(ex.reply)})
        elif kind in ("end", "error", "abort"):
            if ex.t_end is not None:
                return
            ex.t_end = time.time()
            finish_reply(ex)
            if kind == "end":
                ex.state = "done"
            elif kind == "abort":
                ex.state = "aborted"
            else:
                ex.state = "error"
                ex.err = item[2]
            if ex.thread:
                pair_thread(ex.thread)
                for b in ex.reply["blocks"]:
                    if b.get("type") == "tool_use" and b.get("id"):
                        ex.thread.setdefault("call_index", {})[b["id"]] = ex.id
                resolve_parents(ex.session)
            emit(ex)
            publish("reply", {"id": ex.id, "version": ex.version, "reply": norm_reply(ex.reply)})
            log_line(ex)
            evict()


# ---------------------------------------------------------------- detail
def detail(ex_id):
    with LOCK:
        ex = EX_BY_ID.get(ex_id)
        if not ex:
            return None
        d = {"summary": summary(ex), "req_headers": ex.req_headers, "resp_headers": ex.resp_headers, "evicted": ex.evicted,
             "new_start": ex.new_start, "prev": ex.prev.id if ex.prev else None}
        th = ex.thread
        body = None
        if ex.req_body:
            try:
                body = json.loads(ex.req_body)
            except ValueError:
                body = None
        d["body"] = body
        d["body_text"] = None if body is not None else ex.req_body[:20000].decode("utf-8", "replace")
        d["reply"] = norm_reply(ex.reply)
        d["raw_reply"] = "".join(ex.raw_parts)
        d["parent"] = (th.get("parent") if th else None)
        # paired results
        res = {}
        msgs = body.get("messages", []) if isinstance(body, dict) else []
        for cid, p in ex.pair.items():
            tm = {}
            for b in ex.reply["blocks"]:
                if b.get("type") == "tool_use" and b.get("id") == cid:
                    inp = b.get("input") or {}
                    k, v = main_arg(inp)
                    tm[cid] = {"name": b.get("name", ""), "arg": short_arg(k, v), "arg_full": v}
            res[cid] = {"from": p["from"], "blocks": norm_result(p["block"], tm, {cid: ex.id})}
        d["results"] = res
        d["nores"] = sorted(ex.nores)
        conv = []
        if th and msgs:
            ctx = {"threads": ex.session["threads"]}
            tool_map = build_tool_map(msgs)
            state = {}
            byn = {}
            for e in th["exs"]:
                if e.done_reply and e.id < ex.id or e is ex:
                    byn[e.nmsgs] = e
            for i, m in enumerate(msgs):
                if not isinstance(m, dict):
                    continue
                blocks, h, o, y = norm_blocks_for_message(m, i, th["kind"], state, tool_map, th.get("call_index", {}), ctx)
                if m.get("role") == "assistant":
                    pe = byn.get(i)
                    head = "MODEL" + (" · #%d · %s" % (pe.id, pe.reply["stop_reason"] or "…") if pe else "")
                else:
                    head = "AGENT → MODEL"
                conv.append({"idx": i, "role": m.get("role"), "head": head, "new": i >= ex.new_start, "blocks": blocks})
        d["conv"] = conv
        return d


# ---------------------------------------------------------------- proxy
def read_body(h):
    te = (h.headers.get("transfer-encoding") or "").lower()
    if "chunked" in te:
        out = b""
        while True:
            line = h.rfile.readline().strip()
            n = int(line.split(b";")[0] or b"0", 16)
            if n == 0:
                while h.rfile.readline().strip():
                    pass
                break
            out += h.rfile.read(n)
            h.rfile.readline()
        return out
    n = int(h.headers.get("content-length") or 0)
    return h.rfile.read(n) if n else b""


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def relay(self):
        try:
            body = read_body(self)
        except (ValueError, OSError):
            self.close_connection = True
            return
        hdrs = list(self.headers.items())
        hl = {k.lower(): v for k, v in hdrs if k.lower() in ("x-claude-code-session-id", "x-claude-code-agent-id")}
        with LOCK:
            ex = Exchange(NEXT_ID[0], self.command, self.path, hdrs)
            NEXT_ID[0] += 1
            ex.req_body = body
            ex.req_size = len(body)
            EXCHANGES.append(ex)
            EX_BY_ID[ex.id] = ex
        EVENTS.put(("req", ex, hl))
        target = urlsplit(UPSTREAM)
        cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        up = cls(target.netloc, timeout=10)
        try:
            up.connect()
        except OSError as e:
            return self.fail(ex, "cannot reach %s: %s" % (UPSTREAM, e))
        try:
            up.sock.settimeout(600)
            fh = {k: v for k, v in hdrs if k.lower() not in SKIP}
            up.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=fh)
            reply = up.getresponse()
        except (OSError, http.client.HTTPException) as e:
            up.close()
            return self.fail(ex, "upstream failed: %s" % (e,))
        rh = reply.getheaders()
        EVENTS.put(("head", ex, reply.status, rh))
        try:
            self.send_response(reply.status, reply.reason)
            for k, v in rh:
                if k.lower() not in SKIP and k.lower() != "content-encoding":
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
        except OSError:
            EVENTS.put(("abort", ex))
            up.close()
            self.close_connection = True
            return
        self.close_connection = True
        if self.command == "HEAD":
            EVENTS.put(("end", ex))
            up.close()
            return
        while True:
            try:
                chunk = reply.read1(65536)
            except (OSError, http.client.HTTPException) as e:
                EVENTS.put(("error", ex, "upstream broke: %s" % (e,)))
                up.close()
                return
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except OSError:
                EVENTS.put(("abort", ex))
                up.close()
                return
            EVENTS.put(("chunk", ex, chunk))
        up.close()
        EVENTS.put(("end", ex))

    def fail(self, ex, msg):
        EVENTS.put(("error", ex, msg))
        try:
            self.send_error(502, "proxy: " + msg)
        except OSError:
            pass
        self.close_connection = True

    do_GET = do_POST = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = relay


# ---------------------------------------------------------------- UI server
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "application/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}


class UI(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        host = self.headers.get("Host", "")
        if host not in ("localhost:%d" % UI_PORT, "127.0.0.1:%d" % UI_PORT):
            return self.send(403, b"forbidden host", "text/plain")
        path = self.path.split("?")[0]
        try:
            if path in STATIC:
                name, ct = STATIC[path]
                with open(os.path.join(HERE, "static", name), "rb") as f:
                    return self.send(200, f.read(), ct)
            if path == "/api/exchanges":
                with LOCK:
                    data = json.dumps([summary(e) for e in EXCHANGES]).encode()
                return self.send(200, data, "application/json")
            m = re.match(r"^/api/exchanges/(\d+)$", path)
            if m:
                d = detail(int(m.group(1)))
                if d is None:
                    return self.send(404, b'{"error":"not found"}', "application/json")
                return self.send(200, json.dumps(d).encode(), "application/json")
            if path == "/events":
                return self.events()
            self.send(404, b"not found", "text/plain")
        except OSError:
            self.close_connection = True

    def events(self):
        q = queue.Queue(maxsize=5000)
        with CLIENTS_LOCK:
            CLIENTS.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(("event: hello\ndata: %s\n\n" % json.dumps({"boot": BOOT_ID})).encode())
            self.wfile.flush()
            last = time.time()
            while True:
                try:
                    msg = q.get(timeout=1)
                except queue.Empty:
                    with CLIENTS_LOCK:
                        if q not in CLIENTS:
                            return
                    if time.time() - last >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last = time.time()
                    continue
                self.wfile.write(msg)
                self.wfile.flush()
                last = time.time()
        except OSError:
            pass
        finally:
            with CLIENTS_LOCK:
                if q in CLIENTS:
                    CLIENTS.remove(q)
            self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global UPSTREAM, VERBOSE, UI_PORT
    ap = argparse.ArgumentParser(description="Live dashboard for agent API traffic.")
    ap.add_argument("--port", type=int, default=8041)
    ap.add_argument("--ui-port", type=int, default=8042)
    ap.add_argument("--upstream", default=UPSTREAM)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    UPSTREAM = a.upstream.rstrip("/")
    VERBOSE = a.verbose
    UI_PORT = a.ui_port
    threading.Thread(target=worker, daemon=True).start()
    proxy = Server(("127.0.0.1", a.port), Proxy)
    ui = Server(("127.0.0.1", a.ui_port), UI)
    for s in (proxy, ui):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print("proxy:     http://localhost:%d  ->  %s" % (a.port, UPSTREAM))
    print("agent:     ANTHROPIC_BASE_URL=http://localhost:%d claude" % a.port)
    print("dashboard: http://localhost:%d" % a.ui_port, flush=True)
    try:
        while True:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
