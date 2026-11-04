// Agent traffic dashboard. Plain JS, no dependencies.
// All traffic content reaches the page through textContent / text nodes, never as HTML.
'use strict';
(function () {

// ---------------------------------------------------------------------------
// state

const S = {
  ex: new Map(),          // id -> summary (the higher version wins)
  ids: [],                // known ids, ascending
  rows: new Map(),        // id -> row element in the timeline
  selected: null,
  detail: null,           // {id, version, data}
  loadSeq: 0,
  thread: null,           // thread filter (thread_key)
  errorsOnly: false,
  hideNonMessage: true,
  follow: true,
  privacy: true,
  newCount: 0,
  open: loadOpen(),       // section name -> open?
  maskIds: new Set(),
  maskRe: null,
  boot: null,
  pending: new Set(),     // ids changed since the last frame
  fresh: new Set(),       // ids first seen since the last frame (for follow / chip)
  frame: 0,
  refetchTimer: 0,
  selectT0: 0,
  replyBox: null,         // live Reply section body
  convReplyBox: null,     // live reply part of the Conversation section
};

const DEFAULT_OPEN = {summary: true, new: true, reply: true, conversation: false, system: false, tools: false, raw: false};
const HARNESS_TAGS = ['system-reminder', 'task-notification', 'command-name', 'command-message',
  'command-args', 'local-command-stdout', 'local-command-caveat'];
const TAG_RE = new RegExp('<(' + HARNESS_TAGS.join('|') + ')>[\\s\\S]*?</\\1>', 'g');
const ARG_KEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];
const KINDS = {
  you: '◉', task: '➤', harness: '⚙', model: '◆', thinking: '◌', call: '▶', result: '◀', system: '■', other: '◇',
};
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;

function loadOpen() {
  try { return JSON.parse(localStorage.getItem('traffic.open') || '{}') || {}; } catch (e) { return {}; }
}
function saveOpen() {
  try { localStorage.setItem('traffic.open', JSON.stringify(S.open)); } catch (e) { /* private mode */ }
}

// ---------------------------------------------------------------------------
// helpers

const $ = (id) => document.getElementById(id);

// el('div', 'cls', child, ...): strings become text nodes (never parsed as HTML).
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (let i = 2; i < arguments.length; i++) add(e, arguments[i]);
  return e;
}
function add(parent, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) add(parent, x); return; }
  parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function addMaskIds(list) {
  let changed = false;
  for (const id of list || []) {
    if (typeof id === 'string' && id.length >= 8 && !S.maskIds.has(id)) { S.maskIds.add(id); changed = true; }
  }
  if (changed) S.maskRe = new RegExp(Array.from(S.maskIds).map(escRe).join('|'), 'g');
  return changed;
}
// Privacy: e-mail addresses and the ids of metadata.user_id are masked on screen.
function mask(s) {
  if (s == null) return '';
  s = String(s);
  if (!S.privacy) return s;
  s = s.replace(EMAIL_RE, '•••@•••');
  if (S.maskRe) s = s.replace(S.maskRe, '•••');
  return s;
}

