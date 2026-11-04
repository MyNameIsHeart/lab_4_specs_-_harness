# SPEC: Live Agent Traffic Dashboard

## 1. Goal

While the course proxy is running, I open one page in the browser. It updates live and shows
every message between my coding agent (Claude Code) and the model. The point is readability:
while the agent works, messages pile up fast, and I must be able to tell them apart at a glance
(my prompt, the model's reply, a tool call, its result, text the harness injected), follow the
conversation as it grows, and open any message in full.

## 2. How it runs

- One program, `monitor.py`, built from `proxy.py` (which stays unchanged in the folder as a
  reference). It runs on **Python 3.9+ with the standard library only**: macOS's
  `/usr/bin/python3` is 3.9, so no `match`, no `X | Y` types at runtime, nothing to install.
- `python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--save FILE] [--load FILE] [--verbose]`
- At startup it prints the proxy URL, the agent command
  (`ANTHROPIC_BASE_URL=http://localhost:8041 claude`) and the dashboard URL
  (`http://localhost:8042`). Both servers bind to 127.0.0.1 only.
- The page is static files served by `monitor.py`: `static/index.html`, `static/app.js`,
  `static/style.css`. Plain JavaScript and CSS: no framework, no CDN, no build step, works offline.
- The terminal prints one line per exchange (time, #id, method, path, status, duration, tokens).
  `--verbose` also prints the full dump, as `proxy.py` does.

## 3. Proxy behaviour (must not change)

- Forward every method and path to the upstream unchanged, with the same header handling as
  `proxy.py` (hop-by-hop headers and `accept-encoding` dropped), and stream the reply back to
  the agent chunk by chunk as it arrives. With the monitor in place the agent must behave
  exactly as with `proxy.py`. A bug in capturing or parsing is logged and never breaks or
  slows down the relay.
- Capture each request and its reply **inside the relay, as one record per request**. Never
  parse the proxy's stdout: concurrent requests (a subagent, a side request) interleave there.
- Upstream unreachable: return 502 to the agent (as `proxy.py` does) and show an error exchange.
- Credentials are never stored, saved or shown: the values of `authorization`, `x-api-key` and
  `cookie` are replaced by `[redacted]`.
- The reply stream can split an SSE event, or a multi-byte UTF-8 character, across chunks:
  parse with a line buffer and an incremental UTF-8 decoder.

## 4. What the traffic looks like (Claude Code, observed through the proxy)

- `HEAD /api/hello` (connectivity check) and `POST /v1/messages?beta=true`. Other paths may appear.
- Request body: `model`, `max_tokens`, `stream: true`, `system` (array of text blocks),
  `tools` (array of `{name, description, input_schema}`), `messages` (array of
  `{role, content}` where content is a string or an array of blocks), `metadata`, and more.
- Content block types: `text`, `thinking`, `tool_use` (`id`, `name`, `input`) in assistant
  messages; `text` and `tool_result` (`tool_use_id`, `content`, `is_error`) in user messages.
  The harness injects its own text into user messages, wrapped in `<system-reminder>…</system-reminder>`.
- Reply: Server-Sent Events: `message_start` (model, usage), then per block
  `content_block_start` / `content_block_delta` (`text_delta`, `thinking_delta`,
  `input_json_delta`, `signature_delta`) / `content_block_stop`, then `message_delta`
  (`stop_reason`, final usage) and `message_stop`; `ping` and `error` may appear.
- Each request of a conversation re-sends the whole history: request N+1 = request N's
  messages + the model's reply + one new user message (tool results and/or a new prompt).
- A tool call (`tool_use` in reply N) gets its result (`tool_result` with the same id) in a
  later request. One reply can contain several tool calls; their results come together.
- A subagent is a separate conversation with its own system prompt and first message, running
  at the same time as the main agent.

## 5. Data model

- **Exchange** = one request + its reply: `id` (1, 2, 3… in arrival order), times (start,
  first byte, end), method, path, status, request headers (redacted), request body (parsed JSON,
  or text), response headers, raw response text, state (`pending` → `streaming` → `done` |
  `error`), error message.
- **Assembled reply**, built from the SSE events: model, content blocks in order (text,
  thinking, tool calls with the input parsed from the concatenated `input_json_delta`),
  `stop_reason`, and `usage` (input, output, cache read, cache write tokens). A non-streaming
  JSON reply is used as is. Unknown events are kept for the raw view and never crash the parser.
- **Thread** (conversation): requests that share the same system text and the same first
  message (compared without `cache_control` fields). Label: `main` (the first thread with
  tools), `subagent 1, 2…` (other threads with tools), `side` (requests without tools).
  Title: the first ~60 characters of the human's first prompt.
- **New in this request**: the messages after the longest common prefix with the previous
  request of the same thread (compared without `cache_control`). If earlier history differs
  (compaction, edits), flag "history changed" and show what changed. Also report other changes
  since the previous request of the thread: system text, tool list, model, `max_tokens`.
- **Tool pair**: each `tool_use` is linked to the `tool_result` with the same id, wherever it
  appears in the same thread. A call without a result yet shows "waiting for result".

## 6. The page

```
┌ ● live │ 42 req · 1.2M in (93% cached) · 18k out · ~$0.84 · 1 error │ filters │ search │ Follow live ✓ ┐
├──────────────────────────────────┬─────────────────────────────────────────────────────────────────┤
│ #8  18:45:12  main   ✓ 1.9s      │ #8 · main · <model> · 200 · 1.9s (first byte 0.6s)               │
│   ↑ RESULT Agent "gamma"         │ in 3 · cache read 41,210 · cache write 512 · out 88 · ~$0.03      │
│   ↓ MODEL "The folder has…"      │ ▼ New in this request                                             │
│ #7  18:45:02  sub-1  ✓ 1.1s      │ ▼ Reply                                                           │
│   ↑ RESULT Read list.txt         │ ▶ Conversation so far (6 messages)                                │
│   ↓ CALL Bash "wc -l list.txt"   │ ▶ System instructions (14,302 chars · unchanged since #2)         │
│ #6  …                            │ ▶ Tools (19): Agent, Bash, Glob, Grep, Read, …                    │
│                                  │ ▶ Raw request / response                                          │
└──────────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

- **Top bar**: connection status (live / reconnecting), totals (requests, input tokens with
  cache-hit share, output tokens, estimated cost, errors), filters, search, a "Follow live"
  toggle, and a stats panel that opens below it.
- **Timeline (left)**: one row per exchange, **newest first**. A row appears within 1 second of
  the request arriving, before the reply is complete. It shows #id, time, thread badge (each
  thread its own colour), state (spinner and elapsed time while streaming, red when failed),
  duration, tokens in/out, and a two-line summary of what is new: `↑` what the agent sent
  (e.g. `RESULT Read notes.txt`, `YOU "fix the bug…"`) and `↓` what the model answered
  (`MODEL "…"`, `CALL Bash "wc -l list.txt"`).
- **Detail (right)**, for the selected exchange, sections in this order, each with a header and
  a collapse toggle:
  1. Summary: model, status, timing (start, time to first byte, total; for threads, the gap
     since the previous reply ≈ time the harness spent running tools), usage, estimated cost,
     stop reason, thread, request size, changes since the previous request.
  2. **New in this request** (open): only the new messages.
  3. **Reply** (open): the model's text, thinking (collapsed) and the tool calls it asks for.
     Each call shows its result beside it as soon as that result arrives (live).
  4. Conversation so far (closed): the full history as a transcript, tool calls paired with
     their results.
  5. System instructions (closed): the full text, its size, and "unchanged since #N" or "changed".
  6. Tool definitions (closed): count and names; each one opens to its description and input schema.
  7. Raw (closed): request headers and body, response headers and the raw SSE text.
- **Conversation view**: "Open conversation" on any exchange shows its whole thread as one
  chronological transcript (oldest at the top) that grows at the bottom while the agent works.
  Each model turn is tagged with the exchange #id it came from (click to open it).

## 7. Message rendering (the core)

Every block is a card with a coloured left border, an icon and a text label (never colour alone):

| Kind | Label | Look |
|---|---|---|
| The human's prompt (user text outside `<system-reminder>`) | YOU | blue |
| Harness-injected text (`<system-reminder>` spans and similar) | HARNESS | grey, collapsed to its first line |
| Model text | MODEL | green |
| Model thinking | THINKING | dim italic, collapsed |
| Tool call | CALL · ToolName | amber; header shows the main argument (`file_path`, `command`, `pattern`, `description`…) |
| Tool result | RESULT · ToolName | teal; red **ERROR** when `is_error` |
| System instructions | SYSTEM | dark grey |

- A user text block is split into segments: `<system-reminder>…</system-reminder>` spans are
  HARNESS, the rest (if not blank) is YOU.
- A tool call and its result sit side by side (or the result directly under the call), visibly
  joined, in the reply, in "new in this request" and in the conversation view.
- Long text (over 12 lines or 1,200 characters) is collapsed to its first 6 lines with
  "Show all (N lines, M chars)". Whitespace is preserved. Tool output and code use a
  monospace font; model text a proportional one. Model markdown is shown as plain text.
- JSON (tool inputs, schemas, raw bodies) is pretty-printed, syntax-coloured and foldable per
  object and array; long strings inside it are truncated with an expander.
- All traffic content is inserted as text, never as HTML: the traffic carries file contents,
  and `<script>` in a file must show up literally.
- Every block has a copy button (copies the raw content).

## 8. Live behaviour

- The page receives updates through Server-Sent Events (`GET /events` on the UI port). On load
  and on every reconnect it fetches the list (`GET /api/exchanges`, summaries only) and goes
  on from there: reloading the page shows the whole history.
- Full bodies (often 100 KB+ each) are fetched only when an exchange is opened
  (`GET /api/exchanges/<id>`), never pushed with the list.
- While a reply streams, the partial model text in the detail view updates at most 4 times a second.
- Follow live on: the newest exchange is selected automatically. Off, or while I am reading:
  the list never jumps and never steals the selection or the scroll; new rows show a
  "N new ↑" chip instead.
- History is kept in memory (last 1,000 exchanges). `--save FILE` appends each finished
  exchange to a JSONL file; `--load FILE` preloads one, to study an old session or develop
  without a live agent.

## 9. Filters, search, statistics

- Filters: thread, tool name (from the tools seen in calls), "errors only", "hide
  non-message requests" (e.g. `HEAD /api/hello`).
- Search: full text over all message content; non-matching exchanges are hidden and matches
  are highlighted in the detail view.
- Statistics panel: calls per tool, errors, tokens by kind, cache-hit share, estimated cost,
  and a small chart of input/output tokens per request over time.
- Cost: a price table per model at the top of `monitor.py` (USD per million tokens: input,
  output, cache write, cache read). Unknown model: "—". Always labelled "est.".

## 10. Errors are easy to spot

- Red row and badge: HTTP status ≥ 400, upstream unreachable, an SSE `error` event, a body that
  does not parse.
- Red result card: `tool_result` with `is_error: true`; its exchange row gets a red dot.
- Amber: `stop_reason` of `max_tokens`, or a tool call that never got a result.
- The error count in the top bar is clickable and filters to errors.

## 11. Acceptance checks

1. `python3 monitor.py` (Python 3.9, nothing installed) prints both URLs; with
   `ANTHROPIC_BASE_URL=http://localhost:8041 claude -p "Read notes.txt and tell me what it says"`
   the agent answers exactly as it does through `proxy.py`.
2. During that run, each request shows up in the timeline within 1 s, before its reply
   finishes; the page never needs a reload.
3. For that run I can see: the system instructions in full, the `Read` call with its
   `file_path`, its result next to it, and the final answer, each with the right label and colour.
4. A run that launches a subagent shows two threads, with no reply text mixed between
   concurrent requests.
5. "New in this request" for a tool-result request shows only the tool result(s) and the
   injected reminders, not the whole history.
6. A file containing `<script>alert(1)</script>` read by the agent appears as literal text.
7. `--upstream http://127.0.0.1:9` produces a red error exchange and a 502 for the agent.
   A failed tool call (e.g. reading a missing file) shows a red ERROR result.
8. Reloading the page brings back every exchange; killing and restarting with `--load` of a
   `--save` file shows the same history.
9. With 200 exchanges loaded the page stays responsive: opening an exchange takes under 300 ms.
10. No credential appears anywhere: page, API responses, saved file, terminal.

## 12. Open decisions (raised while drafting; my current choice in bold)

1. One program, or `proxy.py` unchanged plus a separate reader of its output → **one program**
   (the output interleaves concurrent streams and cannot be parsed reliably).
2. Dashboard on the proxy port under a reserved path, or on its own port → **own port, 8042**.
3. Live channel: SSE, WebSocket or polling → **SSE** (one direction is enough, stdlib-friendly).
4. Show the reply while it streams, or only when complete → **while it streams, throttled**.
5. Main layout: timeline + detail, or one chat transcript → **timeline + detail by default,
   transcript per thread on demand**.
6. Order: **timeline newest first; inside a conversation, oldest first** (reading order).
7. Thread rule: **same system text + same first message** (to revisit after seeing compaction).
8. Render model markdown → **no, plain text** for the first builds.
9. Persistence → **memory, plus optional JSONL save and load**.
10. Cost estimate → **yes, from a hard-coded price table, labelled "est."**
11. Codex (OpenAI format) traffic → **raw view only** for now.
12. Collapse thresholds (12 lines / 1,200 chars) → **to tune after the first build**.
