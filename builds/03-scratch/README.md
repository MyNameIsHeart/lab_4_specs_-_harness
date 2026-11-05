# Live Agent Traffic Dashboard

Proxy, capture and dashboard in one program. Python 3.9+ standard library only.

    /usr/bin/python3 monitor.py [--port 8041] [--ui-port 8042] [--upstream URL] [--verbose]

Then run the agent through the proxy and open the dashboard:

    ANTHROPIC_BASE_URL=http://localhost:8041 claude
    open http://localhost:8042

Files: `monitor.py` (server), `static/index.html`, `static/app.js`, `static/style.css`. `proxy.py` is the unchanged reference.
