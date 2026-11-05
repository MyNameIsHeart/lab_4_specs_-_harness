# Live Agent Traffic Dashboard

Python 3.9+ standard library only.

    /usr/bin/python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]
    ANTHROPIC_BASE_URL=http://localhost:8041 claude      # in another terminal
    open http://localhost:8042                           # the dashboard

Files: `monitor.py` (proxy, capture, dashboard server), `static/` (page), `proxy.py` (reference, unchanged).
