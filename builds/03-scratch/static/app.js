'use strict';
// Agent traffic dashboard. All traffic content goes in through textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const S = { ex: new Map(), sel: null, follow: true, boot: null, detail: null, newCount: 0,
  thread: null, errors: false, hide: true, privacy: true, lanes: true, stats: false, detailVer: -1 };
const OPEN = new Map();
const KIND = { you: ['YOU', '✎'], task: ['TASK', '➜'], harness: ['HARNESS', '⚙'], model: ['MODEL', '✦'], thinking: ['THINKING', '…'],
  call: ['CALL', '▶'], result: ['RESULT', '◀'], system: ['SYSTEM', '■'], other: ['OTHER', '?'] };
const ANAT = ['system', 'tools', 'harness', 'earlier', 'new'];
const ANAT_COL = { system: '#334155', tools: '#b45309', harness: '#9ca3af', earlier: '#cbd5e1', new: '#2563eb' };

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

function h(tag, props, ...kids) {
  const parts = tag.split('.');
  const el = document.createElement(parts[0] || 'div');
  if (parts.length > 1) el.className = parts.slice(1).join(' ');
  if (props) for (const k in props) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX64 = /\b[0-9a-f]{64}\b/gi;
function P(s) {
  s = s == null ? '' : String(s);
  return S.privacy ? s.replace(EMAIL, '•••@•••').replace(UUID, '•••').replace(HEX64, '•••') : s;
}
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
const fmtTime = (t) => (t ? new Date(t * 1000).toTimeString().slice(0, 8) : '–');
const fmtDur = (s) => (s == null ? '–' : s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's');
const now = () => Date.now() / 1000;
const durOf = (e) => (e.t_end ? e.t_end : now()) - e.t0;
const live = (e) => e.state === 'pending' || e.state === 'streaming';
const isErr = (e) => e.red || e.red_dot;
const pct = (x) => Math.round(x * 100) + '%';

function pill(name, extra) {
  let cls = 'pill';
  if (name === 'main') cls += ' main';
  else if (name === 'side') cls += ' side';
  else { const m = /^sub-(\d+)$/.exec(name); if (m) cls += ' p' + ((+m[1] - 1) % 4); }
  if (S.thread === name) cls += ' on';
  return h('span.' + cls.split(' ').join('.'), { text: name, title: 'filter to ' + name, onclick: (ev) => { ev.stopPropagation(); setThread(name); } });
}
function setThread(name) { S.thread = S.thread === name ? null : name; relist(); refresh(); }

// ---------------------------------------------------------------- filters / list
function visible(e) {
  if (S.hide && !e.is_msg) return false;
  if (S.thread && e.thread !== S.thread) return false;
  if (S.errors && !isErr(e)) return false;
  return true;
}
function sortedVisible() { return [...S.ex.values()].filter(visible).sort((a, b) => a.id - b.id); }

function rowEl(e) {
  const cls = ['row']; if (e.red) cls.push('red'); else if (e.amber) cls.push('amber'); if (e.id === S.sel) cls.push('sel');
  const tip = [e.up.title, e.down.title].filter(Boolean).join('\n');
  let stateEl;
  if (live(e)) stateEl = h('span', null, h('span.spin'), ' ' + fmtDur(durOf(e)));
  else if (e.state === 'error') stateEl = h('span.st-bad', { text: '✗ error' });
  else if (e.state === 'aborted') stateEl = h('span.st-amber', { text: '⚠ aborted' });
  else if ((e.status || 0) >= 400) stateEl = h('span.st-bad', { text: '✗ ' + e.status + ' ' + fmtDur(durOf(e)) });
  else stateEl = h('span.st-ok', { text: '✓ ' + fmtDur(durOf(e)) });
  const row = h('div.' + cls.join('.'), { 'data-id': e.id, title: P(tip), onclick: () => { setFollow(false); select(e.id); } });
  const l1 = h('div.l1', null, h('b', { text: '#' + e.id }), h('span.muted', { text: fmtTime(e.t0) }));
  if (e.is_msg) l1.append(pill(e.thread));
  l1.append(stateEl);
  if (e.red_dot) l1.append(h('span.dot', { title: 'a tool result carries an error' }));
  l1.append(h('span.sp'));
  if (e.is_msg) l1.append(h('span.muted.mono', { text: fmtK(e.tokens.in) + '/' + e.tokens.out }));
  row.append(l1);
  if (e.is_msg) {
    row.append(h('div.ln', { text: '↑ ' + P(e.up.text) }));
    row.append(h('div.ln.d', { text: '↓ ' + P(e.down.text || (live(e) ? '…' : '')) }));
    if (e.anatomy) row.append(anatBar(e.anatomy, false));
  } else {
    row.append(h('div.ln.mono', { text: e.method + ' ' + e.path + ' ' + (e.status || e.state) }));
  }
  return row;
}
function anatBar(a, big) {
  const tot = a.total || 1;
  const bar = h('div.abar' + (big ? '.big' : ''));
  for (const k of ANAT) bar.append(h('i.a-' + k, { style: 'width:' + (a[k] / tot * 100).toFixed(2) + '%', title: k + ': ' + fmtN(a[k]) + ' chars' }));
  return bar;
}
function relist() {
  const tl = $('timeline'); tl.replaceChildren();
  for (const e of sortedVisible().reverse()) tl.append(rowEl(e));
}
function upsertRow(e) {
  const tl = $('timeline');
  const old = tl.querySelector('[data-id="' + e.id + '"]');
  if (!visible(e)) { if (old) old.remove(); return false; }
  const el = rowEl(e);
  if (old) { old.replaceWith(el); return false; }
  let before = null;
  for (const c of tl.children) { if (+c.dataset.id < e.id) { before = c; break; } }
  tl.insertBefore(el, before);
  return true;
}

// ---------------------------------------------------------------- state updates
function upsert(e) {
  const old = S.ex.get(e.id);
  if (old && old.version >= e.version) return;
  S.ex.set(e.id, e);
  const isNew = upsertRow(e);
  if (isNew && !S.follow) { S.newCount++; }
  if (e.id === S.sel && (!S.detail || S.detail.summary.id !== e.id || e.version > S.detailVer) && (!live(e) || !old || old.state !== e.state)) loadDetail(e.id);
  refresh();
}
let rafPending = false;
function refresh() {
  if (rafPending) return; rafPending = true;
  requestAnimationFrame(() => { rafPending = false; doRefresh(); });
}
function doRefresh() {
  if (S.follow) {
    const vis = sortedVisible();
    const last = vis.length ? vis[vis.length - 1] : null;
    if (last && last.id !== S.sel) select(last.id);
    S.newCount = 0;
  }
  renderTop(); renderLanes(); if (S.stats) renderStats();
  const chip = $('chip'); chip.hidden = S.follow || S.newCount === 0; chip.textContent = S.newCount + ' new ↑';
}
function setFollow(v) {
  S.follow = v; $('f-follow').checked = v;
  if (v) { S.newCount = 0; $('timeline').scrollTop = 0; }
  refresh();
}
function select(id) {
  if (S.sel === id) return;
  S.sel = id;
  for (const r of $('timeline').children) r.classList.toggle('sel', +r.dataset.id === id);
  S.detail = null; S.detailVer = -1;
  renderDetail();
  loadDetail(id);
}
let detailTimer = null;
function loadDetail(id) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    fetch('/api/exchanges/' + id).then((r) => r.json()).then((d) => {
      if (S.sel !== id || !d.summary) return;
      S.detail = d; S.detailVer = d.summary.version; renderDetail();
    }).catch(() => {});
  }, 30);
}

