(function () {
'use strict';
// ---------- state & helpers
const S = { ex: new Map(), sel: null, follow: true, thread: null, errors: false, hideNon: true, privacy: true,
  boot: null, newCount: 0, detail: null, loading: false };
const rows = new Map();
const openState = new Map();   // block key -> bool (survives live re-renders)
const $ = id => document.getElementById(id);
const tl = $('timeline'), detailEl = $('detail');
const ARGKEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];
const SUBCOL = ['#9333ea', '#db2777', '#a16207', '#4d7c0f'];
const ICON = { you: '\u{1F464}', task: '\u{1F4CB}', harness: '⚙', model: '\u{1F916}', thinking: '\u{1F4AD}',
  call: '\u{1F527}', result: '\u{1F4C4}', system: '\u{1F6E1}', other: '❓' };
const TAGS = ['system-reminder', 'task-notification', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-caveat'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
let secState = {};
try { secState = JSON.parse(lsGet('dash.sections') || '{}') || {}; } catch (e) { secState = {}; }
const SECDEF = { 'Summary': true, 'New in this request': true, 'Reply': true };
function secOpen(n) { return n in secState ? !!secState[n] : !!SECDEF[n]; }
function setSecOpen(n, v) { secState[n] = v; lsSet('dash.sections', JSON.stringify(secState)); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function P(s) { s = String(s === undefined || s === null ? '' : s); return S.privacy ? s.replace(EMAIL, '•••@•••') : s; }
function fmtk(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }
function hms(t) { return t ? new Date(t * 1000).toLocaleTimeString('en-GB') : ''; }
function secs(a, b) { return (b - a).toFixed(1) + 's'; }
function callArg(inp) {
  if (!inp || typeof inp !== 'object') return '';
  for (const k of ARGKEYS) {
    const v = inp[k];
    if (v !== undefined && v !== null && v !== '') {
      const s = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
      return s.length > 80 ? s.slice(0, 79) + '…' : s;
    }
  }
  return '';
}
function clean(x) {
  if (Array.isArray(x)) return x.map(clean);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k in x) {
      if (k === 'data' && typeof x[k] === 'string' && x[k].length > 200 && (x.media_type || x.type === 'base64'))
        o[k] = '[' + (x.media_type || 'data') + ', ' + Math.round(x[k].length * 0.75 / 1024) + ' KB]';
      else o[k] = clean(x[k]);
    }
    return o;
  }
  return x;
}
function maskBody(b) {
  if (!S.privacy || !b || typeof b !== 'object' || !b.metadata || typeof b.metadata.user_id !== 'string') return b;
  const c = Object.assign({}, b), m = Object.assign({}, b.metadata);
  let u = '•••';
  try {
    const o = JSON.parse(m.user_id), r = {};
    for (const k in o) r[k] = '•••';
    u = JSON.stringify(r);
  } catch (e) { /* keep */ }
  m.user_id = u; c.metadata = m;
  return c;
}
function segments(text) {
  const re = new RegExp('<(' + TAGS.join('|') + ')(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>', 'g');
  const out = []; let pos = 0, m;
  while ((m = re.exec(text)) !== null) {
    const pre = text.slice(pos, m.index);
    if (pre.trim()) out.push([null, pre]);
    out.push([m[1], m[2]]);
    pos = m.index + m[0].length;
  }
  const rest = text.slice(pos);
  if (rest.trim()) out.push([null, rest]);
  return out;
}

// ---------- text rendering
function inline(parent, line) {
  line.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).forEach(p => {
    if (!p) return;
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) parent.append(el('b', null, p.slice(2, -2)));
    else if (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`') parent.append(el('code', null, p.slice(1, -1)));
    else parent.append(document.createTextNode(p));
  });
}
function md(text) {
  const root = el('div', 'md txt');
  text.split('```').forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 && /^[\w+-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
      root.append(el('pre', null, code.replace(/\n$/, '')));
    } else {
      if (i > 0 && part.startsWith('\n')) part = part.slice(1);
      part.split('\n').forEach((ln, j, arr) => {
        if (/^#{1,6}\s/.test(ln)) root.append(el('span', 'h', ln.replace(/^#{1,6}\s+/, '')));
        else inline(root, ln);
        if (j < arr.length - 1) root.append(document.createTextNode('\n'));
      });
    }
  });
  return root;
}
function plain(text, mono) { return mono ? el('pre', 'mono', text) : el('div', 'txt', text); }
function longText(text, key, opt) {
  opt = opt || {};
  text = String(text === undefined || text === null ? '' : text);
  const wrap = el('div');
  const lines = text.split('\n');
  const isLong = lines.length > 10 || text.length > 800;
  const render = () => {
    wrap.replaceChildren();
    const open = openState.get(key) === true;
    let shown = text;
    if (isLong && !open) { shown = lines.slice(0, 6).join('\n'); if (shown.length > 500) shown = shown.slice(0, 500); }
    wrap.append(opt.md ? md(P(shown)) : plain(P(shown), opt.mono));
    if (isLong) {
      const b = el('button', 'more', open ? 'Collapse' : 'Show all (' + lines.length + ' lines, ' + text.length + ' chars)');
      b.onclick = ev => { ev.stopPropagation(); openState.set(key, !open); render(); };
      wrap.append(b);
    }
  };
  render();
  return wrap;
}
function jsonView(x, key) { return longText(JSON.stringify(x, null, 2), key, { mono: true }); }

