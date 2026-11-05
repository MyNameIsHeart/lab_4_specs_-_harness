# Build 02a (Opus): notes

Start 11:18, end 11:37 (about 19 minutes). Ports used: 8051–8054. No browser was available.

## First-build checks
- **F1 Fresh page: pass, by reading the code only.** The worker publishes `exchange` as soon as it has parsed the request. Then `upsert` → `onArrival` → `select(id)` (Follow live on, row passes the filters) → `fetchDetail`. `HEAD` is filtered out, so the first POST opens. Still needs a browser check.
- **F2 Escaping, live: pass, from the API and the code.** The xss.txt markup arrives as plain text in RESULT, MODEL and the row tooltip. app.js has no innerHTML or eval: all text goes in through textContent, text nodes or `title`. A CSP header also blocks inline script. Still needs a browser check.
- **F3 Quick failures and leaks: pass.**
  - curl POST to `--upstream http://127.0.0.1:9` → 502; the exchange is red (state `error`, status 502).
  - `SENTINEL` count 0, with and without `--verbose`, in: the terminal, `/api/exchanges`, `/api/exchanges/1`, `/events`, the 3 page files. Headers show `[redacted]`.
  - `Host: evil.example` → 403 on `/`, `/api/exchanges` and `/events`. SIGINT exits in 0.08 s with 2 `/events` streams open.
- **Check 10 (read a file): pass, from the API.** The agent answered "pomegranate".
  - #2: 3 system blocks (74, 62, 27,853 chars), 12 tools, `Read` with its `file_path`; the result is paired from #3, whose reply is the answer.
  - The `data-kind` values were checked by reading the code.
- **Check 11 (subagent): pass, from the API.** Threads: S1 `main` and `sub-1`.
  - sub-1's first ↑ line is `TASK "Read the file list.txt…"`, linked to the Agent call in #2 and titled with its description.
  - Main #7's ↑ line is `HARNESS subagent result`.
- Checks 1–9: not run, as the scope says (no fake upstream).

## Decisions the spec left open
- **Exchange creation:** the relay thread creates the bare record (redacted headers, raw body) under the lock before connecting; the worker does all parsing.
- **Terminal line:** the start time and the path without its query. A non-message request shows `-` as its thread.
- **Upstream failures:** a failure before the headers records status 502. An SSE stream (status < 400) that ends without `message_stop` gets state `error`.
- **Retry:** copies the original's new-message range and gets the flag "retry of #N".
- **History changed:** compared with the thread's latest earlier request; the new range starts at the first message that differs.
- **Red dot:** only from an `is_error` result among this request's *new* messages.
- **No result:** set when a later request of the thread lacks the result of a call whose exchange had already finished.
- **Sessions:** the header, else `metadata.user_id`'s session_id, else one "(no session)" session. A non-message request gets a session only if it carries the header.
- **Threads without Claude Code headers:** `main`, `main-2`… per distinct first user text.
- **Side requests:** one-off threads that share the `side` pill of their session.
- **User text kind:** TASK in every message of a sub thread, HARNESS in side requests, YOU otherwise.
- **Parent link:** prompt equal, or contained in the first prompt if it is over 20 chars. Fallback: the Agent result contains the agent id.
- **Privacy mask (screen only):** emails show as `•••@•••`, the `metadata.user_id` ids as `•••`. Each summary carries its `ids` so the page can mask them.
- **System instructions:** shown in full, without "Show all", since the section is closed by default.
- **Reply with only thinking:** its ↓ line reads `THINKING only, no text (stop …)`.
- **Dashboard headers:** a CSP and `Cache-Control: no-store` on every response.
- **Slow tabs:** an SSE client with over 5000 queued events is dropped; the page reconnects and refetches the list.
- **Throttling:** `reply` events and live `exchange` summaries at most 4 times per second; state changes go out at once.
- **Ctrl-C:** explicit SIGINT and SIGTERM handlers (a background shell ignores SIGINT), then `os._exit(0)` so open streams cannot delay the exit.
- **Saved state:** a block's open or "Show all" state is kept in memory per exchange and position; section state is saved in localStorage.
- **Detail scroll and pills:** the detail goes back to the top when you switch exchanges and keeps its place on live re-renders. Pills show the session (`S2 main`) only once more than one session has been seen.
- **Call arguments:** card headers cut at 80 characters, rows and compact headers show the file name, tooltips the full path.

## Known issues
- **Not seen in a browser:** layout, F1 timing, follow and scroll, and the chip were checked only by reading the code.
- **F2 in the row:** the ↓ line shows only the first line of the model's text. In this run the markup was not on that line, so it showed in the row's tooltip and the detail, not in the row itself.
- **Full checks not run:** the byte-identical relay with split chunks, concurrency and performance (200 × 500 KB) are untested.
- **Slow Conversation:** an open Conversation re-renders completely on each final update, which can be slow for long threads.
- **Chunked request bodies** are not supported (same as proxy.py).