// ---------------------------------------------------------------- top bar
function renderTop() {
  const vis = [...S.ex.values()].filter(visible);
  let inn = 0, cr = 0, out = 0, errs = 0;
  for (const e of vis) { inn += e.tokens.in; cr += e.tokens.cache_read; out += e.tokens.out; if (isErr(e)) errs++; }
  const t = $('totals'); t.replaceChildren();
  t.append(vis.length + ' req · in ' + fmtK(inn) + ' (' + pct(inn ? cr / inn : 0) + ' cached) · out ' + fmtK(out) + ' · ');
  t.append(h('span.' + (errs ? 'errc' : 'muted'), { id: 'errc', text: errs + (errs === 1 ? ' error' : ' errors'), onclick: () => { S.errors = true; $('f-errors').checked = true; relist(); refresh(); } }));
  const pills = $('pills'); pills.replaceChildren();
  const names = [];
  for (const e of [...S.ex.values()].sort((a, b) => a.id - b.id)) if (e.is_msg && !names.includes(e.thread)) names.push(e.thread);
  for (const n of names) { pills.append(pill(n)); pills.append(' '); }
}

// ---------------------------------------------------------------- lanes
function curSession() {
  const e = S.ex.get(S.sel);
  if (e && e.session != null) return e.session;
  let m = null; for (const x of S.ex.values()) if (x.session != null && (m === null || x.session > m)) m = x.session;
  return m;
}
function renderLanes() {
  const box = $('lanes'); box.hidden = !S.lanes; if (!S.lanes) return;
  const sess = curSession();
  const rows = sortedVisible().filter((e) => e.is_msg && e.session === sess);
  box.replaceChildren();
  if (!rows.length) { box.append(h('span.muted', { text: 'Lanes: no message exchanges yet' })); return; }
  const t0 = Math.min(...rows.map((e) => e.t0)), t1 = Math.max(...rows.map((e) => e.t_end || now()));
  const span = Math.max(t1 - t0, 0.5);
  box.append(h('div.lhead', null, h('span', { text: 'Lanes · S' + sess + ' · ' + fmtTime(t0) }), h('span', { text: fmtDur(span) })));
  const lanes = new Map();
  for (const e of rows) { if (!lanes.has(e.thread_key)) lanes.set(e.thread_key, { name: e.thread, exs: [] }); lanes.get(e.thread_key).exs.push(e); }
  const order = [...lanes.values()].sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.exs[0].t0 - b.exs[0].t0));
  for (const L of order) {
    const lane = h('div.lane', null, h('span.lname', null, pill(L.name)));
    for (const e of L.exs) {
      const end = e.t_end || now();
      const left = (e.t0 - t0) / span * 100, w = Math.max((end - e.t0) / span * 100, 0.3);
      if (e.tool_time != null && e.tool_time > 0) {
        const gl = (e.t0 - e.tool_time - t0) / span * 100;
        lane.append(h('span.gap', { style: 'left:' + gl.toFixed(2) + '%;width:' + (e.tool_time / span * 100).toFixed(2) + '%', text: '⚙ ' + fmtDur(e.tool_time) }));
      }
      const cls = ['bar', e.state]; if (e.red) cls.push('red'); else if (e.amber) cls.push('amber'); if (e.id === S.sel) cls.push('sel');
      const bar = h('div.' + cls.join('.'), { style: 'left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%', title: '#' + e.id + ' ' + e.thread + ' ' + fmtDur(end - e.t0), onclick: () => { setFollow(false); select(e.id); } });
      if (e.t_first) bar.append(h('span.tick', { style: 'left:' + Math.min(100, (e.t_first - e.t0) / Math.max(end - e.t0, 0.001) * 100).toFixed(1) + '%' }));
      lane.append(bar);
    }
    box.append(lane);
  }
}