// ---------- anatomy, lanes, stats
const ANAT = [['system', 'system', '#334155'], ['tools', 'tools', '#b45309'], ['harness', 'harness', '#9ca3af'],
  ['earlier', 'earlier', '#cbd5e1'], ['new', 'new', '#2563eb']];
function anatBar(s, big) {
  const b = el('div', 'anat' + (big ? ' big' : ''));
  const a = s.anatomy, tot = s.content_size;
  if (!a || !tot) { b.hidden = true; return b; }
  ANAT.forEach(x => {
    const i = el('i', 'a-' + x[0]);
    i.style.width = (a[x[0]] / tot * 100) + '%';
    i.title = x[1] + ': ' + a[x[0]].toLocaleString() + ' chars (' + (a[x[0]] / tot * 100).toFixed(1) + '%)';
    b.append(i);
  });
  return b;
}
function curSession() {
  let best = null;
  for (const s of S.ex.values()) if (s.is_message && s.session && (best === null || s.id > best.id)) best = s;
  return best ? best.session : null;
}
function threadOrder(x) { return x === 'main' ? [0, 0] : (/^sub-\d+$/.test(x) ? [1, Number(x.slice(4))] : (x === 'side' ? [3, 0] : [2, 0])); }
const lanesOpen = () => lsGet('dash.lanes') !== '0';
function renderLanes() {
  const box = $('lanes');
  const sess = curSession();
  const items = [];
  S.ex.forEach(s => { if (s.is_message && s.session === sess && s.thread) items.push(s); });
  box.hidden = !items.length;
  if (!items.length) return;
  const now = Date.now() / 1000;
  const t0 = Math.min.apply(null, items.map(s => s.t_start));
  const t1 = Math.max.apply(null, items.map(s => s.t_end || now));
  const span = Math.max(t1 - t0, 0.001);
  const open = lanesOpen();
  const h = el('div', 'lh', (open ? '▼' : '▶') + ' Lanes · ' + sess + ' · ' + span.toFixed(1) + 's · ' + items.length + ' requests');
  h.onclick = () => { lsSet('dash.lanes', open ? '0' : '1'); renderLanes(); };
  const parts = [h];
  if (open) {
    const body = el('div', 'lbody');
    const by = {};
    items.forEach(s => { (by[s.thread] = by[s.thread] || []).push(s); });
    Object.keys(by).sort((a, b) => { const ka = threadOrder(a), kb = threadOrder(b); return ka[0] - kb[0] || ka[1] - kb[1] || (a < b ? -1 : 1); }).forEach(nm => {
      const lane = el('div', 'lane');
      const ln = el('div', 'ln', nm);
      ln.style.color = pillColor(nm);
      const tr = el('div', 'tr');
      const list = by[nm].sort((a, b) => a.t_start - b.t_start);
      list.forEach((s, i) => {
        const end = s.t_end || now;
        const bar = el('div', 'bar' + (s.red ? ' red' : '') + (s.amber ? ' amber' : '') + (s.id === S.sel ? ' sel' : ''));
        bar.dataset.id = s.id; bar.dataset.state = s.state;
        bar.style.left = ((s.t_start - t0) / span * 100) + '%';
        bar.style.width = (Math.max(end - s.t_start, 0) / span * 100) + '%';
        bar.title = '#' + s.id + ' ' + nm + ' · ' + s.state + ' · ' + secs(s.t_start, end) + (s.tool_time !== null && s.tool_time !== undefined ? ' · tool time before: ' + s.tool_time.toFixed(1) + 's' : '');
        if (s.t_first && end > s.t_start) {
          const tk = el('div', 'tick');
          tk.style.left = (Math.min(1, (s.t_first - s.t_start) / (end - s.t_start)) * 100) + '%';
          bar.append(tk);
        }
        bar.onclick = () => { setFollow(false); select(s.id); };
        tr.append(bar);
        const prev = list[i - 1];
        if (prev && prev.t_end && s.tool_time !== null && s.tool_time !== undefined && s.t_start > prev.t_end) {
          const g = el('div', 'gap', '⚙ ' + s.tool_time.toFixed(1) + 's');
          g.style.left = ((prev.t_end - t0) / span * 100) + '%';
          g.style.width = ((s.t_start - prev.t_end) / span * 100) + '%';
          g.title = 'tool time ' + s.tool_time.toFixed(1) + 's';
          tr.append(g);
        }
      });
      lane.append(ln, tr);
      body.append(lane);
    });
    const ax = el('div', 'laxis');
    ax.append(el('span', null, '0s'), el('span', null, (span / 2).toFixed(1) + 's'), el('span', null, span.toFixed(1) + 's'));
    body.append(ax);
    parts.push(body);
  }
  box.replaceChildren.apply(box, parts);
}
function statsOpen() { return !$('stats').hidden; }
function renderStats() {
  const box = $('stats');
  if (box.hidden) return;
  const sess = curSession();
  const items = [];
  S.ex.forEach(s => { if (s.is_message && s.session === sess && passes(s)) items.push(s); });
  let inp = 0, cr = 0, cw = 0, cw1 = 0, out = 0, th = 0, tool = 0, model = 0, errs = 0;
  const tools = {};
  items.forEach(s => {
    inp += s.input; cr += s.cache_read; cw += s.cache_write; cw1 += s.cache_write_1h || 0; out += s.out; th += s.thinking_tokens;
    if (s.tool_time !== null && s.tool_time !== undefined) tool += s.tool_time;
    if (s.t_end) model += s.t_end - s.t_start;
    (s.calls || []).forEach(c => { tools[c.name] = (tools[c.name] || 0) + 1; if (c.state === 'error') errs++; });
    if (s.red) errs++;
  });
  const tin = inp + cr + cw;
  const actual = inp + 0.1 * cr + 1.25 * (cw - cw1) + 2 * cw1;
  const saved = tin ? (1 - actual / tin) * 100 : null;
  const pct = (a, b) => b ? ' (' + (a / b * 100).toFixed(1) + '%)' : '';
  const h = el('h4');
  const x = el('span', null, 'Stats · ' + (sess || '-') + (S.thread ? ' · ' + S.thread : '') + (S.errors ? ' · errors only' : ''));
  const close = el('button', 'tb', '×');
  close.onclick = () => { box.hidden = true; };
  h.append(x, close);
  const g = kv([
    ['Requests', String(items.length)],
    ['Input tokens', tin.toLocaleString()],
    ['  uncached', inp.toLocaleString() + pct(inp, tin)],
    ['  cache write', cw.toLocaleString() + pct(cw, tin)],
    ['  cache read', cr.toLocaleString() + pct(cr, tin)],
    ['Output tokens', out.toLocaleString() + (th ? ' (' + th.toLocaleString() + ' thinking)' : '')],
    ['Cache hit', tin ? Math.round(cr / tin * 100) + '%' : '-'],
    ['Errors', String(errs)],
    ['Tool time', tool.toFixed(1) + 's vs model time ' + model.toFixed(1) + 's' + (tool + model ? ' (' + Math.round(tool / (tool + model) * 100) + '% tools)' : '')]]);
  g.style.gridTemplateColumns = '110px 1fr';
  const sv = el('div');
  sv.append(el('div', null, 'Input cost saved by caching'),
    el('div', 'big', saved === null ? '-' : saved.toFixed(1) + '%'),
    el('div', 'dim', 'read 0.1×, write 1.25× (1-hour 2×) vs. all input at 1×; no prices needed'));
  const list = el('div');
  list.append(el('div', null, 'Calls per tool'));
  const names = Object.keys(tools).sort((a, b) => tools[b] - tools[a]);
  const mx = names.length ? tools[names[0]] : 1;
  names.forEach(nm => {
    const r = el('div', 'hbar');
    const b = el('span', 'b');
    b.style.width = (tools[nm] / mx * 200) + 'px';
    r.append(el('span', 'nm', nm), b, el('span', null, String(tools[nm])));
    list.append(r);
  });
  if (!names.length) list.append(el('div', 'dim', '(no tool calls)'));
  box.replaceChildren(h, g, el('div', null, ' '), sv, el('div', null, ' '), list);
}