function fmtNum(n) { return n == null ? '-' : Number(n).toLocaleString('en-US'); }
function fmtK(n) {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtBytes(n) {
  if (n == null) return '-';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(t) {
  if (!t) return '--:--:--';
  const d = new Date(t * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '-';
  if (sec < 10) return sec.toFixed(1) + 's';
  if (sec < 120) return Math.round(sec) + 's';
  return Math.floor(sec / 60) + 'm' + pad2(Math.round(sec % 60)) + 's';
}
function pct(x) { return Math.round((x || 0) * 100) + '%'; }
function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function cut(s, n, tail) {
  s = String(s);
  if (s.length <= n) return s;
  return tail ? '…' + s.slice(s.length - n + 1) : s.slice(0, n - 1) + '…';
}
function countLines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

function mainArg(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ARG_KEYS) {
    const v = input[k];
    if (v == null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return cut(oneLine(s), 80, k === 'file_path');
  }
  return '';
}

// Split text into harness spans (tagged) and the rest.
function segments(text) {
  const out = [];
  let pos = 0, m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > pos) out.push({harness: false, tag: '', text: text.slice(pos, m.index)});
    out.push({harness: true, tag: m[1], text: m[0]});
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({harness: false, tag: '', text: text.slice(pos)});
  return out.filter((s) => s.harness || s.text.trim() !== '');
}

function blocksOf(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (typeof msg.content === 'string') return [{type: 'text', text: msg.content}];
  return Array.isArray(msg.content) ? msg.content : [];
}

function threadLabel(s) {
  if (!s.thread) return '';
  const multi = new Set(Array.from(S.ex.values()).map((x) => x.session).filter(Boolean)).size > 1;
  return (multi && s.session ? s.session + ' ' : '') + s.thread;
}
function pillClass(name) {
  if (!name) return 'p-main';
  if (name === 'side') return 'p-side';
  const m = /^sub-(\d+)$/.exec(name);
  if (m) return 'p-sub' + ((parseInt(m[1], 10) - 1) % 4);
  return 'p-main';
}
// A thread pill; clicking it anywhere filters to that thread.
function pill(key, name, label, title) {
  const p = el('button', 'pill ' + pillClass(name) + (S.thread === key ? ' active' : ''), mask(label || name));
  p.type = 'button';
  p.dataset.thread = key;
  if (title) p.title = mask(title);
  return p;
}
function summaryPill(s) {
  return pill(s.thread_key, s.thread, threadLabel(s), s.thread_title ? s.thread + ': ' + s.thread_title : s.thread);
}
function exLink(id, text) {
  const b = el('button', 'link', text || '#' + id);
  b.type = 'button';
  b.dataset.goto = String(id);
  return b;
}

// ---------------------------------------------------------------------------
// text rendering: long text collapses to its first 6 lines (at most 500 chars)

function preview(text) {
  let end = 0;
  for (let i = 0; i < 6; i++) {
    const j = text.indexOf('\n', end);
    if (j === -1) { end = text.length; break; }
    end = j + 1;
  }
  return text.slice(0, Math.min(end, 500)).replace(/\n$/, '');
}
function isLong(text) { return text.length > 800 || countLines(text) > 10; }

// build(str) returns an element showing str; the box toggles preview <-> full text.
function collapsible(text, build, forceShort) {
  text = String(text);
  const box = el('div', 'txt');
  if (!forceShort && !isLong(text)) { box.appendChild(build(text)); return box; }
  const label = 'Show all (' + fmtNum(countLines(text)) + ' lines, ' + fmtNum(text.length) + ' chars)';
  const btn = el('button', 'more', label);
  btn.type = 'button';
  let full = false;
  box.appendChild(build(preview(text) + ' …'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    full = !full;
    box.replaceChild(build(full ? text : preview(text) + ' …'), box.firstChild);
    btn.textContent = full ? 'Show less' : label;
  });
  box.appendChild(btn);
  return box;
}
// Folded away: only a "Show all" button until clicked (harness text and thinking show their first line in the header).
function folded(text, build) {
  text = String(text);
  const box = el('div', 'txt');
  const label = 'Show all (' + fmtNum(countLines(text)) + ' lines, ' + fmtNum(text.length) + ' chars)';
  const btn = el('button', 'more', label);
  btn.type = 'button';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (box.childNodes.length > 1) { box.removeChild(box.firstChild); btn.textContent = label; }
    else { box.insertBefore(build(text), btn); btn.textContent = 'Show less'; }
  });
  box.appendChild(btn);
  return box;
}
// Proportional text, ``` fenced spans in monospace; whitespace preserved; markdown not rendered.
function proseNode(s) {
  const d = el('div', 'prose');
  const parts = mask(s).split('```');
  parts.forEach((p, i) => { add(d, i % 2 ? el('span', 'fence', '```' + p + (i < parts.length - 1 ? '```' : '')) : p); });
  return d;
}
function monoNode(s) { return el('pre', 'mono', mask(s)); }
function prose(text) { return collapsible(text, proseNode); }
function mono(text) { return collapsible(text, monoNode); }
function json(x) {
  let s;
  try { s = JSON.stringify(x, null, 2); } catch (e) { s = String(x); }
  return mono(s === undefined ? 'undefined' : s);
}
// Base64 payloads are summarized, never shown.
function stripBase64(x) {
  if (Array.isArray(x)) return x.map(stripBase64);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (k === 'data' && typeof v === 'string' && v.length > 100 && (x.type === 'base64' || x.media_type)) {
        o[k] = '[' + (x.media_type || 'base64') + ', ' + fmtBytes(Math.round(v.length * 3 / 4)) + ']';
      } else o[k] = stripBase64(v);
    }
    return o;
  }
  return x;
}

// ---------------------------------------------------------------------------
// cards: coloured left border, icon, text label and data-kind

function card(kind, label, extra, body, opts) {
  opts = opts || {};
  const c = el('div', 'card k-' + kind + (opts.error ? ' is-error' : ''));
  c.dataset.kind = kind;
  const h = el('div', 'card-h', el('span', 'icon', KINDS[kind] || '•'), el('span', 'label', mask(label)));
  if (opts.error) h.appendChild(el('span', 'err', 'ERROR'));
  if (extra != null && extra !== '') h.appendChild(el('span', 'card-x', typeof extra === 'string' ? mask(extra) : extra));
  if (opts.after) add(h, opts.after);
  c.appendChild(h);
  if (body) c.appendChild(el('div', 'card-b', body));
  return c;
}

function harnessInner(seg) {
  const open = seg.tag.length + 2, close = seg.tag.length + 3;
  return seg.text.slice(open, seg.text.length - close).replace(/^\n+/, '');
}
function harnessCard(seg, ctx) {
  // Collapsed to its first line; the whole tagged text on demand.
  const inner = harnessInner(seg);
  const first = (inner.split('\n').find((l) => l.trim()) || '').trim();
  let label = 'HARNESS · ' + seg.tag, after = null;
  if (seg.tag === 'task-notification' || seg.text.indexOf('<task-notification>') !== -1) {
    label = 'HARNESS · subagent result';
    const t = ctx && ctx.agentThread(seg.text);
    if (t) after = pill(t.key, t.name, t.name, 'filter to ' + t.name);
  }
  return card('harness', label, cut(first, 120), folded(seg.text, monoNode), {after: after});
}
function plainHarnessCard(text) {
  return card('harness', 'HARNESS', cut(oneLine(text), 120), prose(text));
}

// User text: tagged spans are HARNESS, the rest YOU (main), TASK (subagent) or HARNESS (side).
function userTextCards(text, ctx, isFirstMsg) {
  const out = [];
  for (const seg of segments(text)) {
    if (seg.harness) { out.push(harnessCard(seg, ctx)); continue; }
    const kind = ctx.userKind;
    if (kind === 'harness') out.push(plainHarnessCard(seg.text));
    else if (kind === 'task') {
      const p = ctx.summary.parent;
      const link = p && isFirstMsg ? el('span', 'muted', 'from ', exLink(p.xid), ' · CALL · Agent "', mask(cut(oneLine(p.description || ''), 60)), '"') : null;
      out.push(card('task', 'TASK', '', prose(seg.text), {after: link}));
    } else out.push(card('you', 'YOU', '', prose(seg.text)));
  }
  return out;
}

