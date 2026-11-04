#!/usr/bin/env python3
"""fake_upstream.py: a stand-in for the Anthropic API, for monitor.py's checks.

    python3 tests/fake_upstream.py --port 8059
    python3 monitor.py --upstream http://127.0.0.1:8059

POST /v1/messages answers with a canned SSE reply: thinking (omitted text, a
signature), text containing "é" and "🙂", and one tool call (`Read notes.txt`;
none when the last user message carries a tool_result). The reply is a pure
function of the request body, so the same request gives the same bytes. The
`data:` JSON has whitespace padding and extra fields, like the real API.
HEAD/GET /api/hello answers 200.

Switches, as defaults on the command line or per request in an `x-fake` header
(comma-separated, e.g. `x-fake: hold=5,split`):
  hold=N       hold the stream open N seconds after the first text delta
  split        write the reply in 1-3 byte pieces (splits events and UTF-8 chars)
  500          answer HTTP 500 with a JSON error body
  drop         send the headers and part of the stream, then drop the connection
  cookie[=V]   add `set-cookie: V` (default SENTINEL) to the reply headers
  error        send an SSE `error` event mid-stream
  max_tokens   end with stop_reason max_tokens
  json         answer with a non-stream JSON message
  agent        make the tool call an `Agent` call (background subagent)
  tool / notool force or suppress the tool call
--record DIR saves each raw request (request line, headers, body) as DIR/NNNN.bin.
"""

import argparse
import hashlib
import json
import os
import random
import socket
import socketserver
import sys
import threading
import time

DEFAULTS = ""
RECORD = None
COUNTER = [0]
LOCK = threading.Lock()
AGENT_PROMPT = "Read list.txt and return its last line."