// ---------- cards
function card(kind, label, sub, body, cls) {
  const c = el('div', 'card' + (cls ? ' ' + cls : ''));
  c.dataset.kind = kind;
  const h = el('div', 'ch');
  h.append(el('span', null, ICON[kind] || ''), el('span', null, label));
  if (sub) h.append(el('span', 'sub', P(sub)));
  c.append(h);
  if (body) { const b = el('div', 'cb'); b.append(body); c.append(b); }
  return c;
}
function collapsible(c, key, closedCls) {
  const apply = () => c.classList.toggle(closedCls, openState.get(key) !== true);
  apply();
  c.firstChild.onclick = () => { openState.set(key, openState.get(key) !== true); apply(); };
}
function threadKind() {
  const t = S.detail && S.detail.summary ? S.detail.summary.thread : '';
  return /^sub-/.test(t) ? 'sub' : (t === 'side' ? 'side' : 'main');
}
function harnessCard(tag, text, key) {
  const isNote = tag === 'task-notification' || text.indexOf('<task-notification') >= 0;
  const first = (text.trim().split('\n')[0] || '').slice(0, 100);
  const c = card('harness', isNote ? 'HARNESS · subagent result' : 'HARNESS · ' + tag, first, longText(text, key + ':t', { mono: true }), 'harness-closed');
  collapsible(c, key, 'harness-closed');
  if (isNote) {
    for (const s of S.ex.values()) {
      if (s.agent_id && text.indexOf(s.agent_id) >= 0) {
        const a = el('a', 'lnk', '→ ' + s.thread);
        a.onclick = ev => { ev.stopPropagation(); setThread(s.thread); };
        c.firstChild.append(a);
        break;
      }
    }
  }
  return c;
}
function textCards(text, role, key, out) {
  segments(text).forEach((seg, i) => {
    const k = key + '.' + i;
    if (seg[0]) { out.push(harnessCard(seg[0], seg[1], k)); return; }
    if (role === 'assistant') { out.push(card('model', 'MODEL', '', longText(seg[1], k, { md: true }))); return; }
    const tk = threadKind();
    if (tk === 'side') out.push(harnessCard('side request', seg[1], k));
    else if (tk === 'sub') {
      const c = card('task', 'TASK', '', longText(seg[1], k));
      const par = S.detail.summary.parent;
      if (par) {
        const a = el('a', 'lnk', 'from CALL in #' + par[0]);
        a.onclick = ev => { ev.stopPropagation(); setFollow(false); select(par[0]); };
        c.firstChild.append(a);
      }
      out.push(c);
    } else out.push(card('you', 'YOU', '', longText(seg[1], k)));
  });
}
function otherCard(b, key) {
  return card('other', 'OTHER · ' + ((b && b.type) || '?'), '', jsonView(clean(b), key));
}
function resultCards(name, inp, content, isErr, key, out) {
  const extra = [];
  const body = el('div');
  const add = (t, i) => {
    segments(t).forEach((seg, j) => {
      if (seg[0]) extra.push(harnessCard(seg[0], seg[1], key + '.' + i + '.' + j));
      else body.append(longText(seg[1], key + '.' + i + '.' + j, { mono: true }));
    });
  };
  if (typeof content === 'string') add(content, 0);
  else if (Array.isArray(content)) {
    content.forEach((b, i) => {
      if (b && b.type === 'text') add(b.text || '', i);
      else body.append(jsonView(clean(b), key + '.' + i + '.j'));
    });
  } else if (content !== undefined && content !== null) body.append(jsonView(clean(content), key + '.j'));
  if (!body.childNodes.length) body.append(el('span', 'chip', extra.length ? 'no output' : '(empty)'));
  out.push(card('result', 'RESULT · ' + (name || '?') + (isErr ? ' · ERROR' : ''), callArg(inp), body, isErr ? 'err' : ''));
  extra.forEach(c => out.push(c));
}
function callCard(name, inp, key, partial) {
  const c = card('call', 'CALL · ' + (name || '?'), callArg(inp), jsonView(inp === undefined ? {} : inp, key));
  if (partial) c.firstChild.append(el('span', 'chip', 'input streaming…'));
  return c;
}
function thinkCard(text, tokens, key) {
  if (!text) {
    const t = tokens || (S.detail && S.detail.summary && S.detail.summary.thinking_tokens) || 0;
    return card('thinking', 'THINKING', '', el('span', 'chip', 'thinking hidden' + (t ? ' · ' + t + ' tokens' : '')));
  }
  const c = card('thinking', 'THINKING', text.split('\n')[0].slice(0, 80), longText(text, key + ':t'), 'harness-closed');
  collapsible(c, key, 'harness-closed');
  return c;
}
function msgCards(msg, ctx, o) {
  const out = [];
  const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
  blocks.forEach((b, bi) => {
    const key = ctx + '.' + bi;
    if (!b || typeof b !== 'object') { out.push(card('other', 'OTHER', '', plain(String(b), true))); return; }
    if (b.type === 'text') textCards(b.text || '', msg.role, key, out);
    else if (b.type === 'thinking') out.push(thinkCard(b.thinking, b.tokens, key));
    else if (b.type === 'redacted_thinking') out.push(thinkCard('', 0, key));
    else if (b.type === 'tool_use') out.push(callCard(b.name, b.input, key));
    else if (b.type === 'tool_result') {
      const info = S.detail.tmap[b.tool_use_id] || {};
      if (o && o.callhdr) {
        const from = S.detail.origins[b.tool_use_id];
        out.push(el('div', 'callhdr', P('CALL · ' + (info.name || '?') + ' ' + callArg(info.input) + (from ? ' · from #' + from : ''))));
      }
      resultCards(info.name, info.input, b.content, !!b.is_error, key, out);
    } else out.push(otherCard(b, key));
  });
  return out;
}

