# Build 03-scratch notes

Start 11:31, end 11:41 (about 10 minutes).

## First-build checks (no browser; page checked via curl, node --check, a stubbed-DOM node run)
- F1 fresh page: NOT RUN in a browser. Logic: on hello the page fetches the list, Follow live selects the newest visible exchange (HEAD is hidden).
- F2 escaping: PARTIAL. The live run read xss.txt; all traffic text goes through textContent/text nodes (no innerHTML anywhere). Not seen in a browser.
- F3 failures/leaks: PASS. --upstream 127.0.0.1:9 gave 502 and an `error` exchange; SENTINEL absent from page, API and terminal; Host evil.example gave 403; SIGINT exit in 0.01 s with an SSE tab open.
- F4 lanes/anatomy: PARTIAL. Live subagent run: API shows main and sub-1, tool_time values, anatomy parts summing to total (asserted in script). Lanes drawing only run in a stubbed DOM.
- F5 stats: PARTIAL. Stats panel sums the same summaries as the top bar; ran without error in the stubbed DOM. Saving % uses 0.1/1.25/2 weights.
- F6 only real errors red: PASS at API level (one live run with missing.txt: exactly 1 exchange has red_dot, none red). The top-bar "1 error" text is not seen in a browser.
- 10 live read: PASS at API level (system 3 blocks, Read call with file_path, result paired, answer).
- 11 live subagent: PASS at API level (main + sub-1; sub first message is `task`; main #8 holds `HARNESS · subagent result`; sub-1 title from the Agent call).
- Checks 1-9: not run (as instructed). 2 live runs used.

## Decisions the spec left open
- Backend (monitor.py) classifies blocks (you/task/harness/...) and sends them normalised; the page only renders.
- Streaming starts at the response headers; first byte is the first chunk.
- Anatomy chars: text length; tool_use = name + JSON input; thinking = text + signature; the leading assistant message (prev's reply) counts as `earlier`.
- Non-first text in a sub thread, and all user text in `side`, is HARNESS. Anonymous (no header) threads are named main / t-N.
- Non-message rows get thread `-`. Thread pills filter by name across sessions.
- Row arg is the file name only; tooltip holds the full path. Thinking-only reply shows "THINKING (hidden)".
- Scroll: no manual compensation when Follow is off; native scroll anchoring applies.
- Privacy masks emails, UUIDs and 64-hex ids in text on screen.

## Known issues
- Page never opened in a real browser: layout, spinner timer, lanes geometry untested.
- Detail is re-fetched on every state change; whole detail re-renders 4x/s while streaming (fine locally).
- Gap labels in lanes can overlap on tiny gaps.
- Stats "current session" is the selected exchange's session.