def parse_opts(spec):
    opts = {}
    for tok in (spec or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        k, _, v = tok.partition("=")
        opts[k.strip().lower()] = v.strip() if v else True
    return opts


def padded(obj, rnd):
    """JSON with random whitespace padding (deterministic per request)."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":" + " " * rnd.randint(0, 2)))
    return " " * rnd.randint(0, 2) + s + " " * rnd.randint(0, 3)


def last_user(body):
    msgs = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(msgs, list) or not msgs or not isinstance(msgs[-1], dict):
        return "", False
    c = msgs[-1].get("content")
    if isinstance(c, str):
        return c, False
    text, has_result = "", False
    for b in c if isinstance(c, list) else []:
        if isinstance(b, dict):
            if b.get("type") == "tool_result":
                has_result = True
            elif b.get("type") == "text":
                text = b.get("text") or text
    return text, has_result


def reply_events(raw_body, body, opts):
    h = hashlib.sha1(raw_body).hexdigest()
    rnd = random.Random(h)
    text, has_result = last_user(body)
    tool = ("tool" in opts) or ("agent" in opts) or not has_result
    if "notool" in opts:
        tool = False
    model = body.get("model") if isinstance(body, dict) else None
    ev = [("message_start", {"type": "message_start", "message": {
        "id": "msg_fake_" + h[:16], "type": "message", "role": "assistant", "model": model or "claude-fake-1",
        "content": [], "stop_reason": None, "stop_sequence": None, "extra_field": {"x": 1},
        "usage": {"input_tokens": 10, "cache_creation_input_tokens": 192, "cache_read_input_tokens": 27000,
                  "output_tokens": 1, "service_tier": "standard"}}})]
    ev.append(("content_block_start", {"type": "content_block_start", "index": 0,
                                       "content_block": {"type": "thinking", "thinking": "", "signature": ""}}))
    ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                       "delta": {"type": "thinking_delta", "thinking": "", "estimated_tokens": 151}}))
    ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                       "delta": {"type": "signature_delta", "signature": "Sig" + h * 4}}))
    ev.append(("content_block_stop", {"type": "content_block_stop", "index": 0}))
    ev.append(("ping", {"type": "ping"}))
    ev.append(("content_block_start", {"type": "content_block_start", "index": 1,
                                       "content_block": {"type": "text", "text": ""}}))
    parts = ["Voilà, café ", "🙂 reply ", h[:8], " to: ", (" ".join(text.split()) or "(no text)")[:48]]
    for i, p in enumerate(parts):
        ev.append(("content_block_delta", {"type": "content_block_delta", "index": 1,
                                           "delta": {"type": "text_delta", "text": p}}))
        if i == 0:
            ev.append(("HOLD", None))
    ev.append(("content_block_stop", {"type": "content_block_stop", "index": 1}))
    if "error" in opts:
        ev.append(("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded (fake)"}}))
        return [(n, padded(d, rnd) if d is not None else None) for n, d in ev]
    if tool:
        if "agent" in opts:
            name, inp = "Agent", {"description": "Read the list", "prompt": AGENT_PROMPT,
                                  "subagent_type": "general-purpose", "run_in_background": True}
        else:
            name, inp = "Read", {"file_path": "notes.txt"}
        js = json.dumps(inp)
        ev.append(("content_block_start", {"type": "content_block_start", "index": 2, "content_block": {
            "type": "tool_use", "id": "toolu_fake_" + h[:12], "name": name, "input": {}}}))
        for piece in (js[:7], js[7:20], js[20:]):
            ev.append(("content_block_delta", {"type": "content_block_delta", "index": 2,
                                               "delta": {"type": "input_json_delta", "partial_json": piece}}))
        ev.append(("content_block_stop", {"type": "content_block_stop", "index": 2}))
    stop = "max_tokens" if "max_tokens" in opts else ("tool_use" if tool else "end_turn")
    ev.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                 "usage": {"input_tokens": None, "output_tokens": 212,
                                           "output_tokens_details": {"thinking_tokens": 151}}}))
    ev.append(("message_stop", {"type": "message_stop"}))
    return [(n, padded(d, rnd) if d is not None else None) for n, d in ev]


def json_message(raw_body, body):
    h = hashlib.sha1(raw_body).hexdigest()
    return {"id": "msg_fake_" + h[:16], "type": "message", "role": "assistant",
            "model": (body.get("model") if isinstance(body, dict) else None) or "claude-fake-1",
            "content": [{"type": "text", "text": "JSON reply, café 🙂 " + h[:8]}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 12, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                      "output_tokens": 9}}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        head = b""
        line = self.rfile.readline(65537)
        if not line:
            return
        head += line
        headers = {}
        while True:
            h = self.rfile.readline(65537)
            if not h:
                return
            head += h
            if h in (b"\r\n", b"\n"):
                break
            k, _, v = h.decode("latin-1").partition(":")
            headers[k.strip().lower()] = v.strip()
        body = self.rfile.read(int(headers.get("content-length") or 0))
        with LOCK:
            COUNTER[0] += 1
            n = COUNTER[0]
        if RECORD:
            with open(os.path.join(RECORD, "%04d.bin" % n), "wb") as f:
                f.write(head + body)
        method, path = line.decode("latin-1").split(" ")[:2]
        opts = parse_opts(DEFAULTS)
        opts.update(parse_opts(headers.get("x-fake", "")))
        print("fake: #%d %s %s %s" % (n, method, path, ",".join(sorted(opts)) or "-"), flush=True)
        if path.startswith("/api/hello"):
            self.send_head("200 OK", [("Content-Type", "text/plain"), ("Content-Length", "2")])
            if method != "HEAD":
                self.wfile.write(b"ok")
            return
        if method != "POST" or not path.startswith("/v1/messages"):
            data = b'{"type":"error","error":{"type":"not_found_error","message":"fake: not found"}}'
            self.send_head("404 Not Found", [("Content-Type", "application/json"), ("Content-Length", str(len(data)))])
            self.wfile.write(data)
            return
        try:
            obj = json.loads(body)
        except ValueError:
            obj = {}
        cookie = opts.get("cookie")
        extra = [("set-cookie", cookie if isinstance(cookie, str) else "SENTINEL")] if cookie else []
        if "500" in opts or opts.get("status") == "500":
            data = b'{"type":"error","error":{"type":"api_error","message":"Internal server error (fake)"}}'
            self.send_head("500 Internal Server Error", [("Content-Type", "application/json"),
                                                         ("Content-Length", str(len(data)))] + extra)
            self.wfile.write(data)
            return
        if "json" in opts or (isinstance(obj, dict) and obj.get("stream") is False):
            data = json.dumps(json_message(body, obj), ensure_ascii=False).encode("utf-8")
            self.send_head("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(data))),
                                      ("request-id", "req_fake_" + hashlib.sha1(body).hexdigest()[:12])] + extra)
            self.wfile.write(data)
            return
        self.send_head("200 OK", [("Content-Type", "text/event-stream; charset=utf-8"),
                                  ("Cache-Control", "no-cache"), ("Transfer-Encoding", "chunked"),
                                  ("request-id", "req_fake_" + hashlib.sha1(body).hexdigest()[:12]), ("Connection", "close")] + extra)
        events = reply_events(body, obj, opts)
        hold = float(opts.get("hold") or 0) if opts.get("hold") is not True else 5.0
        drop_at = len(events) // 2 if "drop" in opts else None
        sent = 0
        for name, data in events:
            if name == "HOLD":
                if hold:
                    time.sleep(hold)
                continue
            if drop_at is not None and sent >= drop_at:
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            payload = ("event: %s\ndata: %s\n\n" % (name, data)).encode("utf-8")
            if "split" in opts:
                i = 0
                while i < len(payload):
                    size = 1 + (i % 3)
                    self.chunk(payload[i:i + size])
                    time.sleep(0.0005)
                    i += size
            else:
                self.chunk(payload)
                time.sleep(0.003)
            sent += 1
        self.wfile.write(b"0\r\n\r\n")

    def send_head(self, status, headers):
        out = "HTTP/1.1 %s\r\n" % status + "".join("%s: %s\r\n" % kv for kv in headers) + "\r\n"
        self.wfile.write(out.encode("latin-1"))

    def chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        print("fake: connection error: %s" % (sys.exc_info()[1],), flush=True)


def main():
    global DEFAULTS, RECORD
    p = argparse.ArgumentParser(description="A fake Anthropic API for monitor.py's checks.")
    p.add_argument("--port", type=int, default=8059)
    p.add_argument("--defaults", default="", help="default switches, e.g. 'hold=5,split'")
    p.add_argument("--record", help="save each raw request to this directory")
    a = p.parse_args()
    DEFAULTS, RECORD = a.defaults, a.record
    if RECORD:
        os.makedirs(RECORD, exist_ok=True)
    srv = Server(("127.0.0.1", a.port), Handler)
    print("fake upstream on http://127.0.0.1:%d (defaults: %s)" % (a.port, DEFAULTS or "none"), flush=True)
    try:
        srv.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