// ---------- detail sections
function section(name, count, render) {
  const open = secOpen(name);
  const w = el('div', 'sec');
  w.dataset.name = name;
  const h = el('div', 'sh');
  h.append(el('span', null, open ? '▼' : '▶'), el('span', null, name), el('span', 'cnt', P(count)));
  h.onclick = () => { setSecOpen(name, !secOpen(name)); rerenderSection(name); };
  w.append(h);
  if (open) { const b = el('div', 'sb'); b.append(render()); w.append(b); }
  return w;
}
let secDefs = [];
function rerenderSection(name) {
  const def = secDefs.find(d => d.name === name);
  const old = detailEl.querySelector('.sec[data-name="' + name + '"]');
  if (def && old) old.replaceWith(section(def.name, def.count, def.render));
}
function kv(list) {
  const g = el('div', 'kv');
  list.forEach(r => {
    g.append(el('div', 'k', r[0]));
    const v = el('div');
    if (r[1] instanceof Node) v.append(r[1]); else v.textContent = P(r[1]);
    g.append(v);
  });
  return g;
}
function renderSummary(D) {
  const s = D.summary;
  const flags = el('div');
  (s.flags || []).forEach(f => flags.append(el('span', 'flag', f)));
  if (s.stop_reason === 'max_tokens') flags.append(el('span', 'flag', 'stop: max_tokens'));
  const tok = 'in ' + s.in.toLocaleString() + ' (input ' + s.input.toLocaleString() + ', cache read ' + s.cache_read.toLocaleString() +
    ', cache write ' + s.cache_write.toLocaleString() + (s.cached !== null ? ', ' + Math.round(s.cached * 100) + '% cached' : '') +
    ') · out ' + s.out.toLocaleString() + (s.thinking_tokens ? ' (' + s.thinking_tokens + ' thinking)' : '');
  const g = [['Model', s.model || '-'], ['Status', (s.status || '-') + ' · ' + s.state + (D.error ? ' · ' + D.error : '')],
    ['Stop reason', s.stop_reason || '-'],
    ['Timing', 'start ' + hms(s.t_start) + (s.t_first ? ' · first byte +' + secs(s.t_start, s.t_first) : '') + (s.t_end ? ' · total ' + secs(s.t_start, s.t_end) : '')],
    ['Tokens', tok], ['Request', (s.size / 1024).toFixed(1) + ' KB' + (s.msgs !== null ? ' · ' + s.msgs + ' messages' : '')]];
  if (s.thread) g.push(['Thread', s.session + ' ' + s.thread + (s.thread_title ? ' · ' + s.thread_title : '')]);
  if (flags.childNodes.length) g.push(['Flags', flags]);
  if (s.tool_time !== null && s.tool_time !== undefined) g.push(['Tool time', '⚙ ' + s.tool_time.toFixed(1) + 's before this request']);
  if (s.anatomy && s.content_size) {
    const an = el('div');
    an.append(anatBar(s, true));
    const lg = el('div', 'legend');
    ANAT.forEach(x => {
      const it = el('span');
      const sw = el('span', 'sw'); sw.style.background = x[2];
      it.append(sw, document.createTextNode(x[1] + ' ' + s.anatomy[x[0]].toLocaleString() + ' (' + (s.anatomy[x[0]] / s.content_size * 100).toFixed(1) + '%)'));
      lg.append(it);
    });
    an.append(lg);
    an.append(el('div', null, 'total ' + s.content_size.toLocaleString() + ' chars'));
    an.append(el('div', null, 'your words: ' + (s.your_chars || 0).toLocaleString() + ' chars of ' + s.content_size.toLocaleString() + ' (' + ((s.your_chars || 0) / s.content_size * 100).toFixed(2) + '%)'));
    g.push(['Anatomy', an]);
  }
  return kv(g);
}
function renderReplyBlocks(D, ctx, withResults) {
  const out = [];
  const r = D.reply;
  const calls = {};
  (D.summary.calls || []).forEach(c => { calls[c.id] = c; });
  r.blocks.forEach((b, i) => {
    const key = ctx + '.' + i;
    if (b.type === 'text') out.push(card('model', 'MODEL', '', longText(b.text, key, { md: true })));
    else if (b.type === 'thinking') out.push(thinkCard(b.thinking, b.tokens, key));
    else if (b.type === 'tool_use') {
      out.push(callCard(b.name, b.input, key, b.partial));
      if (withResults) {
        const res = D.results[b.id];
        if (res) {
          out.push(el('div', 'callhdr', 'result from #' + res.from));
          resultCards(b.name, b.input, res.content, res.is_error, key + ':r', out);
        } else {
          const st = calls[b.id] ? calls[b.id].state : 'waiting';
          out.push(el('div', 'status ' + (st === 'noresult' ? 'noresult' : 'waiting'), st === 'noresult' ? 'no result' : 'waiting for result'));
        }
      }
    } else out.push(otherCard(b.raw || b, key));
  });
  if (r.error) out.push(card('other', 'ERROR', '', plain(P(r.error), true), 'err'));
  return out;
}
function renderReply(D) {
  const w = el('div');
  const out = renderReplyBlocks(D, D.id + ':reply', true);
  if (!out.length) w.append(el('div', 'empty', D.summary.state === 'pending' || D.summary.state === 'streaming' ? 'waiting for reply…' : '(no reply content)'));
  out.forEach(c => w.append(c));
  if (D.reply.stop_reason) w.append(el('div', 'status', 'stop reason: ' + D.reply.stop_reason));
  return w;
}
function renderNew(D) {
  const w = el('div');
  const msgs = (D.body && D.body.messages) || [];
  if (D.reply_of) w.append(el('div', 'mhead', '↳ reply of #' + D.reply_of));
  (D.summary.flags || []).forEach(f => w.append(el('div', 'warn', f)));
  for (let i = D.new_from; i < D.new_to && i < msgs.length; i++) {
    msgCards(msgs[i], D.id + ':new:' + i, { callhdr: true }).forEach(c => w.append(c));
  }
  if (!w.childNodes.length) w.append(el('div', 'empty', '(nothing new)'));
  return w;
}
function renderConversation(D) {
  const w = el('div');
  const msgs = (D.body && D.body.messages) || [];
  msgs.forEach((m, i) => {
    const box = el('div', m.role === 'assistant' ? 'turn-model' : '');
    let head;
    if (m.role === 'assistant') {
      const o = D.assistant_origin[String(i)];
      head = 'MODEL' + (o ? ' · #' + o.id + (o.stop ? ' · ' + o.stop : '') : '');
    } else head = 'AGENT → MODEL';
    const h = el('div', 'mhead' + (m.role === 'assistant' ? ' model' : ''), head + '  (message ' + i + ')');
    if (i >= D.new_from && i < D.new_to) h.append(el('span', 'newtag', 'NEW'));
    box.append(h);
    msgCards(m, D.id + ':conv:' + i, {}).forEach(c => box.append(c));
    w.append(box);
  });
  const box = el('div', 'turn-model');
  const h = el('div', 'mhead model', 'MODEL · #' + D.id + (D.reply.stop_reason ? ' · ' + D.reply.stop_reason : ''));
  h.append(el('span', 'newtag', 'NEW'));
  box.append(h);
  renderReplyBlocks(D, D.id + ':convreply', true).forEach(c => box.append(c));
  w.append(box);
  return w;
}
function sysBlocks(body) {
  const s = body && body.system;
  if (typeof s === 'string') return [s];
  if (Array.isArray(s)) return s.map(b => (b && typeof b === 'object') ? (b.text !== undefined ? b.text : JSON.stringify(b)) : String(b));
  return [];
}
function renderSystem(D) {
  const w = el('div');
  sysBlocks(D.body).forEach((t, i) => w.append(card('system', 'SYSTEM', 'block ' + (i + 1) + ' · ' + t.length.toLocaleString() + ' chars', longText(t, D.id + ':sys:' + i))));
  return w;
}
function renderTools(D) {
  const w = el('div');
  ((D.body && D.body.tools) || []).forEach((t, i) => {
    const key = D.id + ':tool:' + i;
    const d = el('details', 'tool');
    d.append(el('summary', null, P((t.name || '?') + (t.description ? '  — ' + t.description.replace(/\s+/g, ' ').slice(0, 80) : ''))));
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const b = el('div', 'sb');
      b.append(longText(t.description || '', key + ':d'));
      b.append(jsonView(t.input_schema || {}, key + ':s'));
      d.append(b);
    };
    d.open = openState.get(key) === true;
    if (d.open) build();
    d.addEventListener('toggle', () => { openState.set(key, d.open); if (d.open) build(); });
    w.append(d);
  });
  return w;
}
function renderRaw(D) {
  const w = el('div');
  const hd = h => h.map(x => x[0] + ': ' + x[1]).join('\n');
  const part = (title, node) => { w.append(el('div', 'mhead', title)); w.append(node); };
  part('Request headers', longText(hd(D.req_headers), D.id + ':raw:rh', { mono: true }));
  part('Request body', D.body ? jsonView(maskBody(D.body), D.id + ':raw:body') : longText(D.body_text || '', D.id + ':raw:body', { mono: true }));
  part('Response headers', longText(hd(D.resp_headers), D.id + ':raw:sh', { mono: true }));
  part('Response body (raw SSE)', longText(D.raw_reply, D.id + ':raw:sse', { mono: true }));
  return w;
}
function renderDetail() {
  const D = S.detail;
  if (!D) return;
  const st = detailEl.scrollTop;
  const s = D.summary;
  D.tmap = {};
  D.origins = D.origins || {}; D.results = D.results || {}; D.assistant_origin = D.assistant_origin || {};
  D.raw_reply = D.raw_reply || ''; D.new_from = D.new_from || 0; D.new_to = D.new_to || 0;
  D.reply = D.reply || { blocks: [] };
  const msgs = (D.body && D.body.messages) || [];
  msgs.forEach(m => {
    if (m.role === 'assistant' && Array.isArray(m.content)) m.content.forEach(b => { if (b && b.type === 'tool_use') D.tmap[b.id] = { name: b.name, input: b.input }; });
  });
  const frag = document.createDocumentFragment();
  const head = el('h3', null, P('#' + s.id + ' · ' + (s.session ? s.session + ' ' + s.thread + ' · ' : '') + (s.model || s.method + ' ' + s.path) + ' · ' + (s.status || s.state) + (s.t_end ? ' · ' + secs(s.t_start, s.t_end) : '')));
  head.style.margin = '4px 0';
  frag.append(head);
  if (D.evicted) {
    secDefs = [{ name: 'Summary', count: '', render: () => renderSummary(D) }];
    secDefs.forEach(d => frag.append(section(d.name, d.count, d.render)));
    frag.append(el('div', 'empty', 'Bodies evicted (memory limit): only the summary is kept.'));
  } else {
    if (!s.is_message) {
      secDefs = [{ name: 'Summary', count: '', render: () => renderSummary(D) },
        { name: 'Raw', count: (D.raw_reply.length / 1024).toFixed(1) + ' KB', render: () => renderRaw(D) }];
    } else {
      const sb = sysBlocks(D.body);
      const tools = (D.body && D.body.tools) || [];
      secDefs = [
        { name: 'Summary', count: '', render: () => renderSummary(D) },
        { name: 'New in this request', count: (D.new_to - D.new_from) + ' messages', render: () => renderNew(D) },
        { name: 'Reply', count: D.reply.blocks.length + ' blocks', render: () => renderReply(D) },
        { name: 'Conversation', count: (msgs.length + 1) + ' messages', render: () => renderConversation(D) },
        { name: 'System instructions', count: sb.length + ' blocks · ' + sb.reduce((a, t) => a + t.length, 0).toLocaleString() + ' chars', render: () => renderSystem(D) },
        { name: 'Tool definitions', count: tools.length + ': ' + tools.map(t => t.name).join(', ').slice(0, 120), render: () => renderTools(D) },
        { name: 'Raw', count: (s.size / 1024).toFixed(0) + ' KB request · ' + (D.raw_reply.length / 1024).toFixed(1) + ' KB reply', render: () => renderRaw(D) }];
    }
    secDefs.forEach(d => frag.append(section(d.name, d.count, d.render)));
  }
  detailEl.replaceChildren(frag);
  detailEl.scrollTop = st;
}

