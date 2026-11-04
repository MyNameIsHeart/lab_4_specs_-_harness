# SPEC: Live Agent Traffic Dashboard

## 1. Goal

While the course proxy runs, I open one page in the browser. It updates live and shows every
message between my coding agent (Claude Code) and the model. Readability is the point: while the
agent works, messages pile up fast, and I must tell them apart at a glance (my prompt, the
model's text, a tool call, its result, text the harness injected), follow the conversation as it
grows, and open any message in full.

The first build covers sections 2–10. Section 12 lists what comes later.

## 2. How it runs

- Files: `monitor.py` (proxy, capture and dashboard server), `static/index.html`,
  `static/app.js`, `static/style.css`, `tests/fake_upstream.py` (for the checks) and a short
  `README.md` with the commands. `proxy.py` stays unchanged, as the reference.
- Python 3.9+ standard library only: macOS's `/usr/bin/python3` is 3.9, so no `match` and no
  `X | Y` types at runtime. Plain JavaScript and CSS: no framework, no CDN, no build step.
- `python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]` prints the
  proxy URL, the agent command `ANTHROPIC_BASE_URL=http://localhost:8041 claude` and the
  dashboard URL `http://localhost:8042`. Both servers listen on 127.0.0.1 only. Ctrl-C exits
  within 1 second.
- The terminal prints one line per finished exchange, e.g.
  `18:45:12 #12 main POST /v1/messages 200 1.9s in 27.2k (94% cached) out 212`.
  `--verbose` adds `proxy.py`'s full dump, with redacted headers.

## 3. Proxy and capture

- Relay like `proxy.py`: same upstream, path and headers (hop-by-hop headers and
  `accept-encoding` dropped), the reply streamed back chunk by chunk as it arrives. Also relay
  PUT, PATCH, DELETE and OPTIONS. Forwarding comes first: nothing may delay a chunk.
- Each request becomes one **exchange** record. It is created, with its id, under a lock as soon
  as the request has been read, before connecting upstream (connecting can take 10 s), so it
  shows up at once.
- Never parse stdout: concurrent requests (e.g. a subagent's) interleave there beyond repair.
- Relay threads only hand raw events (request, response headers, each chunk, end, error) to
  **one capture worker thread** through a queue. The worker parses, pairs, summarizes and
  publishes. UI handlers read snapshots under a lock.
- Failures:
  - Upstream unreachable or failing before the reply headers: 502 to the agent (as `proxy.py`
    does) and an exchange in state `error`.
  - Upstream breaking after the headers: close both sides; state `error`.
  - The agent disconnecting mid-stream (Esc): state `aborted`, no traceback, and the next
    request works.
- Redaction: what is displayed, served by the API or printed uses a copy of the headers in which
  `authorization`, `x-api-key`, `proxy-authorization`, `cookie` and `set-cookie` read
  `[redacted]`. The originals are forwarded untouched.
- Reply chunks can split an SSE event or a UTF-8 character: parse with a line buffer and an
  incremental UTF-8 decoder.
- Memory: keep raw bodies and compute derived data once per exchange. Above 300 MB of bodies,
  drop the oldest bodies; their summaries stay and their detail says "evicted".

## 4. The traffic (Claude Code 2.1, observed through `proxy.py`)

- `HEAD /api/hello` once per launch (no body), then one `POST /v1/messages?beta=true` per model call.
- Headers:
  - `X-Claude-Code-Session-Id`: one per agent run, shared with its subagents.
  - `x-claude-code-agent-id`: only on a subagent's requests.
  - Also `anthropic-beta`, `anthropic-version` and `User-Agent`.
  - Only `Authorization` carries a credential.
- Body keys: `model`, `messages`, `system`, `tools`, `metadata`, `max_tokens`, `thinking`,
  `context_management`, `stream: true`.
  - `metadata.user_id` is a JSON string holding device, account and session ids.
  - Bodies are 50–110 KB: the tool definitions are about half, the system prompt a quarter.
- `system` has 3 text blocks: a billing line, a one-line identity, then the prompt (~28k
  characters for the main agent, ~2.7k for a subagent).
- `tools` are `{name, description, input_schema}`: 12 for the main agent, 8 for a subagent.
- In `messages`, content is a list of blocks:
  - Assistant: `thinking`, `text` and `tool_use` (`id`, `name`, `input`). The thinking text is
    empty (`display: "omitted"`); only a long `signature` comes back.
  - User: `text` and `tool_result` (`tool_use_id`, `content` as a string or a list of blocks,
    `is_error`).
- Harness-injected text:
  - In the first message, every block except the last is a `<system-reminder>…</system-reminder>`.
    There are 8–9 of them, with the environment, skills, agent types, the date and the account
    email.
  - Later reminders are **appended inside tool_result strings** after a blank line, or arrive as
    blocks of their own.
  - A background subagent's result reaches the main agent as a new user message holding
    `<task-notification>…</task-notification>`.
- The reply is an SSE stream:
  - `message_start` (model, usage).
  - For each block: `content_block_start`, then `content_block_delta`, then `content_block_stop`.
    The delta types are `thinking_delta` (with `estimated_tokens`), `signature_delta`,
    `text_delta` and `input_json_delta`.
  - `message_delta` (`stop_reason`, final usage including `output_tokens_details.thinking_tokens`),
    then `message_stop`.
  - `ping` and `error` events can also appear.
  - The `data:` JSON has random whitespace padding and extra fields: parse it leniently.
- Growth: request N+1 of a thread = request N's messages + the model's reply + one new user
  message. Only the `cache_control` markers move; system and tools stay identical. One reply can
  hold several tool calls. Their results come back together, in order, in one user message.
- Almost all input is cached: about 10 uncached tokens per request, the rest cache reads and writes.

## 5. Data model

- **Exchange**: one request and its reply.
  - id: 1, 2, 3… in arrival order.
  - state: `pending` → `streaming` → `done`, `error` or `aborted`.
  - times: start, first byte, end.
  - method, path, status, and the redacted request and response headers.
  - The raw request body (parsed JSON on demand), the raw reply text and the request size.
- **Reply**, assembled from the SSE events:
  - model, the blocks in order (text, thinking, and tool calls whose input is parsed from the
    joined `input_json_delta`), `stop_reason` and usage.
  - Usage = `message_start`'s, overwritten by `message_delta`'s non-null fields.
  - A JSON (non-stream) reply is used as is. Unknown events are kept for Raw and never crash the parser.
- **Tokens**: `in` = input + cache read + cache write; `cached` = cache read / `in`; `out` = output.
- **Session and thread**:
  - Session = `X-Claude-Code-Session-Id`, else the session id in `metadata.user_id`. Sessions are
    numbered S1, S2… in the order seen.
  - Thread = `x-claude-code-agent-id`, or `main` when that header is absent. Subagents are named
    `sub-1`, `sub-2`… per session, in the order seen.
  - A request without tools is `side`, a one-off thread.
  - Without these headers (another agent): one thread per distinct first user message.
- **Parent link**:
  - A subagent thread links to the `Agent` call that started it: the call's `input.prompt`
    equals the subagent's first prompt, and the call's result names the agent id.
  - A subagent thread's title is that call's `description`. A main thread's title is the first
    60 characters of the human's first prompt.
- **New in this request**:
  - prev = the latest earlier request of the thread whose messages are a prefix of this one's,
    compared without `cache_control`.
  - New = the messages after `len(prev.messages)`, minus the leading assistant message: that one
    is prev's reply, shown as "↳ reply of #N".
  - No prefix found: flag "history changed at message i" and show from there.
  - Same messages as an earlier request: flag "retry of #N".
- **Changes**: flag when the system text, the tool list, the model or `max_tokens` differ from prev.
- **Tool pair**:
  - Each `tool_use` is joined to the `tool_result` with the same id, in a later request of the
    same thread.
  - Until then it shows "waiting for result". If a later request of the thread lacks the result,
    it shows "no result" (amber).

## 6. Server API (UI port)

- `GET /` serves `index.html`, and `/app.js` and `/style.css` are served by name. Nothing else
  is read from disk. A request whose `Host` is not `localhost:<ui-port>` or
  `127.0.0.1:<ui-port>` gets 403 (DNS-rebinding guard).
- `GET /api/exchanges` returns all summaries: id, version, session, thread, state, status,
  method, path, times, tokens, stop reason, the two summary lines, the calls with their result
  state, and the flags.
- `GET /api/exchanges/<id>` returns the full detail:
  - the redacted headers and the parsed body;
  - the new-message range and the reply;
  - the tool results already paired with this exchange's calls, with the #id they came from;
  - the raw reply text.
- `GET /events` sends Server-Sent Events:
  - `exchange`: a full summary, sent on every change. The page upserts by id and keeps the
    higher `version`, so races between the list and the stream are harmless.
  - `reply`: the reply assembled so far for a streaming exchange, at most 4 times per second.
  - A comment line `: ping` every 15 s.
  - Each client has its own queue. The worker only enqueues and never blocks on a slow tab.
  - When a later request answers an exchange's calls, that exchange gets a new `exchange` event,
    and the page re-fetches its detail if it is open.
- On load and on every reconnect, the page fetches `/api/exchanges`, then follows `/events`.

## 7. The page

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ● live  8 req · in 176k (87% cached) · out 3.4k · 0 errors    (main)(sub-1)  ☐ errors only │
│                                              ☑ hide non-message  ☑ Follow live  ☑ Privacy │
├────────────────────────────────────────┬──────────────────────────────────────────────────┤
│ #12 18:45:12 (main)  ✓ 1.9s 27.2k/212  │ #12 · S2 main · claude-haiku-4-5 · 200 · 1.9s    │
│   ↑ HARNESS subagent result            │ in 27,202 (94% cached) · out 212 (151 thinking)  │
│   ↓ MODEL "The folder contains two…"   │ ▼ New in this request                            │
│ #11 18:45:02 (sub-1) ✓ 1.1s 14.1k/337  │ ▼ Reply                                          │
│   ↑ RESULT Read list.txt               │ ▶ Conversation (11 messages)                     │
│   ↓ MODEL "gamma"                      │ ▶ System instructions (3 blocks · 27,990 chars)  │
│ #10 …                                  │ ▶ Tools (12): Agent, Bash, Edit, Read, …         │
│                                        │ ▶ Raw                                            │
└────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

- **Top bar**:
  - Connection state (live or reconnecting).
  - Totals for what the filters show: requests, `in` with its cached share, `out`, and errors.
    Clicking the error count filters to errors.
  - Thread filter pills, "errors only", and "hide non-message requests" (on by default; it hides
    `HEAD` and the like).
  - The "Follow live" and "Privacy" toggles.
- **Timeline (left, about 40% of the width)**: one row per exchange, **newest first**, appearing
  as soon as the request arrives. A row shows #id, time, the thread pill, the state (a spinner
  and elapsed time while streaming), the duration, `in`/`out` tokens, and two lines of at most
  60 characters each:
  - `↑`, what the agent sent: `YOU "…"` if present, else the first `RESULT Tool arg` (+N), else
    `TASK "…"` or `HARNESS …`.
  - `↓`, what the model answered: the first `CALL Tool arg` (+N), else the first `MODEL "…"` line.
  - Non-message rows show only the method, path and status.
- **Detail (right)**: the selected exchange, in the sections below, in this order. Each section
  header shows a count or size and a toggle. Open or closed is remembered **per section name**,
  so it survives switching exchanges: an open Conversation with Follow live on is a live
  transcript.
  1. Summary: model, status, stop reason, timing (start, first byte, total), tokens (`in` split
     into input, cache read and cache write; `out` with its thinking part), the request size,
     the change flags, "retry of" and "history changed".
  2. **New in this request** (open): the new messages. Each tool result appears under a compact
     header of the call it answers (`CALL · Read notes.txt · from #6`).
  3. **Reply** (open): the model's text, its thinking, and its tool calls, each with its result
     joined directly underneath once it arrives (live).
  4. Conversation (closed): the whole thread up to this exchange, oldest first: every message of
     the request, then this reply.
     - Each message has a slim header (`AGENT → MODEL`, or `MODEL · #7 · tool_use`).
     - Model turns have a tinted background, and new messages are marked NEW.
  5. System instructions (closed): every block in full, with its size.
  6. Tool definitions (closed): the count and the names. Each one opens to its description and
     input schema.
  7. Raw (closed): the request headers and body, the response headers, and the raw SSE text.
- **Follow live**:
  - On: the newest exchange that passes the filters is selected automatically.
  - Clicking a row, or scrolling the timeline away from the top, turns it off. New rows then
    never move the selection or the scroll; a "N new ↑" chip appears instead.
  - Clicking the chip or the toggle turns it back on.
- Clicking a thread pill anywhere filters to that thread.

## 8. Message rendering

Each block is a card with a coloured left border, an icon, a text label (never colour alone) and
a `data-kind` attribute:

| data-kind | Label | Colour | Used for |
|---|---|---|---|
| `you` | YOU | #2563eb blue | the human's text (main threads only) |
| `task` | TASK | #4f46e5 indigo | a subagent's first prompt (written by the main agent), linked to its `Agent` call |
| `harness` | HARNESS | #6b7280 grey | injected text (tags below), collapsed to its first line |
| `model` | MODEL | #16a34a green | the model's text |
| `thinking` | THINKING | #94a3b8 slate | collapsed; when empty, a chip "thinking hidden · N tokens" |
| `call` | CALL · Tool | #d97706 amber | a tool call; its header shows the main argument |
| `result` | RESULT · Tool | #0d9488 teal | a tool result; red #dc2626 with **ERROR** when `is_error` |
| `system` | SYSTEM | #334155 slate | the system instructions |
| `other` | OTHER · type | #78716c stone | any other block, as JSON; base64 data shown as "[image/png, 230 KB]" |

- **Harness text**:
  - Harness tags: `system-reminder`, `task-notification`, `command-name`, `command-message`,
    `command-args`, `local-command-stdout`, `local-command-caveat`.
  - Text in user messages **and inside tool results** is split into segments: tagged spans are
    HARNESS; the rest stays YOU (or the tool's output).
  - A `<task-notification>` is labelled `HARNESS · subagent result` and links to the subagent's
    thread.
  - User text in `side` requests is HARNESS.
- **Main argument of a call**: the first present of `file_path`, `command`, `pattern`, `url`,
  `query`, `description` and `prompt`, cut to 80 characters.
- **Long text**: anything over 10 lines or 800 characters shows its first 6 lines (at most 500
  characters) and a "Show all (N lines, M chars)" button.
- **Fonts and markdown**:
  - Whitespace is preserved.
  - Tool output, JSON and code use a monospace font. The model's and the human's text use a
    proportional font, with ``` fenced spans in monospace.
  - Markdown is not rendered.
- **JSON** (tool inputs, schemas, raw bodies): `JSON.stringify(x, null, 2)` in a `<pre>`, with
  the long-text collapse.
- **Escaping**: all traffic content goes into the page as text (`textContent`), never as HTML.
- **Privacy toggle** (on by default, because the dashboard gets shown to the class): email
  addresses and the ids in `metadata.user_id` are masked on screen (`•••@•••`).
- **Thread pills** are outlined and use their own palette, never the kind colours: `main` is
  #111827, `sub-N` cycles through #9333ea, #db2777, #a16207 and #4d7c0f, and `side` is dashed grey.

## 9. Errors are easy to spot

- Red row: HTTP status ≥ 400, upstream unreachable, an SSE `error` event, or state `error`.
- Red dot on a row: its request carries a `tool_result` with `is_error: true` (that card is red).
- Amber: state `aborted`, `stop_reason: max_tokens`, or a call with "no result".
- The error count in the top bar filters to red rows and red dots.

## 10. Acceptance checks

Run every check with `/usr/bin/python3`. `tests/fake_upstream.py` (standard library only) mimics
the API:
- It answers `POST /v1/messages` with a canned SSE reply: thinking, text containing "é" and
  "🙂", and one tool call.
- It has switches to hold the stream open N seconds, to split events and UTF-8 characters across
  chunks, to return a 500, and to drop the connection.
- Point the monitor at it with `--upstream`.

1. **Byte-identical relay.** Through the fake upstream, the agent side receives the same reply
   bytes as through `proxy.py`, and the upstream receives the same request bytes. This holds
   even when events and UTF-8 characters are split across chunks.
2. **Shows up while streaming.** With the stream held for 5 s, `GET /api/exchanges` lists the
   exchange as `streaming` within 1 s, and its row shows on the page before the reply ends.
3. **No mixed replies.** Each exchange's assembled text equals the concatenated `text_delta`s of
   its own raw reply, also with two concurrent requests to the fake upstream.
4. **No credentials leak.** Send a request with `authorization`, `x-api-key` and `cookie` set to
   `SENTINEL`, and have the fake return `set-cookie: SENTINEL`. `SENTINEL` must not appear in the
   page, the API or the terminal, with or without `--verbose`.
5. **Escaping.** A body containing `<script>alert(1)</script>` and `<img src=x onerror=alert(2)>`
   displays literally in the row, the detail, Raw and the thread title, and nothing runs.
6. **Failures.**
   - Killing the client mid-stream ends the exchange as `aborted`, with no traceback, and the
     next request works.
   - With `--upstream http://127.0.0.1:9`, every attempt is a red 502 exchange (Claude Code
     retries).
7. **Follow live off.** A burst of 20 new exchanges changes neither the selection nor the
   scroll, and the chip shows "20 new".
8. **Performance.** With 200 exchanges whose late bodies are ~500 KB, opening one paints
   sections 1–3 in under 300 ms (measured with `performance.now()`). Closed sections render only
   when opened.
9. **Exit and host guard.** Ctrl-C exits within 1 s with two dashboard tabs open. A request to
   the UI port with `Host: evil.example` gets 403.
10. **Live: reading a file.** `ANTHROPIC_BASE_URL=http://localhost:8041 claude -p "Read notes.txt
    and tell me the secret word"` answers as it does through `proxy.py`. The page shows the
    system instructions in full, the `Read` call with its `file_path`, its result joined under
    it, and the answer, each with its `data-kind`.
11. **Live: a subagent.** A prompt that launches a background subagent (e.g. "launch one
    subagent that reads list.txt and returns its last line") shows threads `main` and `sub-1`.
    The sub thread's first message is TASK, and the main thread later shows
    `HARNESS · subagent result`.

## 11. Decisions taken while drafting

- **One program**, instead of `proxy.py` plus a reader of its output. That output interleaves
  concurrent streams (seen with a subagent: the replies came back in the opposite order, and no
  line names its request), so it cannot be parsed.
- **Threads come from Claude Code's headers** (session id, agent id), not from comparing
  prompts. The headers are exact, while comparing breaks on compaction and on the billing line,
  which varies per conversation.
- **Its own UI port (8042)**, rather than a reserved path on the proxy port.
- **SSE**, rather than WebSocket or polling.
- **Standard library and plain JS**, so a build runs anywhere with nothing to install.
- **Order**: the timeline is newest first; inside a conversation, oldest first.
- **Plain text**, not rendered markdown.
- **Privacy mask on by default.**

## 12. Later (not in the first build)

- The conversation transcript as its own view (hash routes `#/thread/…`).
- Search (server-side, over new messages and replies) and a filter by tool.
- A statistics panel: calls per tool, tokens over time, cache share.
- A cost estimate, which needs a price table with model-prefix rules.
- Foldable, syntax-coloured JSON, and copy buttons.
- The time spent running tools (the gap between a reply and the next request).
- `--save` / `--load` to JSONL.
- A dark theme.
- Codex (OpenAI format) traffic beyond the raw view.

## 13. Still open (to settle with my partner)

1. Is "Conversation + Follow live" enough to follow a conversation, or does the transcript view
   belong in the first build?
2. The collapse thresholds (10 lines or 800 characters, preview of 6 lines): tune them after
   seeing a build.
3. Should `side` requests and `HEAD` checks be hidden by default, or only dimmed?
4. Is a cost estimate worth it, and from which price table?
5. After which build do we stop regenerating and start editing the code?