// Tool output: split into the output itself (monospace) and appended harness text.
function resultBody(block, ctx) {
  const parts = [];
  const c = block.content;
  const items = typeof c === 'string' ? [{type: 'text', text: c}] : (Array.isArray(c) ? c : []);
  if (!items.length) parts.push(el('div', 'note', '(empty result)'));
  for (const b of items) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      for (const seg of segments(b.text)) parts.push(seg.harness ? harnessCard(seg, ctx) : mono(seg.text));
    } else parts.push(otherCard(b));
  }
  return parts;
}
function resultCard(block, call, fromId, ctx) {
  const name = call ? call.name : '?';
  const extra = el('span', '', call && call.arg ? mask(call.arg) : '');
  const after = fromId ? el('span', 'muted', '· from ', exLink(fromId)) : null;
  return card('result', 'RESULT · ' + name, extra, el('div', '', resultBody(block, ctx)),
    {error: !!block.is_error, after: after});
}
function callCard(block, ctx) {
  const arg = mainArg(block.input);
  let body;
  if (block.input_error) body = mono(block.input_raw || '');
  else if (block.streaming && block.input_partial != null) body = mono(block.input_partial || '…');
  else body = json(block.input === undefined ? {} : block.input);
  let after = null;
  const r = ctx && ctx.results && ctx.results[block.id];
  if (r && r.child) {
    const name = r.child.split('/').pop();
    after = el('span', 'muted', '→ ', pill(r.child, name, name, 'subagent thread'));
  }
  return card('call', 'CALL · ' + (block.name || '?'), arg, body, {after: after});
}
function thinkingCard(block, tokens) {
  if (block.type === 'redacted_thinking') return card('thinking', 'THINKING', '', el('span', 'chipnote', 'redacted thinking'));
  const text = block.thinking || '';
  if (!text.trim()) {
    const n = block.estimated_tokens || tokens;
    return card('thinking', 'THINKING', '', el('span', 'chipnote', 'thinking hidden' + (n ? ' · ' + fmtNum(n) + ' tokens' : '')));
  }
  return card('thinking', 'THINKING', cut(oneLine(text), 100), folded(text, proseNode));
}
function otherCard(block) {
  const type = block && block.type ? block.type : typeof block;
  return card('other', 'OTHER · ' + type, '', json(stripBase64(block)));
}
function modelCard(block) {
  return card('model', 'MODEL', '', prose(block.text || ''));
}

// ---------------------------------------------------------------------------
// messages

function makeCtx(d, s) {
  const body = d.body && typeof d.body === 'object' ? d.body : null;
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  const useMap = {};
  msgs.forEach((m, i) => {
    if (m && m.role === 'assistant') {
      for (const b of blocksOf(m)) {
        if (b && b.type === 'tool_use') useMap[b.id] = {name: b.name, input: b.input, arg: mainArg(b.input), msgIndex: i};
      }
    }
  });
  const agents = d.agents || {};
  return {
    d: d, s: s, summary: s, body: body, msgs: msgs, useMap: useMap,
    results: d.results || {}, asstSrc: d.asst_src || {},
    userKind: s.thread_kind === 'sub' ? 'task' : (s.thread_kind === 'side' ? 'harness' : 'you'),
    agentThread(text) {
      for (const aid of Object.keys(agents)) if (aid && text.indexOf(aid) !== -1) return agents[aid];
      return null;
    },
  };
}

function blockCards(b, role, ctx, msgIndex) {
  if (!b || typeof b !== 'object') return [otherCard(b)];
  if (role !== 'assistant') {
    if (b.type === 'text') return userTextCards(String(b.text || ''), ctx, msgIndex === 0);
    if (b.type === 'tool_result') {
      const call = ctx.useMap[b.tool_use_id];
      const from = call ? ctx.asstSrc[call.msgIndex] : null;
      const hdr = el('div', 'callhdr', 'CALL · ' + (call ? call.name : '?') + (call && call.arg ? ' ' + mask(call.arg) : ''),
        from ? [' · from ', exLink(from)] : null);
      return [hdr, resultCard(b, call, null, ctx)];
    }
    return [otherCard(b)];
  }
  if (b.type === 'text') return [modelCard(b)];
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return [thinkingCard(b)];
  if (b.type === 'tool_use') return [callCard(b, ctx)];
  return [otherCard(b)];
}

function msgEl(m, i, ctx, isNew) {
  const isModel = m && m.role === 'assistant';
  const w = el('div', 'msg ' + (isModel ? 'msg-model' : 'msg-agent'));
  const h = el('div', 'msg-h');
  if (isModel) {
    h.appendChild(document.createTextNode('MODEL'));
    const src = ctx.asstSrc[i];
    if (src) {
      const ss = S.ex.get(src);
      add(h, [' · ', exLink(src), ss && ss.stop_reason ? ' · ' + ss.stop_reason : '']);
    }
  } else h.appendChild(document.createTextNode('AGENT → MODEL'));
  h.appendChild(el('span', 'muted', 'message ' + i));
  if (isNew) h.appendChild(el('span', 'newtag', 'NEW'));
  w.appendChild(h);
  for (const b of blocksOf(m)) add(w, blockCards(b, m && m.role, ctx, i));
  return w;
}

