# Build 06 notes
- static/app.js toolAddCard: now reads b.tool.definition.{name,description,input_schema}
  (falls back to older shapes b.tool / b). Was showing "TOOL ADDED · ?". Net +2 lines (1009 -> 1010... see wc).
- monitor.py: no change needed; tool_addition is only measured by size (_jlen), no name read.
- Message comparison already treats string content as one text block (monitor.py blocks_of, line ~435; app.js line ~382).
- proxy.py, SPEC.md unchanged.
- Checks: node --check static/app.js passes; extracted toolAddCard under node with stubs and ran
  the WebFetch block: card title "TOOL ADDED · WebFetch".
