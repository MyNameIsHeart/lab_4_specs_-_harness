# Live agent traffic dashboard

`monitor.py` is the course proxy (`proxy.py`, kept unchanged as the reference) plus a live page
that shows every message between Claude Code and the model. Standard library only.

```sh
/usr/bin/python3 monitor.py                      # proxy :8041, dashboard :8042
ANTHROPIC_BASE_URL=http://localhost:8041 claude  # in another terminal
open http://localhost:8042                       # the dashboard
```

Options: `--port 8041` (proxy), `--ui-port 8042` (dashboard), `--upstream URL` (default
`https://api.anthropic.com`), `--verbose` (adds proxy.py's full dump, credentials redacted).
Both servers listen on 127.0.0.1 only. Ctrl-C stops everything.

The terminal prints one line per finished exchange:

```
18:45:12 #12 main POST /v1/messages 200 1.9s in 27.2k (94% cached) out 212
```

Files: `monitor.py` (relay, capture worker, dashboard server), `static/index.html`,
`static/app.js`, `static/style.css`. API on the dashboard port: `GET /api/exchanges`,
`GET /api/exchanges/<id>`, `GET /events` (Server-Sent Events).

Quick checks:

```sh
# a failing upstream gives a red 502 exchange, and credentials never show up
/usr/bin/python3 monitor.py --port 8051 --ui-port 8052 --upstream http://127.0.0.1:9
curl -s -X POST localhost:8051/v1/messages -H 'authorization: SENTINEL' \
     -H 'x-api-key: SENTINEL' -H 'cookie: SENTINEL' -d '{"messages":[]}'
curl -s localhost:8052/api/exchanges | grep -c SENTINEL          # 0
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' localhost:8052/   # 403
```
