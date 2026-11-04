# Lab 4: spec-build an agent traffic monitor

| Path | What |
|---|---|
| `SPEC.md` | The spec: what gets improved and committed in every round of the loop |
| `proxy.py` | The course proxy, unchanged |
| `notes.md` | The proxy check, and findings in the traffic (for `spec-history.md` and the discussion) |
| `builds/NN-name/` | One folder per build: a copy of the `SPEC.md` it was built from, `proxy.py`, and the generated code |

## Run the latest build

```
cd builds/01-home
python3 monitor.py                                  # terminal 1: proxy on :8041, dashboard on :8042
ANTHROPIC_BASE_URL=http://localhost:8041 claude     # terminal 2: use the agent as usual
open http://localhost:8042                          # the dashboard
```

## The loop in the lab

1. Build: start a fresh agent session in a new empty folder, `builds/NN-what/`, holding only
   `SPEC.md` and `proxy.py`, and ask it to build the dashboard from scratch.
2. Run the build on live traffic and study the messages; add findings to `notes.md`.
3. Improve `SPEC.md` together and commit it, with a message saying what the last build showed.
4. Before the discussion, write `spec-history.md` with the prompt from the handout. Then both
   partners upload `SPEC.md` and `spec-history.md` to the Lab 4 report.
