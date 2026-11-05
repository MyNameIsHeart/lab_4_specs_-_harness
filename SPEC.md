# SPEC: Live Agent Traffic Dashboard

## 1. Goal

While the course proxy runs, I open one page in the browser. It updates live and shows every
message between my coding agent (Claude Code) and the model. Readability is the point: while the
agent works, messages pile up fast, and I must tell them apart at a glance (my prompt, the
model's text, a tool call, its result, text the harness injected), follow the conversation as it
grows, and open any message in full.

The first build covers sections 2–10. Section 12 lists what comes later. A build is one fresh
agent session of about 20 minutes: get the core working first, then run the first-build checks
of section 10. The full checks wait until we switch from rebuilding to editing the code.

## 2. How it runs

- Files: `monitor.py` (proxy, capture and dashboard server), `static/index.html`,
  `static/app.js`, `static/style.css` and a short `README.md` with the commands. `proxy.py`
  stays unchanged, as the reference. `tests/fake_upstream.py` comes with the full checks
  (section 10), not in a first build.
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
- **Newer models get a different message format.** With Opus 5.5 and Fable 5.1, `messages` also
  holds messages with `role: "system"`. They carry the environment, and announce newly
  available tools as `tool_addition` blocks (a tool definition added mid-conversation). Haiku
  4.5 gets the same information as `<system-reminder>` text in user messages.
- When the agent waits with `ScheduleWakeup`, the harness later sends that call's `prompt` back
  as a plain user text block, which the human never typed.
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
  - state: `pending` → `streaming` → `done`, `error` or `aborted`. A complete reply with HTTP
    status ≥ 400 is `done` (red because of its status); `error` means a network failure or a
    broken stream.
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
  - A request without tools is `side`, a one-off thread, even when it carries an agent id.
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
- **Anatomy** of a message request, computed once, in characters of the parsed body. The
  five parts add up to the request's content size:
  - `system`: the system text;
  - `tools`: the tool definitions, as compact JSON, plus any `tool_addition` blocks;
  - `harness`: every harness segment in the messages, including those inside tool results and
    the text of `role: "system"` messages;
  - `earlier`: the rest of the conversation before the new messages;
  - `new`: the new messages, without their harness text.
- **Your words**: the characters of YOU segments in this request, and their share of the whole.
- **Prompt sections**: each system block is split at its lines that start with `#`. Text before
  the first heading is a section called "(preamble)". A section is its heading, its text and
  its size; the sizes add up to the block's size.
- **Tool time**: for a request after the first of its thread, the gap between the end of the
  previous reply and this request's start. That is the time the harness spent running tools
  (or waiting for a subagent).
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
  - `hello`: sent first on every connection, with a boot id. When the boot id changes (the
    monitor restarted), the page clears itself and fetches the list again.
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
  - The "Follow live" and "Privacy" toggles, and a "Stats" button.
- **Lanes** (a strip under the top bar, collapsible, open by default) give a time axis for the
  current session:
  - There is one lane per thread (`main`, `sub-1`, `side`…).
  - Each exchange is a bar from its start to its end, with a tick at the first byte, coloured by
    state.
  - The gap before the next bar in a lane is labelled with its tool time (`⚙ 1.2s`).
  - Concurrent threads show as overlapping bars.
  - Clicking a bar opens the exchange. The axis rescales as the session grows.
- **Anatomy bar**: a thin stacked bar under every message row, and a larger one with a legend
  and numbers in the Summary.
  - Its five segments: system #334155, tools #b45309, harness #9ca3af, earlier #cbd5e1, new #2563eb.
  - The Summary also states "your words: 43 chars of 89,768 (0.05%)".
- **Stats panel** (from the "Stats" button), for the current session and filters:
  - Requests, and input tokens split into uncached, cache write and cache read.
  - Output tokens with their thinking part, and the cache-hit share.
  - **Input cost saved by caching**, as a percentage. This needs no prices: a cache read costs
    0.1× the base input price, and a cache write 1.25× (5-minute) or 2× (1-hour).
  - Calls per tool as a bar list, errors, and total tool time against total model time.
- **System prompt explorer**, the default view of the System instructions section:
  - One row per prompt section: its heading, its size, and a bar for its share of the block.
  - Clicking a row shows that section's text.
  - The full text of each block stays one click away.
- **Compare**: a "Compare with…" button on every message exchange. Picking a second exchange
  (by clicking its row, or by typing its #id) opens a side-by-side view of the two requests:
  - Their model, anatomy bars and numbers (system, tools, harness, earlier, new, tokens).
  - Their prompt sections matched by heading: in both (with both sizes and the difference),
    only in A, or only in B.
  - A line diff of the two system prompts: added lines green, removed lines red, unchanged runs
    folded to "… N unchanged lines".
  - The tool lists: tools only in A, tools only in B, and size changes of tools in both.
  - Typical use: the first request of a Haiku session against the first request of an Opus
    session, to see what the harness cut for the newer model.
- **Timeline (left, about 40% of the width)**: one row per exchange, **newest first**, appearing
  as soon as the request arrives. A row shows #id, time, the thread pill, the state (a spinner
  and elapsed time while streaming), the duration, `in`/`out` tokens, and two lines of at most
  60 characters each:
  - `↑`, what the agent sent: `YOU "…"` if present, else the first `RESULT Tool arg` (+N), else
    `TASK "…"` or `HARNESS …`.
  - `↓`, what the model answered: the first `CALL Tool arg` (+N), else the first `MODEL "…"` line.
  - Non-message rows show only the method, path and status.
  - File paths show as the file name only (`RESULT Read notes.txt`). The full path is in the
    row's tooltip and in the detail.
- **Detail (right)**: the selected exchange, in the sections below, in this order. Each section
  header shows a count or size and a toggle. Open or closed is remembered **per section name**
  (also across reloads, in localStorage), so it survives switching exchanges: an open Conversation with Follow live on is a live
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
  - On: the newest exchange that passes the filters is selected and opened automatically. This
    holds on a fresh page too: the first exchange that arrives opens by itself.
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
| `tooladd` | TOOL ADDED · Tool | #b45309 ochre | a tool definition added mid-conversation (`tool_addition`): its name, with its description and schema collapsed |
| `other` | OTHER · type | #78716c stone | any other block, as JSON; base64 data shown as "[image/png, 230 KB]" |

- **Harness text**:
  - Harness tags: `system-reminder`, `task-notification`, `command-name`, `command-message`,
    `command-args`, `local-command-stdout`, `local-command-caveat`.
  - Text in user messages **and inside tool results** is split into segments: tagged spans are
    HARNESS; the rest stays YOU (or the tool's output).
  - A `<task-notification>` (it usually arrives inside a `<system-reminder>`) is labelled
    `HARNESS · subagent result` and links to the subagent's thread.
  - User text in `side` requests is HARNESS.
  - Every text block of a `role: "system"` message is HARNESS, labelled `HARNESS · system
    message`. YOU only ever comes from `role: "user"` messages.
  - A user text block equal to the `prompt` of an earlier `ScheduleWakeup` call of the thread
    is `HARNESS · scheduled wakeup`.
- **Main argument of a call**: the first present of `file_path`, `command`, `pattern`, `url`,
  `query`, `description` and `prompt`, cut to 80 characters.
- **Long text**: anything over 10 lines or 800 characters shows its first 6 lines (at most 500
  characters) and a "Show all (N lines, M chars)" button.
- **Fonts and markdown**:
  - Whitespace is preserved.
  - Tool output, JSON and code use a monospace font. The model's and the human's text use a
    proportional font.
  - Model text gets minimal markdown, built from DOM nodes (never `innerHTML`): `**bold**`,
    `` `inline code` ``, ``` fenced blocks ``` (monospace on a tinted background) and `#`
    headings (bold lines). Everything else shows as typed.
- **Expanded stays expanded**: the open or closed state of every block survives live
  re-renders (keyed by exchange id and block position). A "Show all" opened in a streaming
  reply stays open.
- **JSON** (tool inputs, schemas, raw bodies): `JSON.stringify(x, null, 2)` in a `<pre>`, with
  the long-text collapse.
- **Escaping**: all traffic content goes into the page as text (`textContent`), never as HTML.
- **Hidden means hidden**: the stylesheet starts with `[hidden] { display: none !important; }`,
  so a class rule such as `display: inline-block` can never show an element that the code has
  hidden.
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

**First-build checks.** Every build from scratch runs these, with no fake upstream: checks 10
and 11 at the end of this section, and:

- F1. **Fresh page.** With the page open and empty and Follow live on, the first message
  exchange opens by itself within 1 s of arriving.
- F2. **Escaping, live.** The agent reads a file holding `<script>alert(1)</script>` and
  `<img src=x onerror=alert(2)>`. Both show literally in the row and the detail, and nothing runs.
- F3. **Quick failures and leaks.**
  - With `--upstream http://127.0.0.1:9`, a `curl` POST whose `authorization`, `x-api-key` and
    `cookie` are `SENTINEL` gets a 502 and shows as a red exchange.
  - `SENTINEL` appears nowhere in the page, the API or the terminal.
  - `Host: evil.example` on the UI port gets 403.
  - Ctrl-C exits within 1 s.

- F4. **Lanes and anatomy.**
  - After a live run with a background subagent, the lanes show `main` and `sub-1` overlapping
    in time, with a tool-time label between main's bars.
  - Every message row has an anatomy bar, and the Summary's five numbers add up to the
    request's content size.
- F5. **Stats.** The stats panel's token totals equal the sum over the session's rows, and the
  caching saving shows as a percentage.
- F6. **Only real errors are red.** In a live run where exactly one tool call fails (reading a
  missing file), exactly one row has the red dot and the top bar says "1 error".
- F7. **Explorer and compare.**
  - The System section of a Claude Code request lists the prompt's sections, and their sizes
    add up to the block's size.
  - Comparing a `--model claude-haiku-4-5` first request with a `--model claude-opus-5-5`
    first request shows the size difference per section, the tool-list changes, and a line
    diff with unchanged lines folded.
- F8. **Harness, not you.**
  - In a live `--model claude-opus-5-5` run, the environment arrives in a `role: "system"`
    message and shows as `HARNESS · system message`, never as YOU.
  - Tools announced mid-conversation show as TOOL ADDED cards.
  - "Your words" counts only the typed prompt.
  - In a run where the agent waits with `ScheduleWakeup`, the prompt the harness sends back
    shows as `HARNESS · scheduled wakeup`.

**Full checks 1–9** come when we switch to editing the code. They need the fake upstream.

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
- **After build 01** (the home build: about 55 minutes, all checks passing):
  - A build from scratch must fit the lab loop, so first builds skip the fake upstream and run
    only the first-build checks.
  - Rows show file names instead of long paths, and model text gets minimal markdown.
  - The choices build 01 had to make on its own are now written down: HTTP errors, `side`, the
    `hello` event, and saved section state.
- **After build 02** (two fresh builds of the same spec, run in parallel):
  - Sonnet finished in 11 minutes and worked on live traffic. Opus had written no files after
    18 minutes.
  - A real browser showed what a builder without one cannot see: in build 02b the red error dot
    appeared on every row, because the build's CSS overrode the `hidden` attribute. The spec now
    makes `[hidden]` win, with a check (F6).
  - With a fast, working core, the next version adds views that show where the bytes and the
    time go: the anatomy bar, lanes and stats. They come from what we found in the traffic: the
    harness's scaffolding dwarfs the human's words and differs by model, caching carries the
    cost, and subagents run in parallel.
- **After builds 03 and 04** (we switched to editing at build 03: 3 minutes against 10 for the
  same spec from scratch):
  - Traffic from one model is not enough. Opus 5.5 traffic has a different message format:
    `role: "system"` messages and `tool_addition` blocks.
  - Every build labelled the Opus environment (26K characters) as "your words". A
    `ScheduleWakeup` prompt the harness sent back was also labelled YOU.
  - The spec now names these cases (check F8).

## 12. Later (not in the first build)

- The conversation transcript as its own view (hash routes `#/thread/…`).
- Search (server-side, over new messages and replies) and a filter by tool.
- A cost estimate in dollars, which needs a price table with model-prefix rules.
- Foldable, syntax-coloured JSON, and copy buttons.
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
