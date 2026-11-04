# Build notes (build 01)

## (a) Acceptance checks
All with `/usr/bin/python3` 3.9.6. No real browser was available: page checks ran app.js under
node in a minimal DOM shim against the live API (catches runtime errors, checks DOM/text, not paint).

1. **Byte-identical relay: pass.** Same request through `proxy.py` and the monitor to the fake
   (default, `split`, `split,hold=1`, and HEAD): reply bytes identical (headers minus Date), and the
   request bytes the fake recorded (`--record`) identical.
2. **Shows up while streaming: pass.** hold=5: `/api/exchanges` lists it as `streaming` after 0.06 s.
   Shim: at 1 s the row has a spinner and the Reply shows the partial text; done at 3.1 s.
3. **No mixed replies: pass.** Two concurrent `split` streams: each assembled text equals the joined
   `text_delta`s of its own raw reply, no U+FFFD.
4. **No credentials leak: pass.** SENTINEL in authorization/x-api-key/cookie, fake returns
   `set-cookie: SENTINEL` (the agent gets it): absent from the list, every detail, the `/events`
   bytes, the page files and the terminal, with and without `--verbose`.
5. **Escaping: pass (shim + by construction).** No innerHTML/outerHTML/insertAdjacentHTML in app.js;
   the strings show literally in row, detail, Raw and thread title; 0 script/img elements; CSP
   `script-src 'self'`. Live: xss.txt quoted literally in the row and the cards.
6. **Failures: pass.** Client killed mid-stream: `aborted` (amber), no traceback, next request 200.
   `--upstream http://127.0.0.1:9`: 3 attempts, 3 red 502 `error` exchanges. Also: 500 (red),
   drop after headers (`error`, red), SSE `error` event (red), `max_tokens` (amber).
7. **Follow live off: pass (shim).** Click a row, scroll, burst of 20: selection unchanged, the rows
   in view stay in place, chip "20 new ↑"; the chip turns follow back on (newest, top).
8. **Performance: pass (server + shim, no real paint).** 200 exchanges, last body 649 KB: detail API
   5.6 ms; sections 1–3 rendered 27–60 ms after the click (`window.__lastOpenMs`, also shown as
   "opened in N ms" in the detail header); closed sections hold 0 nodes until opened.
9. **Exit and host guard: pass.** SIGINT with two `/events` tabs and a held stream: exit in 0.01 s.
   `Host: evil.example` (and `evil.example:8052`) gets 403.
10. **Live, reading a file: pass.** Answer "The secret word is **pomegranate**." Shim on the capture:
    3 SYSTEM cards in full (74/62/27,853 chars), CALL · Read with its file_path, RESULT · Read joined
    under it, the MODEL answer, all with data-kind. Not re-run through proxy.py (4-run budget);
    relay equivalence rests on check 1.
11. **Live, a subagent: pass.** Run 1: the model chose a foreground subagent: main + sub-1, TASK
    linked to the Agent call, but no task-notification. Run 2 (explicit `run_in_background`): main
    + sub-1, TASK first, and main later shows HARNESS · subagent result linked to sub-1. The row said
    "HARNESS system-reminder" at first (the notification comes wrapped in a reminder); fixed and
    re-verified by replaying the captured traffic through the worker.

## (b) Decisions the spec left open
- The id is taken under a lock in the relay thread; the record is built by the worker from the queued
  `req` event (relay threads never touch the store).
- A completed HTTP error (500 + JSON body) is `done` with its status (red by status); `error` means a
  network failure. Failing after the request was sent but before headers also gets a 502.
- Upstream drop after headers = IncompleteRead or missing Content-Length bytes; the agent socket is shut.
- Message request = POST to path `/v1/messages` (query ignored) with a `messages` list; count_tokens,
  HEAD etc. are non-message (hidden by default). No tools → `side`, even with an agent-id header; one
  `side` pill per session; no prefix/retry/pairing for side.
- No Claude Code headers: threads `main`, `main-2`… per session by first user message. Session =
  header, else `metadata.user_id` (JSON or legacy `…_session_<uuid>`), else none (HEAD /api/hello).
- Retry inherits the retried request's new range. History changed: vs the latest earlier request of
  the thread, new range from the first differing message.
- "No result" only once the call's exchange is finished and a later request of the thread lacks it;
  a later result clears it.
- Parent link: exact prompt match, then containment (≥20 chars), then `agentId: …` in the Agent
  result (either order). Any harness span containing `<task-notification>` (it comes inside a
  `<system-reminder>`) is HARNESS · subagent result, linked by the agent id in it.
- Row lines: label + text ≤ 60 chars; file paths keep their end; main argument ≤ 80 chars.
- Terminal: start time, path without query, `S2:main` only with >1 session; `ABORTED` / `ERROR msg`.
- Privacy: e-mails → `•••@•••`, metadata ids → `•••`, on screen only (the API serves bodies unmasked,
  headers redacted). The e-mail regex needs no TLD, so cut-off addresses are masked too.
- System blocks shown in full (spec: "in full"), no collapse. Harness text and non-empty thinking
  fold to their first line with "Show all"; other long text uses the 6-line preview.
- Follow off: rows inserted above keep the visible rows in place (scrollTop compensated). Scrolling
  back to the top does not turn follow on; only the chip or the toggle do.
- Summary section open by default; section states persist per name (localStorage).
- Extra SSE event `hello` with a boot id: a restarted monitor clears the page. A tab whose queue
  overflows (20,000 events) is dropped and reconnects.
- Ctrl-C: an explicit SIGINT handler (works even when started with SIGINT ignored), then `os._exit`.
- Reply snapshots replace thinking signatures by their length. Error count = red rows + red dots
  among the filtered rows; clicking it toggles "errors only".

## (c) Known issues
- Not seen in a real browser: layout, colours, scrolling and paint times are unverified.
- An abort is noticed at the next upstream chunk; a silent upstream keeps the thread until then.
- Request bodies sent chunked (no Content-Length) are not read, as in proxy.py.
- The Reply section re-renders on each live update: an expanded "Show all" in it closes while streaming.
- `thinking_delta.estimated_tokens` semantics unknown: the maximum seen is shown.
- After `/clear` the main thread keeps its first title; the next request is flagged "history changed at message 0".