// ---------- timeline
function pillColor(n) {
  if (n === 'main') return '#111827';
  const m = /^sub-(\d+)$/.exec(n);
  return m ? SUBCOL[(m[1] - 1) % 4] : '#475569';
}
function pill(name) {
  const p = el('span', 'pill' + (name === 'side' ? ' side' : '') + (S.thread === name ? ' active' : ''), name);
  if (name !== 'side') { p.style.color = pillColor(name); p.style.borderColor = pillColor(name); }
  p.onclick = ev => { ev.stopPropagation(); setThread(name); };
  return p;
}
function passes(s) {
  if (S.hideNon && !s.is_message && !s.red) return false;
  if (S.thread && s.thread !== S.thread) return false;
  if (S.errors && !(s.red || s.dot)) return false;
  return true;
}
function durText(s) {
  if (s.state === 'pending' || s.state === 'streaming') return secs(s.t_start, Date.now() / 1000);
  return s.t_end ? secs(s.t_start, s.t_end) : '';
}
function makeRow(s) {
  const r = el('div', 'row');
  r.dataset.id = s.id;
  const l1 = el('div', 'l1');
  const p = { id: el('span', 'id', '#' + s.id), time: el('span', 'dim'), pills: el('span'), st: el('span'), dur: el('span', 'dim'),
    dot: el('span', 'edot'), tok: el('span', 'tok'), l2: el('div', 'l2'), l3: el('div', 'l2'), an: el('div', 'anat') };
  p.dot.title = 'a tool result in this request is an error';
  l1.append(p.id, p.time, p.pills, p.st, p.dur, p.dot, p.tok);
  r.append(l1, p.l2, p.l3, p.an);
  r._p = p;
  r.onclick = () => { setFollow(false); select(s.id); };
  return r;
}
function updateRow(r, s) {
  const p = r._p;
  r.classList.toggle('red', !!s.red);
  r.classList.toggle('amber', !!s.amber);
  r.dataset.state = s.state;
  r.dataset.anat = s.anatomy ? '1' : '';
  r.title = P(s.tip);
  p.time.textContent = hms(s.t_start);
  p.pills.replaceChildren();
  if (s.thread) p.pills.append(pill(s.thread));
  p.dot.hidden = !s.dot;
  const nb = anatBar(s, false);
  nb.className = 'anat';
  p.an.replaceWith(nb); p.an = nb;
  p.st.replaceChildren();
  if (s.state === 'pending' || s.state === 'streaming') p.st.append(el('span', 'spin'));
  else p.st.textContent = s.state === 'done' ? (s.red ? '✗' : '✓') : (s.state === 'aborted' ? '⏹' : '✗');
  p.dur.textContent = durText(s);
  if (s.is_message) {
    p.tok.textContent = (s.in || s.out) ? fmtk(s.in) + '/' + fmtk(s.out) : '';
    p.l2.replaceChildren(el('span', 'arrow', '↑ '), document.createTextNode(P(s.up)));
    p.l3.replaceChildren(el('span', 'arrow', '↓ '), document.createTextNode(P(s.down)));
    p.l3.hidden = false;
  } else {
    p.tok.textContent = '';
    p.l2.textContent = P(s.method + ' ' + s.path + ' ' + (s.status || (s.error ? 'error' : '')));
    p.l3.hidden = true;
  }
  r.classList.toggle('sel', s.id === S.sel);
}
function insertRow(r, id) {
  const before = tl.scrollHeight, top = tl.scrollTop;
  let ref = tl.firstChild;
  while (ref && Number(ref.dataset.id) > id) ref = ref.nextSibling;
  tl.insertBefore(r, ref);
  if (top > 0) tl.scrollTop = top + (tl.scrollHeight - before);
}
function upsert(s) {
  const old = S.ex.get(s.id);
  if (old && old.version >= s.version) return;
  S.ex.set(s.id, s);
  let r = rows.get(s.id);
  const isNew = !r;
  if (!r) { r = makeRow(s); rows.set(s.id, r); updateRow(r, s); r.hidden = !passes(s); insertRow(r, s.id); }
  else { updateRow(r, s); r.hidden = !passes(s); }
  if (isNew && !S.loading && passes(s)) {
    if (S.follow) select(s.id);
    else { S.newCount++; showChip(); }
  }
  if (s.id === S.sel && S.detail && S.detail.summary.version !== s.version) scheduleDetail();
  scheduleTotals();
}
function showChip() { const c = $('chip'); c.hidden = S.newCount === 0; c.textContent = S.newCount + ' new ↑'; }
let detailTimer = null;
function scheduleDetail() { if (detailTimer) return; detailTimer = setTimeout(() => { detailTimer = null; loadDetail(S.sel); }, 150); }
async function loadDetail(id) {
  if (id === null) return;
  try {
    const r = await fetch('/api/exchanges/' + id);
    if (!r.ok) return;
    const d = await r.json();
    if (S.sel !== id) return;
    S.detail = d;
    renderDetail();
  } catch (e) { /* retried on the next event */ }
}
function select(id) {
  S.sel = id;
  rows.forEach((r, k) => r.classList.toggle('sel', k === id));
  S.detail = null;
  renderLanes();
  loadDetail(id);
}
function selectNewest() {
  let best = null;
  for (const s of S.ex.values()) if (passes(s) && (best === null || s.id > best)) best = s.id;
  if (best !== null && best !== S.sel) select(best);
}
function setFollow(v) {
  S.follow = v;
  $('f-follow').checked = v;
  if (v) { S.newCount = 0; showChip(); tl.scrollTop = 0; selectNewest(); }
}
function setThread(n) { S.thread = S.thread === n ? null : n; applyFilters(); }
function applyFilters() {
  S.ex.forEach((s, id) => { rows.get(id).hidden = !passes(s); });
  scheduleTotals();
  if (S.follow) selectNewest();
}
let totalsQueued = false;
function scheduleTotals() {
  if (totalsQueued) return;
  totalsQueued = true;
  setTimeout(() => { totalsQueued = false; renderTotals(); }, 30);
}
function renderTotals() {
  renderLanes(); renderStats();
  let n = 0, tin = 0, cr = 0, out = 0, err = 0;
  const names = new Set();
  S.ex.forEach(s => {
    if (s.thread) names.add(s.thread);
    if (!passes(s)) return;
    n++; tin += s.in; cr += s.cache_read; out += s.out;
    if (s.red || s.dot) err++;
  });
  const t = $('totals');
  t.replaceChildren(document.createTextNode(n + ' req · in ' + fmtk(tin) + ' (' + (tin ? Math.round(cr / tin * 100) : 0) + '% cached) · out ' + fmtk(out) + ' · '));
  const e = el('b', 'errcount' + (err ? ' bad' : ''), err + (err === 1 ? ' error' : ' errors'));
  e.onclick = () => { S.errors = !S.errors; $('f-errors').checked = S.errors; applyFilters(); };
  t.append(e);
  const k = x => x === 'main' ? [0, 0] : (/^sub-\d+$/.test(x) ? [1, Number(x.slice(4))] : (x === 'side' ? [3, 0] : [2, 0]));
  const order = Array.from(names).sort((a, b) => { const ka = k(a), kb = k(b); return ka[0] - kb[0] || ka[1] - kb[1] || (a < b ? -1 : 1); });
  const ps = $('pills');
  ps.replaceChildren();
  order.forEach(nm => { ps.append(pill(nm), document.createTextNode(' ')); });
}
function clearAll() {
  S.ex.clear(); rows.clear(); $('lanes').replaceChildren(); $('stats').hidden = true; tl.replaceChildren(); S.sel = null; S.detail = null; S.newCount = 0; showChip();
  detailEl.replaceChildren(el('div', 'empty', 'Waiting for the first request…'));
  scheduleTotals();
}
async function loadList() {
  try {
    const r = await fetch('/api/exchanges');
    const list = await r.json();
    S.loading = true;
    list.forEach(upsert);
    S.loading = false;
    if (S.follow) selectNewest();
    else if (S.sel !== null) loadDetail(S.sel);
  } catch (e) { S.loading = false; }
}
function onReply(m) {
  if (m.id !== S.sel || !S.detail) return;
  S.detail.reply = m.reply;
  rerenderSection('Reply');
  if (secOpen('Conversation')) rerenderSection('Conversation');
}

