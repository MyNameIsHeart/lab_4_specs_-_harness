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

## Experiment: the same task, three models (lab, 5 Nov)

Same prompt ("Read notes.txt and tell me the secret word"), same Claude Code version, sent
through build 01 with `--model`. These figures are for the first request of each session.

| Sent by the harness | Haiku 4.5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|
| System prompt (main block) | 27,853 chars | 6,506 chars (−77%) | 12,578 chars (−55%) |
| Tool definitions (same 12 tools) | 45,430 chars | 29,257 chars | 29,257 chars |
| Reminders in the first message | 8 blocks, 14,605 chars | 2 blocks, 1,144 chars | 2 blocks, 1,145 chars |
| Request body | 89.8 KB | 59.9 KB | 66.0 KB |
| Input tokens | 22,609 | 20,672 | 22,531 |
| Thinking | fixed budget (31,999) | adaptive | adaptive |
| `max_tokens` | 32,000 | 128,000 | 64,000 |

- **The harness writes a different prompt for each model.** This confirms the course video live:
  the newer models get a much shorter system prompt (Opus 5.5 about 77% shorter, Fable 5.1
  "less than half"), shorter tool descriptions, and far fewer reminders.
- **Fewer bytes is not fewer tokens.** Opus 5.5's request is a third smaller than Haiku's, but
  only 9% smaller in tokens: about 4.0 bytes per token for Haiku 4.5 against about 2.9 for Opus
  5.5 and Fable 5.1. That suggests the newer models use a different tokenizer (inferred).
- **Thinking changed shape**: Haiku 4.5 gets a fixed thinking budget; the newer models get
  "adaptive" thinking, where the model decides how much to think. In both cases the thinking
  text is hidden.
- **Each model has its own cache.** All three first requests wrote the cache from scratch
  (cache read 0).

## More findings from the lab (5 Nov)

- **The prompt is restructured, not just cut.** Build 04's Compare view, Opus 5.5 against
  Haiku 4.5:
  - Haiku's prompt has 17 sections, Opus's 6.
  - Only Haiku has "# Doing tasks", "# Executing actions with care", "# Tone and style",
    "# Text output" and "# auto memory" with six subsections (about 13K characters of
    memory guidance).
  - Only Opus has a short "# Harness" (2.4K) and "# Memory" (2.2K).
  - "# Environment" and "# Context management" are identical.
  - The line diff: 181 lines removed, 19 added.
- **The message format differs by model.** Opus 5.5 gets `role: "system"` messages inside
  `messages`: the environment, and later "The following tools just became available" with
  `tool_addition` blocks, i.e. tools added mid-conversation. Haiku 4.5 gets the same
  information as `<system-reminder>` text in user messages.
- **Messages the human never typed.** The agent waited for its subagent with `ScheduleWakeup`;
  later the harness sent that call's prompt back as a plain user message. Every build
  labelled it YOU.
- **A real outage.** For about two minutes TLS handshakes to the API timed out (then "Can't
  assign requested address"). Claude Code retried every request, and the agent launched a
  second subagent meanwhile. The dashboard showed each failed attempt in red and the outage as
  long red bars in the lanes. The machine had only 15 sockets in TIME_WAIT, so it was the
  network (probably the lab Wi-Fi reconnecting), not exhaustion.
- **Where the time goes**: in one session the model took 20.1 s and the tools 3.0 s.
- **Caching saved 84%** of the input cost in one session: 96% of input tokens were cache reads.

## What the home build showed (`builds/01-home`, built from the committed `SPEC.md`)

- **Too slow for the lab loop.** One fresh agent took about 55 minutes (about 315k tokens). It
  wrote `monitor.py` (1,442 lines), `app.js` (1,013 lines) and a fake upstream, and ran all 11
  acceptance checks. The lab gives 70 minutes for the whole loop.
- **It works on live traffic.** I checked two sessions in the browser: parallel reads, a missing
  file, a file containing HTML, and a background subagent.
  - The timeline is newest first, with `YOU`, `CALL`, `RESULT`, `MODEL`, `TASK` and `HARNESS`
    labels in distinct colours and `main`/`sub-1` thread pills.
  - Each tool result sits under its call ("CALL · Read … from #5").
  - The missing file shows as a red ERROR card, a red dot on its row, and "1 error" in the top bar.
  - `<script>` from the file shows as text.
  - The subagent's result shows as `HARNESS · subagent result`, linked to `sub-1`.
  - Hidden thinking shows as "thinking hidden · 50 tokens".
  - The account email is masked.
  - The terminal prints one line per exchange.
- **Candidates for the next spec commit:**
  1. Build time. Either trim the first build (e.g. live checks 10–11 only; the fake-upstream
     checks once, before switching to editing), or move more to "Later".
  2. Long absolute paths eat the row lines ("Read …251af3f2e439/scratchpad/fixtures/notes.txt").
     Show the file name, with the full path on hover.
  3. The model's markdown shows raw (`**pomegranate**`). Decide on minimal rendering: bold,
     inline code, fences.
  4. Once, on the very first page load, Follow live highlighted the newest row, but the detail
     stayed on "Waiting for traffic…". It did not happen again after a restart. Add a check:
     "a fresh page with Follow live on opens the first exchange by itself".
  5. An expanded "Show all" inside Reply collapses on every streaming update (known issue).
  6. Choices the builder had to make, listed in `builds/01-home/BUILD_NOTES.md`, can be pinned
     down. For example, a finished HTTP 500 is `done` (red by status) while `error` means a network
     failure; a request without tools is `side` even with an agent-id header; section open or
     closed state is kept in localStorage.
