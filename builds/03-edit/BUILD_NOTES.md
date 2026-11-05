# Build 03-edit notes
Start 11:31, end 11:34.

## Changes
- static/style.css: `[hidden]{display:none!important}` first line (fixes the red dot on every row); styles for anatomy bar, lanes, stats panel.
- static/index.html: `#lanes` strip, `#stats` panel, "Stats" button.
- static/app.js: anatomy bar in rows and (big, with legend, numbers, "your words") in Summary; lanes strip (per thread, bars with first-byte tick, `⚙` tool-time labels in gaps, click opens exchange, collapsible, remembered); stats panel; "1 error" singular.
- monitor.py: anatomy (system/tools/harness/earlier/new), content_size, your_chars, tool_time, cache_write_1h added to summaries.

## Checks
- F1, F2, F3, 10, 11: not re-run (code unchanged there). 11 seen in terminal log: main + sub-1 threads.
- F4: partly. Live run: sub-1 and main requests interleave in time; API anatomy parts sum to content_size on all 6 message rows; tool_time present. Lane/row rendering NOT seen (no browser).
- F5: not run in a browser. Token sums computed from the same summary fields (input+cache = in on every row).
- F6: API: exactly one row with dot=true (#3, after the missing-file read), none red. Page "1 error" and CSS fix not seen in a browser.
- Host guard: evil.example gives 403.

## Decisions
- Content size = system + tools + all message block chars; harness includes tags' inner text, and user text in `side` requests.
- Your words = untagged user text in non-sub, non-side threads, whole request.
- Tool time = this start minus end of the thread's previous exchange.
- "Current session" for lanes/stats = session of the newest message exchange; lanes ignore filters, stats follow them.
- Saving = 1 - (uncached + 0.1 read + 1.25 write (2 for 1h part))/in; 1h part read from usage.cache_creation if present.
- Stats opens as a floating panel.

## Known issues
- Not checked in a browser. Lanes rebuild every second while streaming (hover flickers). Tool time of a request that arrives before the previous reply ends stays empty.
