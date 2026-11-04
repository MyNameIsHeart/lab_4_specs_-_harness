# Lab 4 notes

## Proxy check (4 Nov, Claude Code 2.1.312)

```
python3 proxy.py --port 8041                      # terminal 1
ANTHROPIC_BASE_URL=http://localhost:8041 claude   # terminal 2
```

I asked the agent to read a small file (`notes.txt`) and tell me the secret word. In the proxy's
output:

- **System instructions** are in the first `POST /v1/messages?beta=true`, in the `system` array.
  The proxy prints it after `messages`, because it keeps the body's key order. It has 3 text
  blocks: a billing line, "You are a Claude agent, built on Anthropic's Claude Agent SDK.", and
  the main prompt (27,854 characters). More instructions arrive as 8 `<system-reminder>` blocks
  at the start of the first user message; the prompt I typed is the last block.
- **The tool call** is in the first reply's SSE stream: a `content_block_start` with a `tool_use`
  block named `Read` and an id `toolu_…`. Its input streams as `input_json_delta` fragments that
  join to `{"file_path": ".../notes.txt"}`. The reply ends with `stop_reason: tool_use`.
- **Its result** is in the second request. The assistant's `tool_use` is echoed back, followed by
  a user message with a `tool_result` that has the same id in `tool_use_id`. Its content is the
  file's numbered lines, with a `<system-reminder>` appended.

## Findings in the traffic

These come from two `claude -p` runs: one read a file; the other did Glob, Read and Bash, then
launched one background subagent.

- **Every request re-sends everything**: 90–110 KB per request for the main agent. Tool
  definitions are about half (12 tools, 45 KB) and the system prompt about a quarter.
- **Caching makes that cheap.** Only 8–10 input tokens per request are uncached. 87% of the
  second run's input tokens were cache reads, and `cache_read(N+1) = cache_read(N) +
  cache_creation(N)` held exactly.
- **Thinking is hidden** (`display: "omitted"`). Only an opaque signature (512–6,900
  characters) comes back, and it is re-sent in every later request. Thinking was 1,178 of the
  1,299 output tokens in one reply.
- **The system prompt's largest section** is the auto-memory instructions, about 46% of it. The
  first user message adds 14–17K characters of reminders: environment, skills, agent types, the
  date, git attribution, and the account email.
- **Reminders hide inside tool results.** For example, newly available MCP tools were appended
  to the `Read` result.
- **The background subagent:**
  - The `Agent` call returns at once.
  - The subagent runs concurrently, with its own system prompt, 8 of the 12 tools, a 5-minute
    cache instead of 1 hour, and an `x-claude-code-agent-id` header.
  - When it finishes, the main agent gets a new request with a `<task-notification>` holding the
    subagent's final text verbatim. None of the subagent's own messages enter the main context.
- **`proxy.py`'s output cannot be parsed when requests overlap.** The two concurrent replies came
  back in the opposite order to the requests, and no printed line says which request a chunk
  belongs to.
- **No Glob tool in this setup**: the "use Glob" step ran `ls` through Bash.
- **Model**: every request in these runs used `claude-haiku-4-5`.
- **Privacy**: every request carries the account email (in a reminder) and device, account and
  session ids (in `metadata.user_id`). `proxy.py` also prints the first 16 characters of the
  token. Mask these before showing traffic to the class.