// ---------------------------------------------------------------- stats
function renderStats() {
  const box = $('stats'); box.replaceChildren();
  const sess = curSession();
  const rows = sortedVisible().filter((e) => e.is_msg && e.session === sess);
  let inp = 0, cr = 0, cw = 0, cw5 = 0, cw1 = 0, out = 0, th = 0, errs = 0, tt = 0, mt = 0;
  const tools = new Map(); let toolErrs = 0;
  for (const e of rows) {
    const t = e.tokens; inp += t.input; cr += t.cache_read; cw += t.cache_write; cw5 += t.cw5; cw1 += t.cw1; out += t.out; th += t.thinking;
    if (isErr(e)) errs++; if (e.tool_time) tt += e.tool_time; mt += durOf(e);
    for (const c of e.calls) { tools.set(c.name, (tools.get(c.name) || 0) + 1); if (c.state === 'error') toolErrs++; }
  }
  const total = inp + cr + cw;
  const cost = inp + 0.1 * cr + 1.25 * cw5 + 2 * cw1 + (cw - cw5 - cw1) * 1.25;
  const saved = total ? 1 - cost / total : 0;
  const tbl = h('table');
  const add = (a, b) => tbl.append(h('tr', null, h('td', { text: a }), h('td.mono', { text: b })));
  add('Session', sess == null ? '–' : 'S' + sess + (S.thread ? ' · thread ' + S.thread : ''));
  add('Requests', String(rows.length));
  add('Input tokens (total)', fmtN(total));
  add('  uncached', fmtN(inp)); add('  cache write', fmtN(cw)); add('  cache read', fmtN(cr));
  add('Output tokens', fmtN(out) + ' (thinking ' + fmtN(th) + ')');
  add('Cache-hit share', pct(total ? cr / total : 0));
  add('Input cost saved by caching', (saved * 100).toFixed(1) + '%');
  add('Errors', errs + ' rows · ' + toolErrs + ' failed tool calls');
  add('Tool time vs model time', fmtDur(tt) + ' vs ' + fmtDur(mt));
  box.append(h('b', { text: 'Stats' }), tbl, h('b', { text: 'Calls per tool' }));
  const mx = Math.max(1, ...tools.values());
  const tb = h('table');
  for (const [n, c] of [...tools.entries()].sort((a, b) => b[1] - a[1])) tb.append(h('tr', null, h('td', { text: n }), h('td', { text: String(c) }), h('td', null, h('span.hbar', { style: 'width:' + (c / mx * 160) + 'px' }))));
  box.append(tools.size ? tb : h('div.muted', { text: 'no tool calls' }));
}

