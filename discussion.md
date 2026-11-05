# Lab 4 discussion notes

## The builds

| Build | How | Agent | Time | Code (monitor.py / app.js) | Seen in a browser |
|---|---|---|---|---|---|
| 01-home | from scratch, spec v2 | Opus | ~55 min (all 11 checks, fake upstream) | 1,442 / 1,013 | works; Follow live missed once on a fresh page |
| 02a-opus | from scratch, spec v3 | Opus | _pending_ | _pending_ | _pending_ |
| 02b-sonnet | from scratch, spec v3 | Sonnet | 11 min | 922 / 650 | works; red error dot on every row |
| 03-edit | edited 02b to spec v4 | Sonnet | **3 min** | 988 / 811 | works: lanes, anatomy bars, stats (caching saved 84.3% of input cost), one red dot only |
| 03-scratch | from scratch, spec v4 | Sonnet | _pending_ | _pending_ | _pending_ |

## 1. Which decisions did we only discover by building?

- **How much checking a build does.** Spec v2 asked for 11 acceptance checks with a fake
  upstream. The first build took 55 minutes, so spec v3 says what a first build checks.
- **Error states.** A complete HTTP 500 is `done`, red because of its status; `error` means the
  network failed. Build 01 had to pick one, and spec v3 wrote it down.
- **A restart must reset the page.** Build 01 invented a `hello` event with a boot id; spec v3
  adopted it.
- **The subagent's result arrives wrapped twice**: a `<task-notification>` inside a
  `<system-reminder>`. Build 01's live run found this, not the documentation.
- **Requests without tools that carry an agent id**: are they `side` or the subagent's? Both
  builds had to choose.
- **Long temp paths crowd the rows.** This only shows on real traffic, so v3 rows use file names.
- **A builder without a browser cannot see CSS bugs.** In 02b, `.edot { display: inline-block }`
  beat the `hidden` attribute, so every row showed a red dot. v4 adds a rule and check F6.

## 2. What came out differently, and what in the spec pinned it down?

- **Same, because the spec pinned it**:
  - The kind table (labels, hex colours, `data-kind`) made the cards look the same in every build.
  - Also the same: the order of the detail sections, the `↑`/`↓` row lines, thread names
    (`main`, `sub-1`), "↳ reply of #N", and harness text split out of tool results.
- **Different, because the spec left it open**:
  - Row font: proportional in 01, monospace in 02b.
  - Code size: 01 has 1.5× the lines of 02b.
  - Where row lines are built: on the server in 02b, in the page in 01.
  - How streaming updates are throttled.
  - Thread labels for plain text in subagent threads.
- **Different, because of the model**: from the same spec, Sonnet finished in 11 minutes, while
  Opus spent about 18 minutes planning before writing a single file.

## 3. What did we find in the agent's messages?

See `notes.md`. The headlines:

- **A one-line question becomes 60–90 KB.** Tool definitions are about half of it, the system
  prompt about a quarter. The human's words are well under 1%.
- **The harness writes a different prompt for each model.** Opus 5.5 gets a system prompt 77%
  shorter than Haiku 4.5's, and Fable 5.1's is 55% shorter. Reminders shrink from 14.6K to
  1.1K characters. This confirms the course video live.
- **Fewer bytes is not fewer tokens.** The newer models count about 2.9 bytes per token against
  4.0 for Haiku 4.5, which suggests a different tokenizer.
- **Caching carries the cost**: only 2–10 input tokens per request are uncached.
- **Thinking is hidden**, but it is most of the output. One reply used 1,178 of its 1,299 output
  tokens on thinking.
- **Reminders hide inside tool results**, e.g. a list of new MCP tools appended to a `Read` result.
- **A background subagent is a separate conversation**, running in parallel under the same
  session. Its final text comes back verbatim in a `<task-notification>`; none of its messages
  enter the main context.
- **`proxy.py`'s printout cannot be parsed when requests overlap**: the replies came back in the
  opposite order, and no line says which request it belongs to.

## 4. When would we stop regenerating and start editing?

_Pending build 03: the same spec change, made once by editing 02b and once from scratch._