// ---------------------------------------------------------------------------
// detail sections

function section(name, title, meta, render) {
  const open = Object.prototype.hasOwnProperty.call(S.open, name) ? !!S.open[name] : !!DEFAULT_OPEN[name];
  const wrap = el('section', 'sec');
  wrap.dataset.section = name;
  const tri = el('span', 'tri', '');
  const btn = el('button', 'sec-h', tri, el('span', 'sec-t', title), el('span', 'sec-m', mask(meta || '')));
  btn.type = 'button';
  const body = el('div', 'sec-b');
  let rendered = false;
  function apply(o) {
    tri.textContent = o ? '▼' : '▶';
    body.hidden = !o;
    if (o && !rendered) { rendered = true; render(body); }   // closed sections render only when opened
  }
  btn.addEventListener('click', () => { const o = body.hidden; S.open[name] = o; saveOpen(); apply(o); });
  apply(open);
  wrap.appendChild(btn);
  wrap.appendChild(body);
  return wrap;
}

function flagEl(f) {
  const e = el('span', 'flag ' + (f.level || ''));
  if (f.code === 'retry' && f.ref) add(e, ['retry of ', exLink(f.ref)]);
  else add(e, mask(f.text));
  return e;
}

function renderSummary(box, ctx) {
  const s = ctx.s, t = s.tokens;
  const kv = el('div', 'kv');
  const row = (k, v) => { kv.appendChild(el('div', 'k', k)); kv.appendChild(el('div', 'v', v)); };
  row('model', mask(s.model || '-'));
  row('status', [String(s.status == null ? '-' : s.status), ' ', mask(s.reason || ''), ' · ', s.state]);
  row('stop reason', s.stop_reason || '-');
  row('request', mask(s.method + ' ' + s.path));
  if (s.thread) {
    row('thread', [s.session ? s.session + ' ' : '', pill(s.thread_key, s.thread, s.thread), ' ', mask(s.thread_title || ''),
      s.parent ? [' · started by ', exLink(s.parent.xid), ' CALL · Agent'] : null]);
  }
  const first = s.t_first || s.t_headers;
  row('timing', 'start ' + fmtTime(s.t_start) + ' · first byte ' + (first ? '+' + fmtDur(first - s.t_start) : '-') +
    ' · total ' + (s.t_end ? fmtDur(s.t_end - s.t_start) : 'running'));
  if (t) {
    row('in', fmtNum(t.in) + ' = input ' + fmtNum(t.input) + ' + cache read ' + fmtNum(t.cache_read) +
      ' + cache write ' + fmtNum(t.cache_write) + ' (' + pct(t.cached) + ' cached)');
    row('out', fmtNum(t.out) + (t.thinking != null ? ' (' + fmtNum(t.thinking) + ' thinking)' : ''));
  }
  row('size', 'request ' + fmtBytes(s.req_size) + ' · reply ' + fmtBytes(s.reply_size));
  if (s.flags && s.flags.length) row('flags', s.flags.map(flagEl));
  if (s.error) row('error', el('span', 'flag red', mask(s.error)));
  box.appendChild(kv);
}

function renderNew(box, ctx) {
  const s = ctx.s, d = ctx.d;
  if (d.evicted) { box.appendChild(el('div', 'note', 'Bodies evicted (memory limit); only the summary is kept.')); return; }
  if (s.reply_of) box.appendChild(el('div', 'note', '↳ reply of ', exLink(s.reply_of), ' (shown in that exchange)'));
  if (s.retry_of) box.appendChild(el('div', 'note', 'retry of ', exLink(s.retry_of), ': the same messages'));
  if (s.history_at != null) box.appendChild(el('div', 'note', 'history changed at message ' + s.history_at + ': shown from there'));
  let n = 0;
  for (let i = d.new_start || 0; i < ctx.msgs.length; i++) {
    const m = ctx.msgs[i];
    for (const b of blocksOf(m)) { add(box, blockCards(b, m && m.role, ctx, i)); n++; }
  }
  if (!n) box.appendChild(el('div', 'note', ctx.body ? '(no new messages)' : '(no JSON body)'));
}

function renderReply(box, ctx) {
  box.textContent = '';
  const s = ctx.s, r = ctx.d.reply || {};
  const blocks = r.blocks || [];
  const u = r.usage || {};
  const thinkTok = u.output_tokens_details ? u.output_tokens_details.thinking_tokens : null;
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      box.appendChild(callCard(b, ctx));
      const res = ctx.results[b.id];
      const j = el('div', 'joined');
      if (res && res.block) j.appendChild(resultCard(res.block, {name: b.name, arg: mainArg(b.input)}, res.from, ctx));
      else if (res && res.state === 'none') j.appendChild(el('span', 'chipnote amber', 'no result'));
      else if (!b.streaming) j.appendChild(el('span', 'chipnote', 'waiting for result'));
      box.appendChild(j);
    } else if (b.type === 'text') box.appendChild(modelCard(b));
    else if (b.type === 'thinking' || b.type === 'redacted_thinking') box.appendChild(thinkingCard(b, thinkTok));
    else box.appendChild(otherCard(b));
  }
  if (r.error) box.appendChild(card('other', 'OTHER · error', '', json(r.error), {error: true}));
  if (s.state === 'pending' || s.state === 'streaming') box.appendChild(el('div', 'note', el('span', 'spin'), ' streaming…'));
  else if (!blocks.length && !r.error) box.appendChild(el('div', 'note', s.error ? mask(s.error) : '(no content)'));
}

