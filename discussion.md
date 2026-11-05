# Lab 4 discussion notes

## The builds

| Build | How | Agent | Time | monitor.py / app.js lines | Seen in a browser on live traffic |
|---|---|---|---|---|---|
| 01-home | from scratch, spec v2 | Opus | ~55 min (all 11 checks, fake upstream) | 1,442 / 1,013 | works; Follow live missed once on a fresh page |
| 02a-opus | from scratch, spec v3 | Opus | 19 min | 1,073 / 909 | works; proportional fonts, no dot bug |
| 02b-sonnet | from scratch, spec v3 | Sonnet | 11 min | 922 / 650 | works; red error dot on every row (CSS beat `hidden`) |
| 03-edit | **edited** 02b to spec v4 | Sonnet | **3 min** | 988 / 811 | lanes, anatomy bars, stats; caching saved 84.3% of input cost |
| 03-scratch | from scratch, spec v4 (control) | Sonnet | 10 min | 1,203 / 521 | same features, different design; showed a real network outage as red lanes |
| 04-edit | edited 03-edit to spec v5 | Sonnet | 2 min | 1,017 / 987 | system prompt explorer; Compare (Opus 5.5 vs Haiku 4.5) |
| 05-edit | edited 04-edit to spec v6 | Sonnet | _pending_ | _pending_ | _pending_ |

## 1. Which decisions did we only discover by building?

- **How much checking a build does.** The first build took 55 minutes because spec v2 asked for
  11 checks with a fake upstream. Spec v3 says what a first build checks, and the time dropped
  to 10–11 minutes.
- **Error states.** Build 01 had to decide that a complete HTTP 500 is `done`, red because of
  its status, while `error` means the network failed.
- **A restart must reset the page.** Build 01 invented a `hello` event with a boot id.
- **The subagent's result arrives wrapped twice**: a `<task-notification>` inside a
  `<system-reminder>`.
- **Long temp paths crowd the rows**, so rows show file names.
- **A builder without a browser cannot see CSS bugs.** In 02b, `display: inline-block` beat the
  `hidden` attribute and every row showed a red dot. Rule and check F6.
- **Text the human never typed.** The harness sends a `ScheduleWakeup` prompt back as a plain
  user message, and both 02a and 02b labelled it YOU.
- **The message format differs by model.** Opus 5.5 gets `role: "system"` messages and
  `tool_addition` blocks, where Haiku 4.5 gets `<system-reminder>` text. Every build labelled
  Opus's 26K-character environment as "your words" (spec v6, F8).
- **Real failures happen.** During the lab, TLS handshakes to the API timed out for about two
  minutes. Claude Code retried every request, and the dashboard showed each attempt in red.

## 2. What came out differently, and what in the spec pinned it down?

- **We compared builds on identical traffic** by chaining them: agent → 02a → 02b → API. Each
  monitor relays byte for byte, so one live session appears in both dashboards.
- **Same, because the spec pinned it**:
  - The kind table (labels, hex colours, `data-kind`) made the cards look the same in every build.
  - Also the same: the order of the detail sections, the `↑`/`↓` row lines, thread names
    (`main`, `sub-1`), "↳ reply of #N", harness text split out of tool results, and the
    "system prompt changed" flag.
- **Different, because the spec left it open**:
  - Row font: proportional in 01 and 02a, monospace in 02b.
  - Where blocks are classified: in the page in 01, 02a and 02b; on the server in 03-scratch.
  - The look of the lanes and of error rows.
  - The streaming throttle.
  - Thread labels for plain text in subagent threads.
- **Different, because of the model**: from the same spec, Opus took 19 minutes (planning for
  about 18 before writing a file) and Sonnet 11. Opus avoided the CSS bug.

## 3. What did we find in the agent's messages?

Details are in `notes.md`.

- **A one-line question becomes 60–110 KB.** Tool definitions are about 46% of it, the system
  prompt about 28%, harness reminders about 18%. The human's words are 0.3–0.5%.
- **The harness writes a different prompt for each model.**
  - Opus 5.5 gets a system prompt 77% shorter than Haiku 4.5's (6.5K vs 27.9K chars).
  - Haiku's prompt has 17 sections, Opus's 6. Gone are "Doing tasks", "Executing actions with
    care", "Tone and style", and about 13K characters of auto-memory guidance.
  - In their place come a short "# Harness" and "# Memory".
  - This confirms the course video, live, in our own dashboard's Compare view.
- **The message format differs too.** Opus gets `role: "system"` messages and `tool_addition`
  blocks mid-conversation.
- **Fewer bytes is not fewer tokens.** The newer models count about 2.9 bytes per token
  against 4.0 for Haiku 4.5, which suggests a different tokenizer.
- **Caching carries the cost.** 96% of input tokens were cache reads, which saved 84% of the
  input cost. Only 2–10 tokens per request are uncached.
- **Time goes to the model, not the tools**: 20.1 s of model time against 3.0 s of tool time
  in one session.
- **Thinking is hidden, but it is most of the output.** One reply used 1,178 of its 1,299 output
  tokens on thinking.
- **A background subagent is a separate conversation**, running in parallel under the same
  session. Its result comes back verbatim in a `<task-notification>`. The agent can wait with
  `ScheduleWakeup`, whose prompt comes back as a fake user message.
- **`proxy.py`'s printout cannot be parsed when requests overlap**: the replies came back in the
  opposite order, and no line says which request it belongs to.

## 4. When would we stop regenerating and start editing?

- **The data.** Spec v4 was built twice: an edit of 02b took 3 minutes, a rebuild 10. Both met
  the spec. The rebuild came out with a different design, because it re-rolled every decision
  the spec left open; the edit kept them. Builds 04 and 05 were edits of 2–3 minutes each.
- **Keep regenerating while the core is still moving** (architecture, data model, what the
  traffic looks like). Each rebuild tests whether the spec alone is enough. Rebuilds 01→02
  found the error states, the `hello` event and the build budget.
- **Switch to editing once a build is verified in a browser and the changes are additive**
  (new views, a new card kind). We switched at build 03, committed 02b first, and noted it in
  the history.
- **Rebuild again when an edit would fight the structure**, or every few changes as a check
  that the spec still holds on its own. Any fix made only in code is lost on the next rebuild
  unless it goes into the spec.