// ---------------------------------------------------------------- rendering helpers
function openKey(k) { return OPEN.get(k) === true; }
function toggleKey(k) { OPEN.set(k, !OPEN.get(k)); renderDetail(); }
function longText(parent, text, key, mono, md) {
  text = text == null ? '' : String(text);
  const lines = text.split('\n');
  const long = lines.length > 10 || text.length > 800;
  const all = openKey(key + '#all');
  const body = h('div.cb' + (mono ? '.mono' : ''));
  if (!long || all) {
    (md ? renderMd(body, P(text)) : body.append(P(text)));
    parent.append(body);
    if (long) parent.append(h('button.showall', { text: 'Show less', onclick: () => toggleKey(key + '#all') }));
  } else {
    let pv = lines.slice(0, 6).join('\n'); if (pv.length > 500) pv = pv.slice(0, 500);
    (md ? renderMd(body, P(pv)) : body.append(P(pv)));
    body.append(' …');
    parent.append(body);
    parent.append(h('button.showall', { text: 'Show all (' + lines.length + ' lines, ' + fmtN(text.length) + ' chars)', onclick: () => toggleKey(key + '#all') }));
  }
}
function inline(parent, s) {
  for (const part of s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(h('b', { text: part.slice(2, -2) }));
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(h('span.icode', { text: part.slice(1, -1) }));
    else parent.append(part);
  }
}
function renderMd(parent, text) {
  const re = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let pos = 0, m;
  const plain = (t) => {
    const lines = t.split('\n');
    lines.forEach((ln, i) => {
      const hm = /^#{1,6}\s+(.*)$/.exec(ln);
      if (hm) parent.append(h('b', { text: hm[1] }));
      else inline(parent, ln);
      if (i < lines.length - 1) parent.append('\n');
    });
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) plain(text.slice(pos, m.index));
    parent.append(h('span.code', { text: m[1].replace(/\n$/, '') }));
    pos = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (pos < text.length) plain(text.slice(pos));
}
function jsonPre(parent, x, key) {
  let s; try { s = JSON.stringify(x, null, 2); } catch (e) { s = String(x); }
  longText(parent, s === undefined ? '' : s, key, true);
}