function renderConvReply(box, ctx) {
  box.textContent = '';
  const r = ctx.d.reply;
  if (!r || !(r.blocks || []).length) return;
  const w = el('div', 'msg msg-model');
  w.appendChild(el('div', 'msg-h', 'MODEL · #' + ctx.s.id + (r.stop_reason ? ' · ' + r.stop_reason : ''),
    el('span', 'muted', 'this reply'), el('span', 'newtag', 'NEW')));
  for (const b of r.blocks) add(w, blockCards(b, 'assistant', ctx, -1));
  box.appendChild(w);
}

function renderConversation(box, ctx) {
  const d = ctx.d;
  if (d.evicted) { box.appendChild(el('div', 'note', 'Bodies evicted (memory limit).')); return; }
  ctx.msgs.forEach((m, i) => box.appendChild(msgEl(m, i, ctx, i >= (d.new_start || 0))));
  const rb = el('div', '');
  S.convReplyBox = rb;
  renderConvReply(rb, ctx);
  box.appendChild(rb);
}

function systemBlocks(body) {
  const sys = body && body.system;
  if (typeof sys === 'string') return [{type: 'text', text: sys}];
  return Array.isArray(sys) ? sys : [];
}
function renderSystem(box, ctx) {
  systemBlocks(ctx.body).forEach((b, i) => {
    const text = typeof b.text === 'string' ? b.text : JSON.stringify(b, null, 2);
    // every block in full, with its size
    box.appendChild(card('system', 'SYSTEM', 'block ' + (i + 1) + ' · ' + fmtNum(text.length) + ' chars', proseNode(text)));
  });
}
function renderTools(box, ctx) {
  const tools = ctx.body && Array.isArray(ctx.body.tools) ? ctx.body.tools : [];
  for (const t of tools) {
    const det = el('details', 'tool', el('summary', '', mask(t && t.name ? t.name : '?'),
      el('span', 'muted', ' · ' + fmtNum(String((t && t.description) || '').length) + ' chars')));
    let done = false;
    det.addEventListener('toggle', () => {
      if (!det.open || done) return;
      done = true;
      if (t && t.input_schema !== undefined) {
        add(det, [el('h4', '', 'description'), prose(String(t.description || '')), el('h4', '', 'input schema'), json(t.input_schema)]);
      } else add(det, json(t));
    });
    box.appendChild(det);
  }
}
function headersText(h) { return (h || []).map((kv) => kv[0] + ': ' + kv[1]).join('\n') || '(none)'; }
function renderRaw(box, ctx) {
  const d = ctx.d;
  add(box, [el('h4', '', 'Request headers'), mono(headersText(d.req_headers))]);
  add(box, el('h4', '', 'Request body'));
  if (d.evicted) add(box, el('div', 'note', 'evicted'));
  else if (d.body != null) add(box, json(d.body));
  else add(box, mono(d.body_text || '(empty)'));
  add(box, [el('h4', '', 'Response headers'), mono(headersText(d.resp_headers))]);
  add(box, el('h4', '', 'Raw reply'));
  add(box, d.evicted ? el('div', 'note', 'evicted') : mono(d.raw || '(empty)'));
}

// ---------------------------------------------------------------------------
// detail pane

function headerEl(s) {
  const t = s.tokens;
  const live = s.state === 'pending' || s.state === 'streaming';
  let dur;
  if (live) { dur = el('span', 'elapsed', fmtDur(Date.now() / 1000 - s.t_start)); dur.dataset.start = String(s.t_start); }
  else dur = s.t_end ? fmtDur(s.t_end - s.t_start) : '-';
  const sep = () => el('span', 'muted', '·');
  const tp = s.thread ? pill(s.thread_key, s.thread, s.thread, s.thread_title ? s.thread + ': ' + s.thread_title : s.thread) : null;
  const h1 = el('div', 'dh1', '#' + s.id, sep(), s.session || '', tp,
    s.thread_title ? el('span', 'ttl', mask(cut(s.thread_title, 60))) : null, sep(),
    mask(s.model || s.method), sep(), String(s.status == null ? s.state : s.status), sep(), dur,
    live ? el('span', 'spin') : null, el('span', 'paint', ''));
  const h2 = el('div', 'dh2', t ? 'in ' + fmtNum(t.in) + ' (' + pct(t.cached) + ' cached) · out ' + fmtNum(t.out) +
    (t.thinking != null ? ' (' + fmtNum(t.thinking) + ' thinking)' : '') : mask(s.method + ' ' + s.path));
  return el('div', 'dh', h1, h2);
}

