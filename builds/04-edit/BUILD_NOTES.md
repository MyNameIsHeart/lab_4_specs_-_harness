# Build notes: 04-edit (spec 03 -> 04)

Start 11:36, end 11:38 (by `date`).

## Changes
- monitor.py (988 -> 1017 lines): new `prompt_sections(body)`; each system block split at lines
  starting with `#`, text before the first heading is "(preamble)"; sizes sum to the block size
  (split with splitlines(keepends)). Served as `prompt_sections` in `/api/exchanges/<id>` detail only.
- static/app.js (811 -> 987): `renderSystem` is now the explorer (row per section: heading,
  size, share bar; click shows text; "Full text" button per block keeps the old card).
  New compare code: "Compare with..." button in the detail header of message exchanges; pick mode
  (click another message row, or type #id) in a small bottom bar; result in a fixed overlay `#cmp`.
  Shows model, anatomy bars and numbers table (A, B, B-A), sections matched by heading (both /
  only A / only B, with sizes and difference), LCS line diff of the joined system prompts
  (folded runs "... N unchanged lines"), tool list changes (only A, only B, size changed).
- static/style.css: styles for explorer, overlay, tables, diff.
- index.html, README.md, proxy.py, SPEC.md unchanged.

## F7
Two live runs through the proxy on 8091 (haiku-4-5, opus-5-5). Checked via the API on :8092
and the app.js lineDiff run under node on the two first requests (#2 haiku, #5 opus):
- Section sizes sum to block size in every block (haiku 17 sections / 27853; opus 6 / 6506).
- Per-heading sizes differ (e.g. "# Doing tasks" only in A, "# Harness" and "# Memory" only in B,
  "# Session-specific guidance" 576 vs 165).
- Line diff: 181 removed, 19 added, 37 unchanged (A 218 lines, B 56); folding is in diffView.
- Tool lists: both 12 tools, no name changes; size changes are shown by the same code.
Not checked: the actual rendering in a browser (none available).

## Open decisions
- Section matching: by heading text plus occurrence number, across all system blocks.
- Diff folds unchanged runs longer than 5 lines, keeping 2 lines of context at each side.
- Compare is a fixed overlay, not a detail section; Compare only for message exchanges.
- Heading line is part of the section text and size. Headings inside code fences count.
- Tool sizes are the JSON length of each tool definition.

## Known issues
- Compare view is a snapshot; it does not live-update. No Esc key to close.
- Large diffs render one DOM node per line (fine for a few hundred).
