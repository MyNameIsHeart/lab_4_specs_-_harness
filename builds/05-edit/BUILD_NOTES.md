# Build 05-edit notes
Start 11:43, end ~12:00.

## Changes
- monitor.py (1017 -> 1042 lines):
  - `wake_prompts(msgs)`: prompts of ScheduleWakeup calls in the thread.
  - `text_parts`: text of `role: "system"` messages, and user text equal to a wakeup prompt, is all HARNESS (never YOU).
  - `anatomy`: `tool_addition` blocks count under `tools`; system-message text counts under `harness`.
  - `analyze`: "new in this request" now covers system messages (row line "HARNESS system message") and wakeups ("HARNESS scheduled wakeup"); first_prompt only comes from a user message 0.
  - Message keys now normalise string content to one text block. Without this, Opus traffic showed a false "history changed at message 1", because the harness sends the same system message as a string once and as a list the next time.
- static/app.js (987 -> 1009): `textCards` makes a HARNESS · system message card for role system, and HARNESS · scheduled wakeup for a matching user text (`D.wakes`). New `toolAddCard` (TOOL ADDED · name; description and schema collapsed). Conversation header for system messages reads "HARNESS → MODEL". All text via textContent.
- static/style.css (125, same line count): `tooladd` colour #b45309 and a clickable header.

## F8
- Opus run: the environment is a `role: "system"` message. The API shows `your_chars` = 42 (the typed prompt only), harness 22.5K, and anatomy parts summing to content_size (exchange 3: 63398).
- Request 3 carries a system message with 3 `tool_addition` blocks; they are counted in `tools` (31116 vs 29257).
- Haiku run: no ScheduleWakeup was produced (the agent answered from the subagent result). I checked the wakeup path with a synthetic POST: the wake text counted as harness (15) and your_chars was 5.
- NOT checked in a browser: the cards (system message, tool added, wakeup) are only read in code.

## Decisions
- Non-text blocks in system messages (other than tool_addition) are counted by the generic path.
- The wakeup match is on trimmed text, against any ScheduleWakeup call anywhere in the request's messages.
- tool_addition fields: tries `tool.description` / `tool.input_schema`, then the block's own; falls back to JSON.

## Known issues
- A wakeup in the "new" row is detected by exact match only.
- Compare/explorer do not list tool_addition blocks.