function renderDetail(keepScroll) {
  const pane = $('detail');
  const top = pane.scrollTop;
  const d = S.detail.data;
  const s = S.ex.get(S.detail.id) || d.summary;
  const ctx = makeCtx(d, s);
  S.ctx = ctx;
  S.replyBox = null;
  S.convReplyBox = null;
  pane.textContent = '';
  pane.appendChild(headerEl(s));
  pane.appendChild(section('summary', 'Summary', [s.model, s.status, s.stop_reason].filter((x) => x != null).join(' · '),
    (b) => renderSummary(b, ctx)));
  if (s.is_message) {
    const nNew = Math.max(0, ctx.msgs.length - (d.new_start || 0));
    pane.appendChild(section('new', 'New in this request', nNew + ' message' + (nNew === 1 ? '' : 's'), (b) => renderNew(b, ctx)));
    const r = d.reply || {};
    const rmeta = (r.blocks || []).length + ' blocks' + (r.stop_reason ? ' · ' + r.stop_reason : '') +
      (s.state === 'streaming' || s.state === 'pending' ? ' · streaming' : '');
    pane.appendChild(section('reply', 'Reply', rmeta, (b) => { S.replyBox = b; renderReply(b, ctx); }));
    const nConv = ctx.msgs.length + ((r.blocks || []).length ? 1 : 0);
    pane.appendChild(section('conversation', 'Conversation', nConv + ' messages', (b) => renderConversation(b, ctx)));
    const sys = systemBlocks(ctx.body);
    const chars = sys.reduce((a, b) => a + (typeof b.text === 'string' ? b.text.length : 0), 0);
    pane.appendChild(section('system', 'System instructions', sys.length + ' blocks · ' + fmtNum(chars) + ' chars',
      (b) => renderSystem(b, ctx)));
    const tools = ctx.body && Array.isArray(ctx.body.tools) ? ctx.body.tools : [];
    const names = tools.map((t) => (t && t.name) || '?');
    pane.appendChild(section('tools', 'Tools (' + tools.length + ')', names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : ''),
      (b) => renderTools(b, ctx)));
  } else if ((d.reply && (d.reply.blocks || []).length) || (d.reply && d.reply.error)) {
    pane.appendChild(section('reply', 'Reply', '', (b) => { S.replyBox = b; renderReply(b, ctx); }));
  }
  pane.appendChild(section('raw', 'Raw', 'request ' + fmtBytes(s.req_size) + ' · reply ' + fmtBytes(s.reply_size),
    (b) => renderRaw(b, ctx)));
  if (keepScroll) pane.scrollTop = top;
}

function detailKey(s) {
  if (!s) return '';
  return [s.state, s.status, s.thread_title, s.evicted, s.stop_reason, (s.flags || []).length,
    (s.calls || []).map((c) => c.state + ':' + c.from + ':' + c.child).join(',')].join('|');
}