function blockEl(b, key, opts) {
  opts = opts || {};
  const kind = b.kind;
  const [label0, icon] = KIND[kind] || KIND.other;
  let label = b.label || label0;
  const card = h('div.card', { 'data-kind': kind });
  if (kind === 'result' && b.is_error) card.classList.add('iserr');
  if (opts.tint) card.classList.add('tinted');
  const head = h('div.ch', null, h('span', { text: icon }), h('span', { text: label }));
  const body = h('div');
  const collapsible = kind === 'harness' || kind === 'thinking';
  const isOpen = collapsible ? openKey(key) : true;
  if (kind === 'call' || kind === 'result') {
    head.append(' · ', h('span', { text: b.tool || '' }));
    if (b.arg) head.append(h('span.arg', { text: P(b.arg), title: P(b.arg_full || '') }));
    if (kind === 'result' && b.is_error) head.append(h('b.err', { text: 'ERROR' }));
  }
  if (kind === 'other') head.append(' · ', h('span', { text: b.type || '' }));
  if (kind === 'task' && opts.parent) head.append(h('a.lnk', { text: 'from #' + opts.parent.ex + ' Agent call', onclick: (ev) => { ev.stopPropagation(); setFollow(false); select(opts.parent.ex); } }));
  if (kind === 'harness' && b.link) head.append(h('a.lnk', { text: '→ ' + b.link, onclick: (ev) => { ev.stopPropagation(); if (b.link_ex) { setFollow(false); select(b.link_ex); } } }));
  if (kind === 'system' && b.size != null) head.append(h('span.muted', { text: fmtN(b.size) + ' chars' }));
  if (kind === 'harness' && !isOpen) head.append(h('span.arg', { text: P(b.summary || '') }));
  if (collapsible) { card.classList.add('clickable'); head.addEventListener('click', () => toggleKey(key)); head.append(h('span.muted', { text: isOpen ? '▾' : '▸' })); }
  card.append(head);
  if (kind === 'thinking') {
    if (isOpen) { if (b.text) longText(body, b.text, key, false); else body.append(h('span.muted', { text: '(no thinking text returned)' })); }
    if (!b.text) head.append(h('span.chipx', { text: 'thinking hidden' + (b.tokens ? ' · ' + b.tokens + ' tokens' : opts.thinkTokens ? ' · ' + opts.thinkTokens + ' tokens' : '') }));
  } else if (kind === 'harness') {
    if (isOpen) longText(body, b.text, key, true);
  } else if (kind === 'model') {
    longText(body, b.text, key, false, true);
  } else if (kind === 'you' || kind === 'task' || kind === 'system') {
    longText(body, b.text, key, false);
  } else if (kind === 'call') {
    jsonPre(body, b.input, key);
  } else if (kind === 'result') {
    if (b.text === '' || b.text == null) body.append(h('span.muted', { text: '(empty)' })); else longText(body, b.text, key, true);
  } else {
    longText(body, b.text, key, true);
  }
  card.append(body);
  if (kind === 'result' && opts.callHeader) {
    return h('div', null, h('div.msgh', null, 'CALL · ' + (b.tool || '') + (b.arg ? ' ' + P(b.arg) : '') + ' · ', b.from ? h('a.lnk', { text: 'from #' + b.from, onclick: () => { setFollow(false); select(b.from); } }) : 'from earlier'), card);
  }
  return card;
}

