# Spec history

SPEC.md has six commits. Every commit message gives its reason (what the build before it showed), so no build notes were needed. Sources are named per entry.

## 1. 470ac29 First draft
- **Changed:** Added proxy.py (the course proxy, unchanged) and the first SPEC.md (220 lines).
- **Why:** Written from the handout's list of what the dashboard should show, before the traffic was studied. (commit 470ac29)

## 2. 9820887 Revised after studying the traffic and a builder's review
- **Changed:** Threads come from headers; a capture worker fed by a queue; defined API and SSE events; a kind table with colours and `data-kind` attributes; `tests/fake_upstream.py`; testable acceptance checks; a "Later" list.
- **Why:** Two `claude -p` runs showed that concurrent requests interleave in proxy.py's printout (so capture inside the proxy), and that `X-Claude-Code-Session-Id` and `x-claude-code-agent-id` identify threads. A fresh agent reading the draft found the old thread key fragile, "new in this request" wrong (echoed reply), several events and rules undefined, and the draft too big for one build. (commit 9820887)

## 3. 562b8c7 After build 01 (the home build)
- **Changed:** First builds are time-boxed to about 20 minutes with three quick checks plus two live checks (full checks wait for editing); file names in rows; minimal markdown for model text; expanded blocks stay expanded; Follow live must open the first exchange on a fresh page; the builder's own choices are now written into the spec.
- **Why:** Build 01 worked on live traffic but took about 55 minutes (mostly the fake upstream and all 11 checks), too slow for the 70-minute loop. It also showed long paths crowding rows, raw `**bold**`, a Follow live glitch on a fresh page, and "Show all" collapsing on updates. (commit 562b8c7; same list in notes.md, "What the home build showed")

## 4. 50cba62 After build 02, plus new views (spec v4)
- **Changed:** Rule that `[hidden]` always wins, with check F6; three new views (anatomy bar per request, lanes per thread with tool time, stats panel with caching savings); checks F4 and F5.
- **Why:** Build 02b (Sonnet) took 11 minutes instead of 55, but the red error dot showed on every row because `.edot { display: inline-block }` overrode `hidden`; the builder had no browser. 02a (Opus) had written no files after 18 minutes. The new views come from the traffic findings: scaffolding dwarfs the human's words, and prompts differ by model. (commit 50cba62)

---
### Switch point: from rebuilding to editing
After spec v4 (50cba62) and before commit 5, we stopped rebuilding the dashboard from scratch and began editing the previous build. Reason (commit fe49da5, "Build 03-edit"): 02b's core was verified working in a browser, and spec v4 was additive (three views and one CSS rule). Editing 02b took 3 minutes; a rebuild had taken 11. A from-scratch build of v4 (03-scratch) ran in parallel as the control. Commit 8e04d37 records it: 03-scratch took 10 minutes against 3 for 03-edit, and chose a different architecture.

---

## 5. d6f5ab5 After build 03 (spec v5)
- **Changed:** Prompt sections in the data model; a system prompt explorer (sections, sizes, shares); a "Compare with..." view of two requests (anatomy, sections matched by heading, folded line diff of system prompts, tool-list changes); check F7.
- **Why:** Build 03-edit's new views worked (84% caching saving), but two questions still needed work outside the dashboard: what is in the 28K-character system prompt, and what the harness sends each model (we had to write a Python script). (commit d6f5ab5)

## 6. e63c25d After build 04
- **Changed:** Both message formats described; system-role text is HARNESS ("system message"); YOU only from user messages; a TOOL ADDED card for `tool_addition`; ScheduleWakeup prompts are HARNESS ("scheduled wakeup"); anatomy counts both; check F8.
- **Why:** Build 04, used on Opus 5.5 traffic, showed that newer models get `role: "system"` messages and `tool_addition` blocks where Haiku 4.5 gets `<system-reminder>` text, so every build labelled Opus's 26K-character environment as YOU. Builds 02a and 02b also labelled the ScheduleWakeup prompt as YOU. (commit e63c25d)

## Findings in the traffic
Source: notes.md.
- Every request re-sends everything: 90-110 KB for the main agent; tool definitions are about half (12 tools, 45 KB), the system prompt about a quarter.
- Caching makes it cheap: 8-10 uncached input tokens per request; 87% of one run's input tokens were cache reads, and 96% in another session, saving 84% of input cost.
- Thinking is hidden (`display: "omitted"`): only a signature comes back, yet thinking was 1,178 of 1,299 output tokens in one reply.
- The harness writes a different prompt per model: system prompt 27,853 chars (Haiku 4.5), 12,578 (Fable 5.1, -55%), 6,506 (Opus 5.5, -77%); request body 89.8, 66.0 and 59.9 KB.
- Fewer bytes is not fewer tokens: Opus 5.5's request is a third smaller but only 9% smaller in tokens (about 2.9 bytes per token against 4.0 for Haiku; a tokenizer difference is inferred).
- The prompt is restructured, not just cut: Haiku has 17 sections, Opus 6; the line diff is 181 lines removed, 19 added. The message format also differs (`role: "system"` and `tool_addition` against reminders).
- Reminders hide inside tool results, and some "user" messages are not the human's (a ScheduleWakeup prompt came back as a plain user message).
- A background subagent runs in parallel with its own prompt, 8 of 12 tools and a 5-minute cache; the main agent only gets its final text. Overlapping replies break proxy.py's printout.
- A real outage of about two minutes (TLS timeouts) showed as red bars in the lanes; in one session the model took 20.1 s and the tools 3.0 s. Every request also carries the account email and ids: mask them before showing traffic.
