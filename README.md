# Lab 4: spec-build an agent traffic monitor

A live browser dashboard of the messages between Claude Code and the model, built again and
again by fresh agent sessions from `SPEC.md` alone. The spec improves after every build.

| Path | What |
|---|---|
| `SPEC.md` | The spec, improved and committed after every build (`git log -p SPEC.md`) |
| `spec-history.md` | One page: each spec commit, what changed and why |
| `notes.md` | The proxy check, findings in the traffic, the three-model experiment |
| `discussion.md` | Data-backed answers to the four discussion questions |
| `proxy.py` | The course proxy, unchanged |
| `builds/NN-name/` | One folder per build: the `SPEC.md` it was built from, `proxy.py`, the code, and `BUILD_NOTES.md` |

## Builds

| Build | How | Time |
|---|---|---|
| `01-home` | from scratch (Opus), the night before | ~55 min |
| `02a-opus`, `02b-sonnet` | from scratch, the same spec, in parallel | 19 / 11 min |
| `03-edit`, `03-scratch` | the same spec change: an edit of 02b against a rebuild | 3 / 10 min |
| `04-edit` | adds the system prompt explorer and Compare | 2 min |
| `05-edit` | handles `role: "system"` messages and `tool_addition` (newer models) | ~17 min (outage) |
| `06-edit` | real tool names on TOOL ADDED cards (the block's shape is now in the spec) | ~5 min |

## Run the latest build

```
cd builds/06-edit
python3 monitor.py                                  # proxy on :8041, dashboard on :8042
ANTHROPIC_BASE_URL=http://localhost:8041 claude     # another terminal: use the agent as usual
open http://localhost:8042
```

Things to try:
- Click **Stats** to see the caching saving.
- Look at the lanes while a subagent runs.
- Open **System instructions** for the prompt's sections.
- Run once with `--model claude-haiku-4-5` and once with `--model claude-opus-5-5`, then use
  **Compare with…** on the two first requests.

To compare two builds on the same traffic, chain them:
`python3 monitor.py --port 8051 --ui-port 8052 --upstream http://localhost:8061` in front of
another build on 8061.