// ---------- wiring
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('conn').textContent = '● live'; $('conn').className = 'conn on'; };
  es.onerror = () => { $('conn').textContent = '● reconnecting'; $('conn').className = 'conn off'; };
  es.addEventListener('hello', e => {
    const b = JSON.parse(e.data).boot;
    if (S.boot !== null && S.boot !== b) clearAll();
    S.boot = b;
    loadList();
  });
  es.addEventListener('exchange', e => upsert(JSON.parse(e.data)));
  es.addEventListener('reply', e => onReply(JSON.parse(e.data)));
}
$('f-errors').onchange = e => { S.errors = e.target.checked; applyFilters(); };
$('f-nonmsg').onchange = e => { S.hideNon = e.target.checked; applyFilters(); };
$('f-follow').onchange = e => setFollow(e.target.checked);
$('f-privacy').onchange = e => {
  S.privacy = e.target.checked;
  S.ex.forEach((s, id) => updateRow(rows.get(id), s));
  scheduleTotals();
  renderDetail();
};
$('b-stats').onclick = () => { $('stats').hidden = !$('stats').hidden; renderStats(); };
$('chip').onclick = () => setFollow(true);
tl.addEventListener('scroll', () => { if (S.follow && tl.scrollTop > 30) setFollow(false); });
setInterval(() => {
  S.ex.forEach((s, id) => {
    if (s.state === 'pending' || s.state === 'streaming') { const r = rows.get(id); if (r) r._p.dur.textContent = durText(s); }
  });
}, 250);
setInterval(() => {
  for (const s of S.ex.values()) if (s.state === 'pending' || s.state === 'streaming') { renderLanes(); break; }
}, 1000);
connect();
})();