async function loadDetail(id, keepScroll) {
  const seq = ++S.loadSeq;
  let d;
  try {
    const res = await fetch('/api/exchanges/' + id, {cache: 'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    d = await res.json();
  } catch (e) {
    if (seq === S.loadSeq && S.selected === id) {
      const pane = $('detail');
      pane.textContent = '';
      pane.appendChild(el('div', 'placeholder', 'Could not load #' + id + ': ' + e.message));
    }
    return;
  }
  if (seq !== S.loadSeq || S.selected !== id) return;
  if (addMaskIds(d.mask_ids) && S.privacy) rebuildTimeline();
  const cur = S.ex.get(id);
  if (d.summary && (!cur || cur.version < d.summary.version)) S.ex.set(id, d.summary);
  const s = S.ex.get(id) || d.summary;
  S.detail = {id: id, data: d, key: detailKey(s)};
  renderDetail(keepScroll);
  if (!keepScroll) {
    const t0 = S.selectT0;
    requestAnimationFrame(() => {
      const ms = performance.now() - t0;
      window.__lastOpenMs = ms;   // sections 1-3 painted (check 8)
      const p = document.querySelector('#detail .paint');
      if (p) p.textContent = 'opened in ' + Math.round(ms) + ' ms';
    });
  }
}

function checkDetail(s) {
  // A changed state, call results or title re-fetches the open detail.
  if (!S.detail || S.detail.id !== s.id) return;
  if (detailKey(s) === S.detail.key) return;
  S.detail.key = detailKey(s);
  clearTimeout(S.refetchTimer);
  S.refetchTimer = setTimeout(() => { if (S.selected === s.id) loadDetail(s.id, true); }, 100);
}

function onReply(r) {
  if (!S.detail || S.detail.id !== r.id || !S.ctx) return;
  S.detail.data.reply = r.reply;
  if (S.replyBox && S.replyBox.isConnected) renderReply(S.replyBox, S.ctx);
  if (S.convReplyBox && S.convReplyBox.isConnected) renderConvReply(S.convReplyBox, S.ctx);
}

// ---------------------------------------------------------------------------
// timeline (newest first)

function passes(s) {
  if (S.hideNonMessage && !s.is_message) return false;
  if (S.thread && s.thread_key !== S.thread) return false;
  if (S.errorsOnly && !(s.red || s.dot)) return false;
  return true;
}
function newestPassing() {
  for (let i = S.ids.length - 1; i >= 0; i--) if (passes(S.ex.get(S.ids[i]))) return S.ids[i];
  return null;
}

function stateEl(s) {
  if (s.state === 'pending' || s.state === 'streaming') {
    const t = el('span', 'elapsed', fmtDur(Date.now() / 1000 - s.t_start));
    t.dataset.start = String(s.t_start);
    const e = el('span', 'rstate s-' + s.state, el('span', 'spin'), ' ', t);
    e.title = s.state;
    return e;
  }
  const sym = s.state === 'done' ? '✓' : (s.state === 'aborted' ? '⏹ aborted' : '✕');
  const code = s.status != null && (s.status >= 300 || s.state !== 'done') ? ' ' + s.status : '';
  const e = el('span', 'rstate s-' + s.state, sym + code + ' ' + (s.t_end ? fmtDur(s.t_end - s.t_start) : ''));
  e.title = s.state + (s.status != null ? ' · HTTP ' + s.status : '');
  return e;
}
function lineEl(arrow, line) {
  const d = el('div', 'rline', el('span', 'arrow', arrow));
  if (line) add(d, [el('span', 'lbl k-' + line.kind, line.label), ' ', mask(line.text)]);
  else add(d, el('span', 'muted', '…'));
  return d;
}
function rowEl(s) {
  const r = el('div', 'row' + (s.red ? ' red' : (s.amber ? ' amber' : '')) + (s.id === S.selected ? ' sel' : ''));
  r.dataset.id = String(s.id);
  r.setAttribute('role', 'listitem');
  const t = s.tokens;
  const dot = s.dot ? el('span', 'rdot') : null;
  if (dot) dot.title = 'a tool_result in this request has is_error';
  r.appendChild(el('div', 'rhead', el('span', 'rid', '#' + s.id), el('span', 'rtime', fmtTime(s.t_start)),
    s.thread ? summaryPill(s) : null, stateEl(s), t ? el('span', 'rtok', fmtK(t.in) + '/' + fmtK(t.out)) : null, dot));
  if (s.is_message) {
    r.appendChild(lineEl('↑', s.up));
    r.appendChild(lineEl('↓', s.down));
  } else {
    r.appendChild(el('div', 'rline nm', mask(s.method + ' ' + s.path + ' ' + (s.status == null ? '…' : s.status))));
  }
  return r;
}

function rebuildTimeline() {
  const tl = $('timeline');
  tl.textContent = '';
  S.rows.clear();
  const frag = document.createDocumentFragment();
  for (let i = S.ids.length - 1; i >= 0; i--) {
    const s = S.ex.get(S.ids[i]);
    if (!passes(s)) continue;
    const r = rowEl(s);
    S.rows.set(s.id, r);
    frag.appendChild(r);
  }
  tl.appendChild(frag);
  if (!S.rows.size) tl.appendChild(el('div', 'placeholder', S.ex.size ? 'No exchange matches the filters.' : 'Waiting for traffic…'));
}
function placeRow(s) {
  const tl = $('timeline');
  const r = rowEl(s);
  const old = S.rows.get(s.id);
  if (old) { tl.replaceChild(r, old); S.rows.set(s.id, r); return false; }
  const ph = tl.querySelector('.placeholder');
  if (ph) ph.remove();
  let before = null;
  for (let c = tl.firstElementChild; c; c = c.nextElementSibling) {
    if (Number(c.dataset.id) < s.id) { before = c; break; }
  }
  tl.insertBefore(r, before);
  S.rows.set(s.id, r);
  return true;
}
function removeRow(id) {
  const r = S.rows.get(id);
  if (r) { r.remove(); S.rows.delete(id); }
}

// ---------------------------------------------------------------------------
// top bar, follow live, filters

function setConn(on) {
  const c = $('conn');
  c.textContent = on ? '● live' : '● reconnecting';
  c.className = 'conn ' + (on ? 'on' : 'off');
}
let pillSig = '';
function renderTop() {
  let n = 0, tin = 0, cr = 0, tout = 0, errs = 0;
  const threads = new Map();
  for (const id of S.ids) {
    const s = S.ex.get(id);
    if (s.thread_key && !threads.has(s.thread_key)) threads.set(s.thread_key, s);
    else if (s.thread_key && s.thread_title && !threads.get(s.thread_key).thread_title) threads.set(s.thread_key, s);
    if (!passes(s)) continue;
    n++;
    if (s.tokens) { tin += s.tokens.in || 0; cr += s.tokens.cache_read || 0; tout += s.tokens.out || 0; }
    if (s.red || s.dot) errs++;
  }
  $('totals').textContent = n + ' req · in ' + fmtK(tin) + ' (' + (tin ? Math.round(cr / tin * 100) : 0) +
    '% cached) · out ' + fmtK(tout);
  const eb = $('errs');
  eb.textContent = errs + ' error' + (errs === 1 ? '' : 's');
  eb.className = 'errs' + (errs ? ' has' : '') + (S.errorsOnly ? ' active' : '');
  const list = Array.from(threads.values());
  const sig = list.map((s) => s.thread_key + '=' + threadLabel(s) + '=' + s.thread_title).join('|') + '#' + S.thread + S.privacy;
  if (sig === pillSig) return;
  pillSig = sig;
  const box = $('pills');
  box.textContent = '';
  for (const s of list) box.appendChild(summaryPill(s));
  if (S.thread) {
    const all = el('button', 'pill p-all', 'all threads');
    all.type = 'button';
    all.dataset.thread = '';
    box.appendChild(all);
  }
}
function renderChip() {
  const c = $('chip');
  c.hidden = S.follow || S.newCount === 0;
  c.textContent = S.newCount + ' new ↑';
}
function setFollow(on) {
  S.follow = on;
  $('opt-follow').checked = on;
  if (on) {
    S.newCount = 0;
    $('timeline').scrollTop = 0;
    const nw = newestPassing();
    if (nw != null && nw !== S.selected) select(nw, false);
  }
  renderChip();
}
function filtersChanged() {
  rebuildTimeline();
  pillSig = '';
  renderTop();
  if (S.follow) {
    $('timeline').scrollTop = 0;
    const nw = newestPassing();
    if (nw != null && nw !== S.selected) select(nw, false);
  }
}
function setThread(key) {
  S.thread = (!key || S.thread === key) ? null : key;
  filtersChanged();
}
function setErrorsOnly(on) {
  S.errorsOnly = on;
  $('opt-errors').checked = on;
  filtersChanged();
}

function select(id, byUser) {
  if (byUser && S.follow) setFollow(false);
  if (S.selected === id && S.detail && S.detail.id === id) return;
  const old = S.rows.get(S.selected);
  if (old) old.classList.remove('sel');
  S.selected = id;
  const r = S.rows.get(id);
  if (r) r.classList.add('sel');
  S.selectT0 = performance.now();
  loadDetail(id, false);
}
function gotoExchange(id) {
  if (!S.ex.has(id)) return;
  select(id, true);
  const r = S.rows.get(id);
  if (r) r.scrollIntoView({block: 'nearest'});
}

// ---------------------------------------------------------------------------
// live data: the list, then Server-Sent Events

function insertId(id) {
  const a = S.ids;
  if (!a.length || a[a.length - 1] < id) { a.push(id); return; }
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < id) lo = mid + 1; else hi = mid; }
  a.splice(lo, 0, id);
}
function upsert(s, live) {
  const old = S.ex.get(s.id);
  if (old && old.version >= s.version) return;   // keep the higher version
  S.ex.set(s.id, s);
  if (!old) { insertId(s.id); if (live) S.fresh.add(s.id); }
  S.pending.add(s.id);
  checkDetail(s);
  schedule();
}
function schedule() { if (!S.frame) S.frame = requestAnimationFrame(flush); }
function flush() {
  S.frame = 0;
  const tl = $('timeline');
  const ids = Array.from(S.pending).sort((a, b) => a - b);
  const fresh = S.fresh;
  S.pending = new Set();
  S.fresh = new Set();
  const beforeH = tl.scrollHeight, beforeTop = tl.scrollTop;
  for (const id of ids) {
    const s = S.ex.get(id);
    if (passes(s)) {
      if (placeRow(s) && fresh.has(id) && !S.follow) S.newCount++;
    } else removeRow(id);
  }
  if (S.follow) {
    if (tl.scrollTop !== 0) tl.scrollTop = 0;
    const nw = newestPassing();
    if (nw != null && nw !== S.selected) select(nw, false);
  } else {
    const delta = tl.scrollHeight - beforeH;   // rows added above: keep the view where it was
    if (delta) tl.scrollTop = beforeTop + delta;
  }
  renderChip();
  renderTop();
}
function resetAll() {
  S.ex.clear(); S.ids = []; S.rows.clear(); S.selected = null; S.detail = null; S.ctx = null;
  S.newCount = 0; S.pending.clear(); S.fresh.clear();
  rebuildTimeline();
  const pane = $('detail');
  pane.textContent = '';
  pane.appendChild(el('div', 'placeholder', 'The monitor restarted. Waiting for traffic…'));
  pillSig = '';
  renderTop();
}
async function loadList() {
  try {
    const res = await fetch('/api/exchanges', {cache: 'no-store'});
    const d = await res.json();
    if (d.boot && S.boot && d.boot !== S.boot) return;
    addMaskIds(d.mask_ids);
    const live = !!S.loaded;
    for (const s of d.exchanges || []) upsert(s, live);
    S.loaded = true;
    schedule();
  } catch (e) { /* the stream's reconnect will retry */ }
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('hello', (e) => {
    let h = {};
    try { h = JSON.parse(e.data); } catch (err) { /* ignore */ }
    if (S.boot && h.boot && h.boot !== S.boot) { resetAll(); S.loaded = false; }
    S.boot = h.boot || S.boot;
    setConn(true);
    loadList();   // on load and on every reconnect
  });
  es.addEventListener('exchange', (e) => { try { upsert(JSON.parse(e.data), true); } catch (err) { /* ignore */ } });
  es.addEventListener('reply', (e) => { try { onReply(JSON.parse(e.data)); } catch (err) { /* ignore */ } });
}

