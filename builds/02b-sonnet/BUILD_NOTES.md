# Build notes (02b-sonnet)

Start 11:18, end 11:29. No browser: the page was never opened (only fetched, `node --check`, code reading).

## First-build checks
- F1 fresh page: NOT RUN in a browser. Code path read: on `exchange` event, `upsert` -> new row passes filters and
  Follow is on -> `select()` -> fetch detail -> render. List fetched on `hello` too (`loadList` -> `selectNewest`).
- F2 escaping live: PARTIAL. Live run "Read xss.txt and quote it" worked; API holds the literal text
  (`onerror=alert(2)`). All DOM text uses `textContent`/text nodes (grep: no innerHTML/eval). Page not seen.
- F3: PASS (curl). `--upstream http://127.0.0.1:9` POST gets 502, exchange `error`/red; SENTINEL absent from
  page, /api/exchanges, detail and terminal; `Host: evil.example` -> 403; SIGINT with 2 SSE clients exits <0.5 s.
- 10 live read: PASS on API level (answer "pomegranate"; system 3 blocks, 12 tools, Read call with file_path,
  result paired to call with `from` id). Rendering/data-kinds not seen in a browser.
- 11 live subagent: PASS on API level. Threads main + sub-1, sub-1's first message TASK ("TASK ..." row line),
  parent link to the Agent call (#8) found, title from call description, #13 up-line is
  "HARNESS subagent result" (fixed after the run; not re-run), agent id in summary for the notification link.

## Decisions the spec left open
- Exchange is created in the relay thread (id under lock); the worker publishes it right after (queue).
- `hello` event carries `{"boot": id}`; the page fetches the list on every `hello`.
- Non-message = anything but `POST .../v1/messages` with a JSON object body; a failed one stays visible if red.
- A message request without tools is `side` (thread name `side`, one thread per request); its text is HARNESS.
- No session/agent headers: session label S? treated as one session, threads by first-message hash (`main`, `t2`...).
- Plain text in sub threads is TASK in every message; in main threads YOU.
- Row text: server builds the 60-char lines (file name only), tooltip has full paths.
- Streaming: `exchange` + `reply` events at most every 250 ms per exchange; detail re-fetched (150 ms debounce) on change.
- "no result" shown once any later request exists in the thread and the call has no result (amber).
- Red dot only for is_error results in the NEW range of that request.
- Retry: identical message list as an earlier request of the thread; reuses that request's new range.
- Thinking tokens chip: usage `output_tokens_details.thinking_tokens`, else summed `estimated_tokens`.
- Section open state in localStorage (`dash.sections`), per name; block state in memory per exchange+position.
- Privacy masks emails everywhere and the values of `metadata.user_id` in Raw.
- Subagent result link: finds the sub thread whose agent id occurs in the notification text.
- Eviction: oldest finished exchanges lose bodies/results above 300 MB (not tested).
- Install of SIGINT default handler so Ctrl-C works even when started as a background job.

## Known issues
- Never opened in a browser: layout, CSS (`color-mix`), scroll compensation, spinner untested.
- Checks 1-9 not run (out of scope); chunk-split UTF-8/SSE logic untested beyond the live stream.
- `side` requests with an agent id: thread name `side`, so they cannot be told from the main thread's side calls.
- Large conversations re-render the whole detail on every change (Conversation section only if open).
- Chunked request bodies from the agent are not supported (Content-Length only).
