# Live agent traffic dashboard

`monitor.py` relays Claude Code's API traffic like `proxy.py` does, captures every exchange,
and serves a page that shows the conversation live. Python 3.9+ standard library only; the page
is plain JS and CSS.

## Run

```sh
python3 monitor.py                    # proxy on :8041, dashboard on :8042
ANTHROPIC_BASE_URL=http://localhost:8041 claude
open http://localhost:8042
```

Options: `--port 8041` (proxy), `--ui-port 8042` (dashboard), `--upstream URL` (default
`https://api.anthropic.com`), `--verbose` (also print `proxy.py`'s full dump, headers redacted).
Both servers listen on 127.0.0.1 only. Ctrl-C stops it. The terminal prints one line per
finished exchange:

```
18:45:12 #12 main POST /v1/messages 200 1.9s in 27.2k (94% cached) out 212
```

## The page

- Left: one row per exchange, newest first: `↑` what the agent sent, `↓` what the model answered.
  Red rows are errors, a red dot marks a request carrying a failed tool result, amber marks
  aborted streams, `max_tokens` stops and calls that never got a result.
- Right: the selected exchange: Summary, New in this request, Reply (tool results join their
  call as they arrive), Conversation, System instructions, Tools, Raw. Open sections stay open
  when you switch exchanges.
- Follow live selects the newest exchange. Clicking a row or scrolling the list turns it off;
  new rows then show up as an "N new ↑" chip instead.
- Thread pills (`main`, `sub-1`, `side`) filter the list; the error count filters to errors.
- Privacy (on by default) masks e-mail addresses and the ids of `metadata.user_id`.

## API (dashboard port)

`GET /api/exchanges` (all summaries), `GET /api/exchanges/<id>` (full detail),
`GET /events` (Server-Sent Events: `hello`, `exchange`, `reply`, `: ping`).
Requests whose `Host` is not `localhost:<ui-port>` or `127.0.0.1:<ui-port>` get 403.

## Tests

`tests/fake_upstream.py` mimics the API (canned SSE reply with thinking, text with "é" and "🙂",
one tool call). Switches go on the command line (`--defaults hold=5,split`) or per request in an
`x-fake` header: `hold=N`, `split`, `500`, `drop`, `cookie`, `error`, `max_tokens`, `json`,
`agent`, `tool`, `notool`. `--record DIR` saves each raw request.

```sh
python3 tests/fake_upstream.py --port 8059 &
python3 monitor.py --upstream http://127.0.0.1:8059
curl -N -H 'x-fake: hold=5,split' -d '{"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"Read"}]}' \
     http://localhost:8041/v1/messages
```
