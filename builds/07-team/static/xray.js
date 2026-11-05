// X-ray owns only this file; SPEC.md section 14.3 documents the accounting.
(function () {
'use strict';
const button = document.getElementById('b-xray');
if (!button) return;
const TAGS = 'system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat';
const count = text => Array.from(text).length;
const json = value => JSON.stringify(value);
const blocks = message => typeof message.content === 'string'
  ? [{ type: 'text', text: message.content }] : (Array.isArray(message.content) ? message.content : []);

// Count actual text (including reminder delimiters), compact JSON for structured
// blocks. No JSON envelope, cache metadata, image bytes or token estimates.
function analyze(detail) {
  const body = detail.body, items = [];
  let yours = 0;
  const add = (kind, label, location, text) => {
    if (typeof text !== 'string' || !text.length) return;
    items.push({ kind, label, location, text, size: count(text), order: items.length });
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const calls = new Map(), wakes = new Set();
  messages.forEach(m => blocks(m).forEach(b => {
    if (b && b.type === 'tool_use') {
      calls.set(b.id, b.name || '?');
      if (b.name === 'ScheduleWakeup' && b.input && typeof b.input.prompt === 'string') wakes.add(b.input.prompt.trim());
    }
  }));
  const thread = (detail.summary || {}).thread || '';
  function textParts(text, role, location) {
    if (typeof text !== 'string') return;
    if (role === 'system' || role === 'developer' || (role === 'user' && wakes.has(text.trim()))) {
      add('harness', role === 'user' ? 'Scheduled wakeup' : role + ' message', location, text); return;
    }
    const re = new RegExp('<(' + TAGS + ')(?:\\s[^>]*)?>[\\s\\S]*?</\\1>', 'g');
    let pos = 0, match;
    const plain = value => {
      if (role === 'user' && thread !== 'side' && !thread.startsWith('sub-')) yours += count(value);
      else add(role === 'user' ? 'harness' : 'history', role === 'user' ? (thread === 'side' ? 'Side request' : 'Subagent task') : role === 'tool' ? 'Tool output' : 'Model history', location, value);
    };
    while ((match = re.exec(text))) {
      plain(text.slice(pos, match.index));
      add('harness', match[1], location, match[0]);
      pos = match.index + match[0].length;
    }
    plain(text.slice(pos));
  }
  function visit(block, role, location) {
    if (!block || typeof block !== 'object') { add('history', 'Other content', location, json(block)); return; }
    if (block.type === 'text') { textParts(block.text || '', role, location); return; }
    if (block.type === 'tool_addition') {
      const tool = block.tool || block, definition = tool.definition || tool;
      add('harness', 'TOOL ADDED · ' + (definition.name || block.name || '?'), location, json(block)); return;
    }
    if (block.type === 'tool_result') {
      const loc = location + ' · RESULT · ' + (calls.get(block.tool_use_id) || block.tool_use_id || '?');
      if (typeof block.content === 'string') textParts(block.content, 'tool', loc);
      else if (Array.isArray(block.content)) block.content.forEach((b, i) => visit(b, 'tool', loc + ' · part ' + (i + 1)));
      else if (block.content != null) add('history', 'Tool output', loc, json(block.content));
      return;
    }
    if (block.type === 'image' || block.type === 'document') return;
    add('history', block.type === 'tool_use' ? 'Tool call · ' + (block.name || '?') : 'Other structured content · ' + (block.type || '?'), location, json(block));
  }
  const system = typeof body.system === 'string' ? [body.system] : Array.isArray(body.system) ? body.system : [];
  system.forEach((b, i) => add('harness', 'System block ' + (i + 1), 'Top-level system', typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : json(b)));
  if (Array.isArray(body.tools) && body.tools.length) add('harness', 'Tool definitions · ' + body.tools.length + ' tools', 'Top-level tools', json(body.tools));
  messages.forEach((m, i) => blocks(m).forEach((b, j) => visit(b, m.role, (i === 0 ? 'First message' : 'Message ' + (i + 1)) + ' · ' + m.role + ' · block ' + (j + 1))));
  const harness = items.filter(i => i.kind === 'harness').reduce((n, i) => n + i.size, 0);
  const history = items.filter(i => i.kind === 'history').reduce((n, i) => n + i.size, 0);
  return { items, yours, harness, history, total: yours + harness + history };
}
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const style = el('style', '', `
#xray-panel{position:fixed;inset:0 0 0 auto;width:min(760px,100vw);z-index:100;background:var(--bg,#fff);color:var(--fg,#111827);box-shadow:-8px 0 40px rgba(0,0,0,.35);border-left:1px solid var(--line,#e5e7eb);overflow:auto;padding:22px;font:14px/1.5 system-ui}
#xray-panel .xr-head{display:flex;gap:12px;align-items:center;justify-content:space-between;position:sticky;top:-22px;background:var(--bg,#fff);padding:12px 0;z-index:1}
#xray-panel h2{font-size:18px;margin:0} #xray-panel .xr-hero{font-size:28px;line-height:1.25;margin:18px 0;color:var(--fg,#334155);font-weight:700}
#xray-panel .xr-muted{color:var(--muted,#6b7280);font-size:12px} #xray-panel .xr-controls{display:flex;gap:16px;flex-wrap:wrap;margin:20px 0}
#xray-panel details{border:1px solid var(--line,#e5e7eb);border-radius:8px;margin:10px 0;padding:12px} #xray-panel summary{cursor:pointer;overflow-wrap:anywhere}
#xray-panel .xr-location{font-size:12px;color:var(--muted,#6b7280);margin:4px 0} #xray-panel .xr-size{font-variant-numeric:tabular-nums;font-weight:600}
#xray-panel .xr-track{height:5px;background:var(--line,#e5e7eb);border-radius:4px;margin:8px 0} #xray-panel .xr-fill{height:100%;background:#b45309;border-radius:4px}
#xray-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;max-height:50vh;overflow:auto;border-top:1px solid var(--line,#e5e7eb);padding-top:12px}
#xray-panel button{cursor:pointer;padding:6px 12px} #xray-panel .xr-preview{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--muted,#6b7280)}
`);
document.head.append(style);
const panel = el('aside'); panel.id = 'xray-panel'; panel.hidden = true;
panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Request X-ray');
document.body.append(panel);
let current = null, generation = 0, sizeSort = false, showHistory = true, cached = null;
const selected = () => {
  const row = document.querySelector('#timeline .row.sel');
  return row ? row.dataset.id : null;
};
const masked = text => {
  const privacy = document.getElementById('f-privacy');
  return privacy && privacy.checked ? text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '•••@•••') : text;
};
const number = n => n.toLocaleString();
function close() { generation++; panel.hidden = true; current = null; cached = null; button.focus(); }
function heading(label) {
  panel.replaceChildren();
  const head = el('div', 'xr-head'); head.append(el('h2', '', label));
  const exit = el('button', '', 'Close ×'); exit.onclick = close;
  head.append(exit); panel.append(head);
}
function render(detail) {
  const open = new Set(Array.from(panel.querySelectorAll('details[open]')).map(n => n.dataset.key));
  heading('X-ray · request #' + detail.id);
  if (detail.evicted || !detail.body || typeof detail.body !== 'object') {
    panel.append(el('p', '', detail.evicted ? 'This request body is no longer retained.' : 'No structured request body is available.')); return;
  }
  if (!Array.isArray(detail.body.messages) && detail.body.system === undefined && detail.body.tools === undefined) {
    panel.append(el('p', '', 'This request format is not supported by X-ray. Select a Claude message exchange.')); return;
  }
  const data = analyze(detail), pct = n => data.total ? (n / data.total * 100).toFixed(1) : '0.0';
  panel.append(el('p', 'xr-hero', 'You typed ' + number(data.yours) + ' characters. The harness added ' + number(data.harness) + ' (' + pct(data.harness) + '%).'));
  panel.append(el('p', '', 'Your words: ' + pct(data.yours) + '% · Harness: ' + pct(data.harness) + '% · Model/tool history: ' + pct(data.history) + '%'));
  panel.append(el('p', 'xr-muted', number(data.total) + ' counted characters across this entire request, including earlier turns. Text includes reminder tags; structured content uses compact JSON. Transport metadata and image/document payloads are excluded. Rounded shares may differ by 0.1%.'));
  const controls = el('div', 'xr-controls');
  function toggle(label, checked, change) {
    const wrap = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = checked;
    input.onchange = () => { change(input.checked); render(detail); };
    wrap.append(input, document.createTextNode(' ' + label)); controls.append(wrap);
  }
  toggle('Largest first', sizeSort, v => { sizeSort = v; });
  toggle('Include model/tool history', showHistory, v => { showHistory = v; });
  panel.append(controls);
  const yours = el('div', '', 'Your words · ' + number(data.yours) + ' chars · ' + pct(data.yours) + '%');
  panel.append(yours);
  const items = data.items.filter(i => showHistory || i.kind === 'harness');
  if (sizeSort) items.sort((a, b) => b.size - a.size || a.order - b.order);
  items.forEach(item => {
    const entry = el('details'); entry.dataset.key = String(item.order); entry.open = open.has(String(item.order));
    const summary = el('summary');
    summary.append(el('strong', '', masked(item.label)), el('div', 'xr-location', masked(item.location)), el('span', 'xr-size', number(item.size) + ' chars · ' + pct(item.size) + '%'), el('span', 'xr-preview', masked(item.text.trim().split('\n')[0] || '(blank text)')));
    const track = el('div', 'xr-track'), fill = el('div', 'xr-fill'); fill.style.width = pct(item.size) + '%';
    if (item.kind === 'history') fill.style.background = '#16a34a';
    track.append(fill); summary.append(track); entry.append(summary);
    let built = false;
    const expand = () => { if (entry.open && !built) { entry.append(el('pre', '', masked(item.text))); built = true; } };
    entry.addEventListener('toggle', expand); expand(); panel.append(entry);
  });
  if (!items.length) panel.append(el('p', 'xr-muted', 'No added text found in this request.'));
}
async function load(id) {
  const token = ++generation; current = id; cached = null;
  heading(id ? 'X-ray · loading #' + id : 'X-ray');
  if (!id) { panel.append(el('p', '', 'Select a message exchange in the timeline to inspect it.')); return; }
  try {
    const response = await fetch('/api/exchanges/' + encodeURIComponent(id));
    if (!response.ok) throw new Error('Request unavailable (HTTP ' + response.status + ').');
    const detail = await response.json();
    if (token !== generation || panel.hidden) return;
    cached = detail; render(detail);
  } catch (error) {
    if (token !== generation || panel.hidden) return;
    heading('X-ray'); panel.append(el('p', '', 'Could not load this request. ' + error.message));
    const retry = el('button', '', 'Retry'); retry.onclick = () => load(selected()); panel.append(retry);
  }
}
button.disabled = false; button.title = 'Inspect everything added to the selected request';
button.onclick = () => {
  if (!panel.hidden) { close(); return; }
  panel.hidden = false; load(selected()); panel.querySelector('button').focus();
};
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
const timeline = document.getElementById('timeline');
if (timeline) new MutationObserver(() => {
  if (!panel.hidden && selected() !== current) { cached = null; load(selected()); }
}).observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
const privacy = document.getElementById('f-privacy');
if (privacy) privacy.addEventListener('change', () => { if (!panel.hidden && cached) render(cached); });
})();