// ---------------------------------------------------------------- detail
function secOpen(name, def) { return lsGet('sec:' + name, def ? '1' : '0') === '1'; }
function section(name, count, def, build) {
  const open = secOpen(name, def);
  const wrap = h('div.sec');
  wrap.append(h('div.sh', { onclick: () => { lsSet('sec:' + name, open ? '0' : '1'); renderDetail(); } }, h('span', { text: open ? '▼' : '▶' }), h('span', { text: name }), h('span.cnt', { text: count || '' })));
  if (open) { const b = h('div.sb'); try { build(b); } catch (err) { b.append(h('pre', { text: 'render error: ' + err })); } wrap.append(b); }
  return wrap;
}
function renderDetail() {
  const box = $('detail');
  const st = box.scrollTop;
  const d = S.detail;
  if (!d) { box.replaceChildren(h('p.muted', { text: S.sel ? 'Loading #' + S.sel + '…' : 'Waiting for traffic…' })); return; }
  const e = S.ex.get(d.summary.id) || d.summary;
  const id = e.id;
  const kids = [];
  const a = e.anatomy;
  const msgs = (d.conv || []);
  // title line
  kids.push(h('div', null, h('b', { text: '#' + id }), ' · S' + (e.session == null ? '?' : e.session) + ' ', e.is_msg ? pill(e.thread) : '', ' · ' + (e.model || e.method + ' ' + e.path) + ' · ' + (e.status || e.state) + ' · ' + fmtDur(durOf(e)), e.title ? h('span.muted', { text: ' · ' + P(e.title) }) : ''));
  kids.push(section('Summary', '', true, (b) => buildSummary(b, d, e)));
  if (e.is_msg) {
    const newMsgs = msgs.filter((m) => m.new);
    kids.push(section('New in this request', newMsgs.length + ' msgs', true, (b) => {
      if (d.evicted) { b.append(h('p.muted', { text: 'evicted' })); return; }
      if (!newMsgs.length) b.append(h('p.muted', { text: 'no new messages' + (e.flags.retry_of ? ' (retry of #' + e.flags.retry_of + ')' : '') }));
      if (d.prev && msgs.length > d.new_start && d.new_start > 0) b.append(h('div.muted', { text: '↳ reply of #' + d.prev + ' is the previous message' }));
      for (const m of newMsgs) renderMsg(b, m, 'new', d, false);
    }));
    kids.push(section('Reply', replyCount(d), true, (b) => buildReply(b, d, e)));
    kids.push(section('Conversation', msgs.length + ' messages', false, (b) => {
      if (d.evicted) { b.append(h('p.muted', { text: 'evicted' })); return; }
      for (const m of msgs) renderMsg(b, m, 'conv', d, true);
      if (d.reply && d.reply.blocks.length) {
        b.append(h('div.msgh', { text: 'MODEL · #' + id + ' · ' + (d.reply.stop_reason || (live(e) ? 'streaming…' : '')) }, h('span.newtag', { text: 'NEW' })));
        const w = h('div.msg.model'); d.reply.blocks.forEach((blk, j) => w.append(blockEl(blk, id + '|conv|r' + j, { thinkTokens: d.reply.thinking_tokens }))); b.append(w);
      }
    }));
    const body = d.body || {};
    const sys = typeof body.system === 'string' ? [{ text: body.system }] : (body.system || []);
    const sysChars = sys.reduce((n, s) => n + (s.text || '').length, 0);
    kids.push(section('System instructions', sys.length + ' blocks · ' + fmtN(sysChars) + ' chars', false, (b) => {
      if (d.evicted) { b.append(h('p.muted', { text: 'evicted' })); return; }
      sys.forEach((s, i) => b.append(blockEl({ kind: 'system', text: s.text || '', size: (s.text || '').length }, id + '|sys|' + i)));
    }));
    const tools = body.tools || [];
    kids.push(section('Tool definitions', tools.length + ': ' + tools.map((t) => t.name).join(', ').slice(0, 120), false, (b) => {
      if (d.evicted) { b.append(h('p.muted', { text: 'evicted' })); return; }
      tools.forEach((t, i) => {
        const key = id + '|tool|' + i, open = openKey(key);
        const c = h('div.card', { 'data-kind': 'system' }, h('div.ch.clickable', { onclick: () => toggleKey(key) }, h('span', { text: open ? '▾' : '▸' }), h('span', { text: t.name }), h('span.muted', { text: fmtN(JSON.stringify(t).length) + ' chars' })));
        if (open) { longText(c, t.description || '', key + '|d', false); jsonPre(c, t.input_schema, key + '|s'); }
        b.append(c);
      });
    }));
  }
  kids.push(section('Raw', '', false, (b) => {
    if (d.evicted) b.append(h('p.muted', { text: 'evicted: bodies were dropped to save memory' }));
    b.append(h('b', { text: 'Request headers' })); jsonPre(b, d.req_headers, id + '|raw|rh');
    b.append(h('b', { text: 'Request body' })); if (d.body != null) jsonPre(b, d.body, id + '|raw|body'); else longText(b, d.body_text || '', id + '|raw|bodyt', true);
    b.append(h('b', { text: 'Response headers' })); jsonPre(b, d.resp_headers, id + '|raw|ph');
    b.append(h('b', { text: 'Response body (raw SSE text)' })); longText(b, d.raw_reply || '', id + '|raw|sse', true);
  }));
  box.replaceChildren(...kids);
  box.scrollTop = st;
}
function replyCount(d) {
  const r = d.reply; if (!r) return '';
  const calls = r.blocks.filter((b) => b.kind === 'call').length;
  return r.blocks.length + ' blocks' + (calls ? ' · ' + calls + ' calls' : '');
}
function renderMsg(parent, m, sec, d, withHead) {
  const id = d.summary.id;
  const isModel = m.role === 'assistant';
  if (withHead || true) parent.append(h('div.msgh', { text: m.head }, m.new && sec === 'conv' ? h('span.newtag', { text: 'NEW' }) : ''));
  const w = h('div.msg' + (isModel ? '.model' : ''));
  m.blocks.forEach((b, j) => w.append(blockEl(b, id + '|' + sec + '|' + m.idx + '.' + j, { tint: false, callHeader: sec === 'new', parent: d.parent })));
  parent.append(w);
}
function buildReply(b, d, e) {
  const r = d.reply;
  if (!r || (!r.blocks.length && !r.error)) { b.append(h('p.muted', { text: live(e) ? 'waiting for the model…' : 'no reply' + (e.error ? ': ' + e.error : '') })); return; }
  r.blocks.forEach((blk, j) => {
    b.append(blockEl(blk, e.id + '|reply|' + j, { thinkTokens: r.thinking_tokens }));
    if (blk.kind === 'call') {
      const res = d.results && d.results[blk.id];
      if (res) res.blocks.forEach((rb, k) => { const c = blockEl(rb, e.id + '|reply|' + j + '.r' + k, {}); c.style.marginLeft = '18px'; b.append(c); });
      else if ((d.nores || []).includes(blk.id)) b.append(h('div.pend', { text: '   ⚠ no result' }));
      else b.append(h('div.muted', { text: '   … waiting for result' }));
    }
  });
  if (r.error) b.append(blockEl({ kind: 'other', type: 'error event', text: JSON.stringify(r.error, null, 2) }, e.id + '|reply|err'));
}
function buildSummary(b, d, e) {
  const t = e.tokens;
  const tbl = h('table.sum');
  const add = (k, v) => tbl.append(h('tr', null, h('td.muted', { text: k }), h('td', null, v)));
  add('Thread', h('span', null, pill(e.thread), ' ', P(e.title || '')));
  if (e.parent_ex) add('Started by', h('a.lnk', { text: 'Agent call in #' + e.parent_ex, onclick: () => { setFollow(false); select(e.parent_ex); } }));
  add('Model', e.model || '–');
  add('Status', (e.status || '–') + ' · state ' + e.state + (e.error ? ' · ' + P(e.error) : ''));
  add('Stop reason', e.stop_reason || '–');
  add('Timing', 'start ' + fmtTime(e.t0) + ' · first byte ' + (e.t_first ? '+' + fmtDur(e.t_first - e.t0) : '–') + ' · total ' + fmtDur(durOf(e)) + (e.tool_time != null ? ' · tool time before: ' + fmtDur(e.tool_time) : ''));
  if (e.is_msg) {
    add('Input', fmtN(t.in) + ' (' + pct(t.cached) + ' cached) = input ' + fmtN(t.input) + ' + cache read ' + fmtN(t.cache_read) + ' + cache write ' + fmtN(t.cache_write));
    add('Output', fmtN(t.out) + ' (' + fmtN(t.thinking) + ' thinking)');
  }
  add('Request size', fmtN(e.req_size) + ' bytes');
  const fl = h('span');
  const f = e.flags || {};
  if (f.retry_of) fl.append(h('span.flag', { text: 'retry of #' + f.retry_of }));
  if (f.history_changed != null) fl.append(h('span.flag.red', { text: 'history changed at message ' + f.history_changed }));
  for (const c of f.changes || []) fl.append(h('span.flag', { text: c }));
  if (e.red) fl.append(h('span.flag.red', { text: 'error' }));
  if (e.red_dot) fl.append(h('span.flag.red', { text: 'a tool result failed' }));
  if (e.amber) fl.append(h('span.flag', { text: 'warning' }));
  if (fl.childNodes.length) add('Flags', fl);
  b.append(tbl);
  const a = e.anatomy;
  if (a) {
    b.append(h('b', { text: 'Anatomy of the request (chars)' }), anatBar(a, true));
    const lg = h('div.legend');
    for (const k of ANAT) lg.append(h('span', null, h('i', { style: 'background:' + ANAT_COL[k] }), k + ' ' + fmtN(a[k])));
    lg.append(h('span.muted', { text: '= ' + fmtN(a.total) + ' total' }));
    b.append(lg);
    b.append(h('div', { text: 'your words: ' + fmtN(e.you_chars) + ' chars of ' + fmtN(a.total) + ' (' + (a.total ? (e.you_chars / a.total * 100).toFixed(2) : '0') + '%)' }));
  }
}