// ---------------------------------------------------------------------------
// wiring

function init() {
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const p = t.closest('.pill[data-thread]');
    if (p) { e.preventDefault(); e.stopPropagation(); setThread(p.dataset.thread); return; }
    const g = t.closest('[data-goto]');
    if (g) { e.preventDefault(); e.stopPropagation(); gotoExchange(Number(g.dataset.goto)); return; }
    const r = t.closest('.row');
    if (r && r.dataset.id && $('timeline').contains(r)) select(Number(r.dataset.id), true);
  });
  const tl = $('timeline');
  tl.addEventListener('scroll', () => { if (S.follow && tl.scrollTop > 8) setFollow(false); });
  $('chip').addEventListener('click', () => setFollow(true));
  $('opt-follow').addEventListener('change', (e) => setFollow(e.target.checked));
  $('opt-errors').addEventListener('change', (e) => setErrorsOnly(e.target.checked));
  $('errs').addEventListener('click', () => setErrorsOnly(!S.errorsOnly));
  $('opt-hide').addEventListener('change', (e) => { S.hideNonMessage = e.target.checked; filtersChanged(); });
  $('opt-privacy').addEventListener('change', (e) => {
    S.privacy = e.target.checked;
    rebuildTimeline();
    pillSig = '';
    renderTop();
    if (S.detail) renderDetail(true);
  });
  // the checkboxes may keep old states after a reload: the page state follows them
  S.follow = $('opt-follow').checked;
  S.errorsOnly = $('opt-errors').checked;
  S.hideNonMessage = $('opt-hide').checked;
  S.privacy = $('opt-privacy').checked;
  setInterval(() => {
    const now = Date.now() / 1000;
    const list = document.querySelectorAll('.elapsed[data-start]');
    for (let i = 0; i < list.length; i++) list[i].textContent = fmtDur(now - Number(list[i].dataset.start));
  }, 250);
  rebuildTimeline();
  renderTop();
  connect();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