// ---------------------------------------------------------------- wiring
function clearAll() {
  S.ex.clear(); S.sel = null; S.detail = null; S.newCount = 0;
  $('timeline').replaceChildren(); renderDetail(); refresh();
}
function loadList() {
  fetch('/api/exchanges').then((r) => r.json()).then((list) => { for (const e of list) upsert(e); refresh(); }).catch(() => {});
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('hello', (ev) => {
    const boot = JSON.parse(ev.data).boot;
    if (S.boot && S.boot !== boot) clearAll();
    S.boot = boot;
    const c = $('conn'); c.textContent = '● live'; c.className = 'conn live';
    loadList();
  });
  es.addEventListener('exchange', (ev) => upsert(JSON.parse(ev.data)));
  es.addEventListener('reply', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === S.sel && S.detail && S.detail.summary.id === m.id) { S.detail.reply = m.reply; renderDetail(); }
  });
  es.onerror = () => { const c = $('conn'); c.textContent = '● reconnecting'; c.className = 'conn down'; };
}
function init() {
  $('f-follow').addEventListener('change', (ev) => setFollow(ev.target.checked));
  $('f-errors').addEventListener('change', (ev) => { S.errors = ev.target.checked; relist(); refresh(); });
  $('f-hide').addEventListener('change', (ev) => { S.hide = ev.target.checked; relist(); refresh(); });
  $('f-privacy').addEventListener('change', (ev) => { S.privacy = ev.target.checked; relist(); renderDetail(); refresh(); });
  $('b-stats').addEventListener('click', () => { S.stats = !S.stats; $('stats').hidden = !S.stats; refresh(); });
  $('b-lanes').addEventListener('click', () => { S.lanes = !S.lanes; refresh(); });
  $('chip').addEventListener('click', () => setFollow(true));
  $('timeline').addEventListener('scroll', () => { if (S.follow && $('timeline').scrollTop > 8) setFollow(false); });
  setInterval(() => {
    let any = false;
    for (const e of S.ex.values()) if (live(e)) { any = true; if (visible(e)) upsertRowOnly(e); }
    if (any) { renderLanes(); }
  }, 500);
  connect();
}
function upsertRowOnly(e) {
  const old = $('timeline').querySelector('[data-id="' + e.id + '"]');
  if (old) old.replaceWith(rowEl(e));
}
init();
