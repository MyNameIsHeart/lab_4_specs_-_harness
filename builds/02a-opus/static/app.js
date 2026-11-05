// Live agent traffic dashboard. Plain JS; all traffic goes into the page as
// text (textContent / text nodes), never as HTML.
'use strict';
(() => {
  const SECTIONS = [
    ['summary', 'Summary', true],
    ['new', 'New in this request', true],
    ['reply', 'Reply', true],
    ['conversation', 'Conversation', false],
    ['system', 'System instructions', false],
    ['tools', 'Tools', false],
    ['raw', 'Raw', false],
  ];
  const KIND = {
    you: ['YOU', '▶'], task: ['TASK', '⇒'], harness: ['HARNESS', '§'],
    model: ['MODEL', '◀'], thinking: ['THINKING', '∴'], call: ['CALL', '↦'],
    result: ['RESULT', '↤'], system: ['SYSTEM', 'Σ'], other: ['OTHER', '?'],
  };
  const HTAGS = 'system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat';
  const ARG_KEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const LIVE = { pending: 1, streaming: 1 };

  const S = {
    ex: new Map(),          // id -> summary
    rows: new Map(),        // id -> row element
    threads: new Map(),     // thread key -> {key, label, kind, sub_index, session, title, agent, parent}
    boot: null, selected: null, detail: null, fetchSeq: 0, refetchTimer: 0,
    liveReply: new Map(),   // id -> {version, reply}
    follow: true, privacy: true, hideNonMsg: true, errorsOnly: false, thread: null,
    newCount: 0, loading: false, maskIds: new Set(), topQueued: false,
    open: loadSections(),   // section name -> open (persisted)
    blocks: new Map(),      // exchange id + block position -> open / show all
  };
  const $ = (id) => document.getElementById(id);
  const tl = $('timeline'), dp = $('detail');

  // ------------------------------------------------------------ helpers
  function loadSections() {
    try { return JSON.parse(localStorage.getItem('monitor.sections') || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSections() {
    try { localStorage.setItem('monitor.sections', JSON.stringify(S.open)); } catch (e) { /* private mode */ }
  }
  function isOpen(name) {
    if (typeof S.open[name] === 'boolean') return S.open[name];
    const d = SECTIONS.find((x) => x[0] === name);
    return d ? d[2] : false;
  }
  function mask(s) {
    if (!S.privacy || !s) return s;
    s = s.replace(EMAIL, '•••@•••');
    for (const id of S.maskIds) if (s.indexOf(id) >= 0) s = s.split(id).join('•••');
    return s;
  }
  // el(): masked text; elr(): text that is already masked.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = mask(String(text));
    return e;
  }
  function elr(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function btn(cls, text, onclick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(e); });
    return b;
  }
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
  const fmtN = (n) => (n || 0).toLocaleString('en-US');
  const fmtT = (t) => (t ? new Date(t * 1000).toTimeString().slice(0, 8) : '');
  const fmtDur = (s) => (s == null ? '' : s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's');
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
  const pct = (x) => Math.round((x || 0) * 100) + '%';
  const baseName = (p) => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
  const trimNl = (t) => String(t).replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  function mainArg(inp, limit) {
    if (!inp || typeof inp !== 'object') return ['', ''];
    for (const k of ARG_KEYS) {
      const v = inp[k];
      if (typeof v === 'string' && v.trim()) return [k, v.trim().replace(/\s+/g, ' ').slice(0, limit || 80)];
    }
    return ['', ''];
  }
  const fullArg = (inp) => mainArg(inp)[1];
  const shortArg = (inp) => { const [k, v] = mainArg(inp, 1e6); return (k === 'file_path' ? baseName(v) : v).slice(0, 80); };
  function splitHarness(text) {
    const re = new RegExp('<(' + HTAGS + ')>([\\s\\S]*?)</\\1>', 'g');
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ h: false, text: text.slice(last, m.index) });
      out.push({ h: true, tag: m[1], text: m[0] });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ h: false, text: text.slice(last) });
    return out;
  }
  const isFinal = (s) => s && !LIVE[s.state];

  // ------------------------------------------------------------ filters, pills, top bar
  function passes(s) {
    if (!s) return false;
    if (S.hideNonMsg && !s.msg) return false;
    if (S.errorsOnly && !(s.red || s.dot)) return false;
    if (S.thread && s.thread_key !== S.thread) return false;
    return true;
  }
  function pillClass(t) {
    if (t.kind === 'sub') return 'pill pill-sub' + (((t.sub_index || 1) - 1) % 4);
    if (t.kind === 'side') return 'pill pill-side';
    return 'pill pill-main';
  }
  function threadPill(t) {
    const multi = new Set([...S.threads.values()].map((x) => x.session)).size > 1;
    const p = btn(pillClass(t) + (S.thread === t.key ? ' active' : ''), (multi ? t.session + ' ' : '') + t.label, () => setThread(t.key));
    p.title = mask(t.session + ' ' + t.label + (t.title ? ' · ' + t.title : '') + ' (click to filter)');
    return p;
  }
  function threadOf(s) {
    return S.threads.get(s.thread_key) || { key: s.thread_key, label: s.thread, kind: s.thread_kind, sub_index: s.sub_index, session: s.session, title: s.thread_title };
  }
  function setThread(key) {
    S.thread = S.thread === key ? null : key;
    applyFilters();
  }
  function renderPills() {
    const box = $('pills');
    box.textContent = '';
    if (!S.threads.size) return;
    const all = btn('pill pill-all' + (S.thread ? '' : ' active'), 'all', () => { S.thread = null; applyFilters(); });
    box.append(all);
    for (const t of S.threads.values()) box.append(threadPill(t));
  }
  function scheduleTop() {
    if (S.topQueued) return;
    S.topQueued = true;
    requestAnimationFrame(() => { S.topQueued = false; renderTop(); });
  }
  function renderTop() {
    let n = 0, tin = 0, cr = 0, out = 0, errs = 0;
    for (const s of S.ex.values()) {
      if (!passes(s)) continue;
      n++;
      tin += s.tokens.in; cr += s.tokens.cache_read; out += s.tokens.out;
      if (s.red || s.dot) errs++;
    }
    const box = $('totals');
    box.textContent = '';
    box.append(el('span', '', n + ' req · in ' + fmtK(tin) + ' (' + pct(tin ? cr / tin : 0) + ' cached) · out ' + fmtK(out) + ' · '));
    box.append(btn('errbtn' + (errs ? ' has' : '') + (S.errorsOnly ? ' active' : ''), errs + (errs === 1 ? ' error' : ' errors'), () => {
      S.errorsOnly = !S.errorsOnly;
      $('f-errors').checked = S.errorsOnly;
      applyFilters();
    }));
  }
  function applyFilters() {
    for (const [id, row] of S.rows) row.hidden = !passes(S.ex.get(id));
    renderPills();
    renderTop();
    if (S.follow) followNewest();
  }
  function renderChip() {
    const c = $('chip');
    c.hidden = S.follow || S.newCount === 0;
    c.textContent = S.newCount + ' new ↑';
  }
  function setFollow(on) {
    S.follow = on;
    $('f-follow').checked = on;
    if (on) { S.newCount = 0; followNewest(); }
    renderChip();
  }
  function followNewest() {
    let best = null;
    for (const s of S.ex.values()) if (passes(s) && (!best || s.id > best.id)) best = s;
    tl.scrollTop = 0;
    if (best && best.id !== S.selected) select(best.id);
  }

  // ------------------------------------------------------------ timeline
  function stateBadge(s) {
    if (LIVE[s.state]) return el('span', 'st st-live', '◌');
    if (s.state === 'error' || (s.status || 0) >= 400) return el('span', 'st st-err', '✗');
    if (s.state === 'aborted') return el('span', 'st st-warn', '⊘');
    return el('span', 'st st-ok', '✓');
  }
  function lineEl(arrow, ln) {
    const d = el('div', 'ln');
    d.append(el('span', 'arrow', arrow));
    if (ln) {
      if (ln.label) d.append(el('span', 'lk k-' + ln.kind, ln.label));
      d.append(el('span', 'lt', ' ' + ln.text));
    }
    return d;
  }
  function buildRow(s) {
    const r = el('div', 'row');
    r.dataset.id = String(s.id);
    if (s.red) r.classList.add('red');
    else if (s.amber) r.classList.add('amber');
    if (!s.msg) r.classList.add('nonmsg');
    if (S.selected === s.id) r.classList.add('sel');
    const l1 = el('div', 'l1');
    l1.append(el('span', 'rid', '#' + s.id), el('span', 'rtime', fmtT(s.t_start)));
    if (s.msg && s.thread_key) l1.append(threadPill(threadOf(s)));
    l1.append(stateBadge(s));
    const dur = el('span', 'dur', LIVE[s.state] ? fmtDur(Date.now() / 1000 - s.t_start) : fmtDur(s.t_end - s.t_start));
    if (LIVE[s.state]) dur.dataset.start = String(s.t_start);
    l1.append(dur);
    if (s.msg && (s.tokens.in || s.tokens.out)) l1.append(el('span', 'tok', fmtK(s.tokens.in) + '/' + fmtK(s.tokens.out)));
    if (s.dot) { const d = el('span', 'dot', '●'); d.title = 'a tool result in this request has is_error'; l1.append(d); }
    r.append(l1);
    if (s.msg) {
      r.append(lineEl('↑', s.up));
      r.append(lineEl('↓', s.down || (LIVE[s.state] ? { kind: 'wait', label: '', text: '…' } : null)));
    } else {
      r.append(el('div', 'ln', s.method + ' ' + s.path + ' ' + (s.status || s.state) + (s.error ? ' · ' + s.error : '')));
    }
    r.title = mask([s.up && s.up.title, s.down && s.down.title, s.error].filter(Boolean).join('\n'));
    return r;
  }
  function placeRow(id, row) {
    row.hidden = !passes(S.ex.get(id));
    const old = S.rows.get(id);
    S.rows.set(id, row);
    if (old) { old.replaceWith(row); return; }
    const top = tl.scrollTop, before = tl.scrollHeight;
    let next = null;
    for (const c of tl.children) if (+c.dataset.id < id) { next = c; break; }
    tl.insertBefore(row, next);
    // Follow live off: new rows never move what the user is looking at.
    if (!S.follow && !row.hidden) tl.scrollTop = top + (tl.scrollHeight - before);
  }
  tl.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    setFollow(false);
    select(+row.dataset.id);
  });
  tl.addEventListener('scroll', () => { if (S.follow && tl.scrollTop > 40) setFollow(false); });
  setInterval(() => {
    const now = Date.now() / 1000;
    for (const d of tl.querySelectorAll('.dur[data-start]')) d.textContent = fmtDur(now - +d.dataset.start);
  }, 250);

  // ------------------------------------------------------------ data flow
  function upsert(s) {
    const old = S.ex.get(s.id);
    if (old && old.version >= s.version) return;
    S.ex.set(s.id, s);
    for (const id of s.ids || []) S.maskIds.add(id);
    if (s.thread_key) {
      const had = S.threads.get(s.thread_key);
      const t = { key: s.thread_key, label: s.thread, kind: s.thread_kind, sub_index: s.sub_index, session: s.session,
        title: s.thread_title || (had && had.title) || '', agent: s.thread_agent, parent: s.thread_parent || (had && had.parent) };
      S.threads.set(s.thread_key, t);
      if (!had || had.title !== t.title) renderPills();
    }
    placeRow(s.id, buildRow(s));
    if (!S.loading && passes(s) && (!old || !passes(old))) onArrival(s);
    if (s.id === S.selected) onSelectedUpdate(s);
    scheduleTop();
  }
  function onArrival(s) {
    if (S.follow) { tl.scrollTop = 0; select(s.id); }
    else { S.newCount++; renderChip(); }
  }
  function onSelectedUpdate(s) {
    if (isFinal(s)) {
      if (!S.detail || S.detail.summary.version < s.version) scheduleRefetch();
    } else if (S.detail) {
      S.detail.summary = s;
      renderLive();
    }
  }
  function onReply(d) {
    S.liveReply.set(d.id, d);
    if (d.id !== S.selected || !S.detail) return;
    if (S.detail.summary.version > d.version && isFinal(S.detail.summary)) return;
    S.detail.reply = d.reply;
    const s = S.ex.get(d.id);
    if (s && s.version >= S.detail.summary.version) S.detail.summary = s;
    renderLive();
  }
  function scheduleRefetch() {
    clearTimeout(S.refetchTimer);
    S.refetchTimer = setTimeout(() => fetchDetail(S.selected), 60);
  }
  function select(id) {
    if (S.selected !== id) {
      const prev = S.rows.get(S.selected);
      if (prev) prev.classList.remove('sel');
      S.selected = id;
      S.detail = null;
      const row = S.rows.get(id);
      if (row) row.classList.add('sel');
      renderDetail(true);
    }
    fetchDetail(id);
  }
  async function fetchDetail(id) {
    if (id == null) return;
    const seq = ++S.fetchSeq;
    let d;
    try {
      const r = await fetch('/api/exchanges/' + id, { cache: 'no-store' });
      if (!r.ok) return;
      d = await r.json();
    } catch (e) { return; }
    if (seq !== S.fetchSeq || S.selected !== id) return;
    const lr = S.liveReply.get(id);
    if (lr && lr.version > d.summary.version) d.reply = lr.reply;
    if (isFinal(d.summary)) S.liveReply.delete(id);
    const s = S.ex.get(id);
    if (s && s.version > d.summary.version) {
      if (isFinal(s)) scheduleRefetch();
      else d.summary = s;
    }
    const same = S.detail && S.detail.summary.id === id;
    S.detail = d;
    renderDetail(!same);
  }
  async function loadList() {
    try {
      const r = await fetch('/api/exchanges', { cache: 'no-store' });
      const list = await r.json();
      S.loading = true;
      list.forEach(upsert);
    } catch (e) { /* the stream will retry */ } finally { S.loading = false; }
    if (S.follow) followNewest();
    renderTop();
  }
  function resetAll() {
    S.ex.clear(); S.rows.clear(); S.threads.clear(); S.liveReply.clear(); S.blocks.clear();
    S.selected = null; S.detail = null; S.newCount = 0; S.thread = null;
    tl.textContent = '';
    renderDetail(true); renderPills(); renderChip(); renderTop();
  }
  function setConn(on) {
    const c = $('conn');
    c.className = 'conn ' + (on ? 'on' : 'off');
    c.textContent = on ? '● live' : '● reconnecting';
  }
  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('hello', (e) => {
      setConn(true);
      const h = JSON.parse(e.data);
      if (S.boot && S.boot !== h.boot) resetAll();
      S.boot = h.boot;
      loadList();
    });
    es.addEventListener('exchange', (e) => upsert(JSON.parse(e.data)));
    es.addEventListener('reply', (e) => onReply(JSON.parse(e.data)));
    es.onerror = () => {
      setConn(false);
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
    };
  }

  // ------------------------------------------------------------ detail
  function current() {
    const s = S.ex.get(S.selected);
    if (S.detail && S.detail.summary.id === S.selected) {
      return { s: s && s.version > S.detail.summary.version ? s : S.detail.summary, d: S.detail };
    }
    return { s, d: null };
  }
  function renderDetail(resetScroll) {
    const keep = dp.scrollTop;
    dp.textContent = '';
    const { s, d } = current();
    if (!s) {
      dp.append(el('div', 'empty', S.ex.size ? 'Select an exchange on the left.' : 'Waiting for traffic… Run the agent with ANTHROPIC_BASE_URL pointing at the proxy.'));
      return;
    }
    dp.append(detailHead(s));
    for (const [name, title] of SECTIONS) dp.append(section(name, title, s, d));
    dp.scrollTop = resetScroll ? 0 : keep;
  }
  function renderLive() {
    const { s, d } = current();
    if (!s) return;
    const head = dp.querySelector('.dhead-wrap');
    if (head) head.replaceWith(detailHead(s));
    for (const name of ['summary', 'reply']) replaceSection(name, s, d);
  }
  function replaceSection(name, s, d) {
    const old = dp.querySelector('section.sec[data-name="' + name + '"]');
    const def = SECTIONS.find((x) => x[0] === name);
    if (old && def) old.replaceWith(section(name, def[1], s, d));
  }
  function detailHead(s) {
    const w = el('div', 'dhead-wrap');
    const h = el('div', 'dhead');
    h.append(el('span', '', '#' + s.id));
    if (s.msg && s.thread_key) {
      h.append(el('span', 'muted', '· ' + s.session));
      h.append(threadPill(threadOf(s)));
    }
    const bits = [s.model, s.status || s.state, s.t_end ? fmtDur(s.t_end - s.t_start) : (LIVE[s.state] ? s.state : '')].filter(Boolean);
    h.append(el('span', '', '· ' + bits.join(' · ')));
    if (s.thread_title) h.append(el('span', 'dtitle', '— ' + s.thread_title));
    w.append(h);
    if (s.msg) {
      const t = s.tokens;
      w.append(el('div', 'dsub', 'in ' + fmtN(t.in) + ' (' + pct(t.cached) + ' cached) · out ' + fmtN(t.out) +
        (t.thinking ? ' (' + fmtN(t.thinking) + ' thinking)' : '') + (s.stop_reason ? ' · ' + s.stop_reason : '')));
    } else {
      w.append(el('div', 'dsub', s.method + ' ' + s.path));
    }
    return w;
  }
  function msgsOf(d) { return d && d.body && Array.isArray(d.body.messages) ? d.body.messages : []; }
  function sectionCount(name, s, d) {
    const body = d && d.body;
    switch (name) {
      case 'summary': return s.state + (s.flags && (s.flags.retry_of || s.flags.history_changed_at != null || s.flags.changes) ? ' · flags' : '');
      case 'new': return s.msg ? '(' + Math.max(0, s.n_msgs - s.new_start) + ' messages)' : '';
      case 'reply': return d && d.reply ? '(' + (d.reply.blocks || []).length + ' blocks' + (LIVE[s.state] ? ', streaming' : '') + ')' : '';
      case 'conversation': return s.msg ? '(' + (s.n_msgs + (d && d.reply && d.reply.blocks && d.reply.blocks.length ? 1 : 0)) + ' messages)' : '';
      case 'system': {
        if (!body) return '';
        const b = sysBlocks(body);
        return '(' + b.length + ' blocks · ' + fmtN(b.reduce((a, x) => a + x.length, 0)) + ' chars)';
      }
      case 'tools': {
        const t = body && Array.isArray(body.tools) ? body.tools : [];
        if (!body) return '';
        const names = t.map((x) => x.name || x.type || '?');
        return '(' + t.length + '): ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '');
      }
      case 'raw': return d ? 'request ' + fmtBytes(s.req_size) + ' · reply ' + fmtBytes((d.raw_reply || '').length) : '';
    }
    return '';
  }
  function section(name, title, s, d) {
    const sec = el('section', 'sec');
    sec.dataset.name = name;
    const open = isOpen(name);
    const h = el('button', 'sec-h');
    h.type = 'button';
    h.append(el('span', 'tw', open ? '▼' : '▶'), el('span', 'sec-t', title), el('span', 'sec-c', sectionCount(name, s, d)));
    h.addEventListener('click', () => {
      S.open[name] = !isOpen(name);
      saveSections();
      const c = current();
      if (c.s) replaceSection(name, c.s, c.d);
    });
    sec.append(h);
    if (open) {
      const b = el('div', 'sec-b');
      try { fillSection(name, b, s, d); } catch (e) { b.append(el('div', 'err', 'render error: ' + e.message)); }
      sec.append(b);
    }
    return sec;
  }
  function needBody(b, d) {
    if (!d) { b.append(el('div', 'muted', 'loading…')); return false; }
    if (d.evicted) { b.append(el('div', 'muted', 'evicted (bodies over 300 MB were dropped; the summary stays)')); return false; }
    if (!d.body) { b.append(el('div', 'muted', d.body_text ? 'not JSON (see Raw)' : 'no body')); return false; }
    return true;
  }
  function fillSection(name, b, s, d) {
    if (name === 'summary') return fillSummary(b, s, d);
    if (name === 'raw') return fillRaw(b, s, d);
    if (name === 'reply') return fillReply(b, s, d);
    if (!s.msg) { b.append(el('div', 'muted', 'not a message request (see Raw)')); return; }
    if (!needBody(b, d)) return;
    if (name === 'new') return fillNew(b, s, d);
    if (name === 'conversation') return fillConversation(b, s, d);
    if (name === 'system') return fillSystem(b, s, d);
    if (name === 'tools') return fillTools(b, s, d);
  }
  function exLink(id) {
    return btn('xlink', '#' + id, () => { setFollow(false); select(id); });
  }
  function kv(b, k, v, bad) {
    const r = el('div', 'kv' + (bad ? ' bad' : ''));
    r.append(el('span', 'k', k));
    const vv = el('span', 'v');
    if (typeof v === 'string') vv.textContent = mask(v); else vv.append(v);
    r.append(vv);
    b.append(r);
    return vv;
  }
  function fillSummary(b, s, d) {
    const t = s.tokens || {};
    kv(b, 'model', s.model || '—');
    kv(b, 'status', (s.status || '—') + ' · ' + s.state + (s.stop_reason ? ' · stop_reason ' + s.stop_reason : ''), s.red);
    kv(b, 'timing', 'start ' + fmtT(s.t_start) + (s.t_first ? ' · first byte +' + fmtDur(s.t_first - s.t_start) : '') +
      (s.t_end ? ' · total ' + fmtDur(s.t_end - s.t_start) : ' · running'));
    if (s.msg) {
      kv(b, 'in', fmtN(t.in) + ' = input ' + fmtN(t.input) + ' + cache read ' + fmtN(t.cache_read) + ' + cache write ' + fmtN(t.cache_write) + ' (' + pct(t.cached) + ' cached)');
      kv(b, 'out', fmtN(t.out) + (t.thinking ? ' (' + fmtN(t.thinking) + ' thinking)' : ''));
    }
    kv(b, 'request size', fmtBytes(s.req_size) + (s.msg ? ' · ' + s.n_msgs + ' messages, ' + Math.max(0, s.n_msgs - s.new_start) + ' new' : ''));
    if (s.msg) {
      const th = threadOf(s);
      const v = kv(b, 'thread', '');
      v.append(el('span', '', s.session + ' '), threadPill(th), el('span', '', th.title ? ' ' + th.title : ''));
      const parent = s.thread_parent || th.parent;
      if (parent) { v.append(el('span', 'muted', ' · started by the Agent call in ')); v.append(exLink(parent.ex)); }
    }
    const f = s.flags || {};
    if (f.retry_of) { const v = kv(b, 'retry of', ''); v.append(exLink(f.retry_of)); }
    if (f.history_changed_at != null) kv(b, 'history changed', 'at message ' + f.history_changed_at, true);
    if (f.changes) kv(b, 'changed vs prev', f.changes.join(', '));
    if (s.error) kv(b, 'error', s.error, true);
    if (d && d.reply && d.reply.unknown) kv(b, 'unknown events', String(d.reply.unknown) + ' (kept in Raw)');
    if (s.evicted) kv(b, 'bodies', 'evicted');
  }

  // ------------------------------------------------------------ message rendering
  function ctxFor(s, d) {
    const tools = new Map();
    const rmap = (d && d.reply_map) || {};
    msgsOf(d).forEach((m, i) => {
      if (m && m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'tool_use') tools.set(b.id, { name: b.name, input: b.input, from: rmap[i] });
      }
    });
    const textKind = s.thread_kind === 'sub' ? 'task' : s.thread_kind === 'side' ? 'harness' : 'you';
    return { id: s.id, s, d, tools, textKind };
  }
  function card(kind, label) {
    const c = el('div', 'card');
    c.dataset.kind = kind;
    const h = el('div', 'card-h');
    h.append(el('span', 'ic', KIND[kind][1]), el('span', 'lb', label));
    const body = el('div', 'card-b');
    c.append(h, body);
    return { c, h, body };
  }
  function paint(wrap, text, mode) {
    if (mode === 'md') renderMd(wrap, text);
    else if (mode === 'prose') wrap.append(elr('div', 'prose', text));
    else wrap.append(elr('pre', 'mono', text));
  }
  // Long text: over 10 lines or 800 chars shows 6 lines (max 500 chars) + "Show all".
  function longText(parent, text, key, mode) {
    const wrap = el('div', 'lt-wrap');
    const t = mask(String(text == null ? '' : text));
    const draw = () => {
      wrap.textContent = '';
      const lines = (t.match(/\n/g) || []).length + 1;
      const long = lines > 10 || t.length > 800;
      const all = S.blocks.get(key + '|all') === true;
      let shown = t;
      if (long && !all) {
        shown = t.split('\n', 6).join('\n');
        if (shown.length > 500) shown = shown.slice(0, 500);
        shown += '…';
      }
      paint(wrap, shown, mode);
      if (long) {
        wrap.append(btn('more', all ? 'Show less' : 'Show all (' + fmtN(lines) + ' lines, ' + fmtN(t.length) + ' chars)', () => {
          S.blocks.set(key + '|all', !all);
          draw();
        }));
      }
    };
    draw();
    parent.append(wrap);
  }
  // Minimal markdown from DOM nodes: **bold**, `code`, ``` fences, # headings.
  function renderMd(parent, text) {
    const box = elr('div', 'md');
    const lines = text.split('\n');
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const p = elr('div', 'md-p');
      inlineMd(p, buf.join('\n'));
      box.append(p);
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\s*```/.test(ln)) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        box.append(elr('pre', 'md-code mono', code.join('\n')));
      } else if (/^#{1,6}\s/.test(ln)) {
        flush();
        box.append(elr('div', 'md-h', ln.replace(/^#{1,6}\s+/, '')));
      } else buf.push(ln);
    }
    flush();
    parent.append(box);
  }
  function inlineMd(p, text) {
    const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) p.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1] != null) p.append(elr('strong', '', m[1])); else p.append(elr('code', 'md-ic', m[2]));
      last = re.lastIndex;
    }
    if (last < text.length) p.append(document.createTextNode(text.slice(last)));
  }
  function collapsible(c, h, body, key, firstLine, full) {
    const open = S.blocks.get(key) === true;
    const draw = (o) => {
      body.textContent = '';
      if (o) full(body); else body.append(el('div', 'first-line', firstLine));
    };
    const t = btn('tog', open ? 'collapse' : 'expand', () => {
      const o = !(S.blocks.get(key) === true);
      S.blocks.set(key, o);
      t.textContent = o ? 'collapse' : 'expand';
      draw(o);
    });
    h.append(t);
    draw(open);
  }
  function findSubThread(text) {
    for (const t of S.threads.values()) if (t.kind === 'sub' && t.agent && text.indexOf(t.agent) >= 0) return t;
    return null;
  }
  function harnessCard(seg, key) {
    const isTask = seg.tag === 'task-notification' || seg.text.indexOf('<task-notification>') >= 0;
    const { c, h, body } = card('harness', isTask ? 'HARNESS · subagent result' : 'HARNESS · ' + seg.tag);
    if (isTask) {
      const t = findSubThread(seg.text);
      if (t) { h.append(el('span', 'muted', 'from')); h.append(threadPill(t)); }
    }
    const summ = isTask && /<summary>([\s\S]*?)<\/summary>/.exec(seg.text);
    const lines = seg.text.replace(/<\/?[a-z][a-z0-9_-]*>/gi, '').split('\n').map((x) => x.trim()).filter(Boolean);
    const first = (summ ? summ[1].trim() : lines[0] || '').slice(0, 200);
    collapsible(c, h, body, key, first, (b) => longText(b, seg.text, key + '|full', 'mono'));
    return c;
  }
  function userText(parent, text, ctx, key) {
    splitHarness(String(text)).forEach((seg, k) => {
      const kk = key + '|s' + k;
      if (seg.h) { parent.append(harnessCard(seg, kk)); return; }
      if (!seg.text.trim()) return;
      const kind = ctx.textKind;
      const { c, h, body } = card(kind, KIND[kind][0]);
      if (kind === 'task') {
        const p = ctx.s.thread_parent || threadOf(ctx.s).parent;
        if (p) { h.append(el('span', 'muted', 'from the Agent call in')); h.append(exLink(p.ex)); }
      }
      longText(body, trimNl(seg.text), kk, kind === 'harness' ? 'mono' : 'prose');
      parent.append(c);
    });
  }
  function toolText(parent, text, key) {
    splitHarness(String(text)).forEach((seg, k) => {
      const kk = key + '|s' + k;
      if (seg.h) parent.append(harnessCard(seg, kk));
      else if (seg.text.trim()) { const w = el('div', 'out'); longText(w, trimNl(seg.text), kk, 'mono'); parent.append(w); }
    });
  }
  function stripBase64(x) {
    if (Array.isArray(x)) return x.map(stripBase64);
    if (x && typeof x === 'object') {
      if (x.type === 'base64' && typeof x.data === 'string') {
        return '[' + (x.media_type || 'data') + ', ' + Math.round(x.data.length * 0.75 / 1024) + ' KB]';
      }
      const o = {};
      for (const k of Object.keys(x)) o[k] = stripBase64(x[k]);
      return o;
    }
    return x;
  }
  function otherCard(b, key) {
    const { c, body } = card('other', 'OTHER · ' + ((b && b.type) || typeof b));
    longText(body, JSON.stringify(stripBase64(b), null, 2), key, 'mono');
    return c;
  }
  function modelCard(text, key) {
    const { c, body } = card('model', 'MODEL');
    longText(body, text, key, 'md');
    return c;
  }
  function thinkingCard(b, key, tokens) {
    const { c, h, body } = card('thinking', 'THINKING');
    const t = b.thinking || '';
    if (!t) {
      const n = b.estimated_tokens || tokens;
      body.append(el('span', 'chip', b.type === 'redacted_thinking' ? 'thinking redacted' : 'thinking hidden' + (n ? ' · ' + fmtN(n) + ' tokens' : '')));
      return c;
    }
    collapsible(c, h, body, key, t.split('\n')[0].slice(0, 200), (bb) => longText(bb, t, key + '|full', 'prose'));
    return c;
  }
  function callCard(b, key, ctx) {
    const { c, h, body } = card('call', 'CALL · ' + (b.name || '?'));
    const arg = fullArg(b.input);
    if (arg) h.append(el('span', 'arg', arg));
    if (b.name === 'Agent' || b.name === 'Task') {
      for (const t of S.threads.values()) {
        if (t.parent && t.parent.call === b.id) { h.append(el('span', 'muted', 'started')); h.append(threadPill(t)); }
      }
    }
    let text;
    if (b.partial_json != null) text = b.partial_json;
    else if (b.input_raw != null) text = b.input_raw;
    else text = JSON.stringify(b.input == null ? {} : b.input, null, 2);
    longText(body, text, key + '|in', 'mono');
    return c;
  }
  function resultCard(b, info, key) {
    const { c, h, body } = card('result', 'RESULT · ' + (info ? info.name : '?'));
    if (b.is_error) { c.classList.add('is-error'); h.append(el('span', 'errlbl', 'ERROR')); }
    const arg = info ? fullArg(info.input) : '';
    if (arg) h.append(el('span', 'arg', arg));
    const content = b.content;
    if (typeof content === 'string') toolText(body, content, key);
    else if (Array.isArray(content)) {
      content.forEach((x, k) => {
        if (x && x.type === 'text') toolText(body, x.text || '', key + '|c' + k);
        else body.append(otherCard(x, key + '|c' + k));
      });
    } else if (content != null) longText(body, JSON.stringify(content, null, 2), key, 'mono');
    return c;
  }
  function callRef(info, prefix) {
    const hd = el('div', 'callref');
    hd.append(el('span', 'lk k-call', prefix || 'CALL'));
    hd.append(el('span', '', ' · ' + (info ? info.name : '?') + (info && shortArg(info.input) ? ' ' + shortArg(info.input) : '')));
    if (info && info.from) { hd.append(el('span', '', ' · from ')); hd.append(exLink(info.from)); }
    hd.title = mask(info ? fullArg(info.input) : '');
    return hd;
  }
  function renderBlock(parent, b, role, ctx, key, opts) {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') {
      if (role === 'assistant') parent.append(modelCard(b.text || '', key));
      else userText(parent, b.text || '', ctx, key);
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      parent.append(thinkingCard(b, key, opts && opts.thinkingTokens));
    } else if (b.type === 'tool_use') {
      parent.append(callCard(b, key, ctx));
    } else if (b.type === 'tool_result') {
      const info = ctx.tools.get(b.tool_use_id);
      if (opts && opts.callHeader) parent.append(callRef(info));
      parent.append(resultCard(b, info, key));
    } else parent.append(otherCard(b, key));
  }
  function renderMessage(parent, m, i, sec, ctx, opts) {
    if (!m || typeof m !== 'object') return;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    blocks.forEach((b, j) => renderBlock(parent, b, m.role, ctx, ctx.id + '|' + sec + '|m' + i + '|b' + j, opts));
  }
  function fillNew(b, s, d) {
    const ctx = ctxFor(s, d);
    const msgs = msgsOf(d);
    if (d.reply_of) {
      const r = el('div', 'muted');
      r.append(el('span', '', '↳ reply of '));
      r.append(exLink(d.reply_of));
      b.append(r);
    }
    const f = s.flags || {};
    if (f.retry_of) { const r = el('div', 'flag'); r.append(el('span', '', 'retry of ')); r.append(exLink(f.retry_of)); b.append(r); }
    if (f.history_changed_at != null) b.append(el('div', 'flag', 'history changed at message ' + f.history_changed_at));
    const start = Math.max(0, d.new_start || 0);
    if (start >= msgs.length) b.append(el('div', 'muted', 'no new messages'));
    for (let i = start; i < msgs.length; i++) renderMessage(b, msgs[i], i, 'new', ctx, { callHeader: true });
  }
  function fillReply(b, s, d) {
    const r = d && d.reply;
    if (!d && !LIVE[s.state] && s.msg) { b.append(el('div', 'muted', 'loading\u2026')); return; }
    if (!r) {
      b.append(el('div', 'muted', LIVE[s.state] ? 'waiting for the reply…' : s.error ? 'no reply: ' + s.error : 'no reply'));
      return;
    }
    if (r.error) b.append(el('div', 'kv bad', 'SSE error: ' + JSON.stringify(r.error)));
    const ctx = ctxFor(s, d);
    const calls = new Map((s.calls || []).map((c) => [c.id, c]));
    (r.blocks || []).forEach((blk, j) => {
      const key = s.id + '|reply|b' + j;
      if (blk.type !== 'tool_use') { renderBlock(b, blk, 'assistant', ctx, key, { thinkingTokens: s.tokens.thinking }); return; }
      b.append(callCard(blk, key, ctx));
      const res = d.results && d.results[blk.id];
      const call = calls.get(blk.id);
      const j2 = el('div', 'joined');
      if (res) {
        const hd = el('div', 'callref');
        hd.append(el('span', 'lk k-result', 'RESULT'), el('span', '', ' from '));
        hd.append(exLink(res.from));
        j2.append(hd);
        j2.append(resultCard({ type: 'tool_result', tool_use_id: blk.id, content: res.content, is_error: res.is_error }, { name: blk.name, input: blk.input }, key + '|res'));
      } else if (call && call.state === 'none') {
        j2.append(el('span', 'chip amber', 'no result'));
      } else if (blk.partial_json != null) {
        j2.append(el('span', 'chip live', 'streaming input…'));
      } else {
        j2.append(el('span', 'chip', 'waiting for result'));
      }
      b.append(j2);
    });
    if (LIVE[s.state]) b.append(el('span', 'chip live', 'streaming…'));
    else if (r.stop_reason) b.append(el('span', 'chip' + (r.stop_reason === 'max_tokens' ? ' amber' : ''), 'stop_reason: ' + r.stop_reason));
  }
  function fillConversation(b, s, d) {
    const ctx = ctxFor(s, d);
    const rmap = d.reply_map || {};
    msgsOf(d).forEach((m, i) => {
      const isModel = m && m.role === 'assistant';
      const w = el('div', 'msg' + (isModel ? ' msg-model' : ''));
      const hd = el('div', 'msg-h');
      if (isModel) {
        hd.append(el('span', '', 'MODEL'));
        const from = rmap[i];
        if (from) {
          hd.append(el('span', '', '·'));
          hd.append(exLink(from));
          const ps = S.ex.get(from);
          if (ps && ps.stop_reason) hd.append(el('span', '', '· ' + ps.stop_reason));
        }
      } else hd.append(el('span', '', 'AGENT → MODEL'));
      if (i >= d.new_start) hd.append(el('span', 'new', 'NEW'));
      w.append(hd);
      renderMessage(w, m, i, 'conv', ctx, null);
      b.append(w);
    });
    const r = d.reply;
    if (r && r.blocks && r.blocks.length) {
      const w = el('div', 'msg msg-model');
      const hd = el('div', 'msg-h');
      hd.append(el('span', '', 'MODEL · #' + s.id + (r.stop_reason ? ' · ' + r.stop_reason : '') + ' · this reply'));
      w.append(hd);
      r.blocks.forEach((blk, j) => renderBlock(w, blk, 'assistant', ctx, s.id + '|conv|reply|b' + j, { thinkingTokens: s.tokens.thinking }));
      b.append(w);
    }
  }
  function sysBlocks(body) {
    const sys = body.system;
    const list = typeof sys === 'string' ? [{ type: 'text', text: sys }] : Array.isArray(sys) ? sys : [];
    return list.map((x) => (x && typeof x.text === 'string' ? x.text : JSON.stringify(x, null, 2)));
  }
  function fillSystem(b, s, d) {
    sysBlocks(d.body).forEach((text, i) => {
      const { c, h, body } = card('system', 'SYSTEM · block ' + (i + 1));
      h.append(el('span', 'arg', fmtN(text.length) + ' chars'));
      body.append(el('pre', 'mono', text));   // in full: the section itself is the collapse
      b.append(c);
    });
  }
  function toolItem(t, key) {
    const w = el('div', 'tool');
    const open = S.blocks.get(key) === true;
    const hd = el('button', 'tool-h');
    hd.type = 'button';
    hd.append(el('span', 'tw', open ? '▼' : '▶'), el('span', 'tool-n', t.name || t.type || '?'),
      el('span', 'muted', fmtN((t.description || '').length) + ' chars'));
    hd.addEventListener('click', () => { S.blocks.set(key, !open); w.replaceWith(toolItem(t, key)); });
    w.append(hd);
    if (open) {
      const body = el('div', 'tool-b');
      if (t.description) longText(body, t.description, key + '|d', 'prose');
      body.append(el('div', 'subh', 'input schema'));
      longText(body, JSON.stringify(t.input_schema || t, null, 2), key + '|s', 'mono');
      w.append(body);
    }
    return w;
  }
  function fillTools(b, s, d) {
    const tools = Array.isArray(d.body.tools) ? d.body.tools : [];
    if (!tools.length) b.append(el('div', 'muted', 'no tools (a side request)'));
    tools.forEach((t, i) => b.append(toolItem(t || {}, s.id + '|tools|' + i)));
  }
  function headerText(list) { return (list || []).map((x) => x[0] + ': ' + x[1]).join('\n'); }
  function fillRaw(b, s, d) {
    if (!d) { b.append(el('div', 'muted', 'loading…')); return; }
    b.append(el('div', 'subh', s.method + ' ' + s.path));
    b.append(el('div', 'subh', 'Request headers'));
    b.append(el('pre', 'mono', headerText(d.req_headers)));
    b.append(el('div', 'subh', 'Request body'));
    if (d.evicted) b.append(el('div', 'muted', 'evicted'));
    else if (d.body) longText(b, JSON.stringify(d.body, null, 2), s.id + '|raw|body', 'mono');
    else if (d.body_text) longText(b, d.body_text, s.id + '|raw|body', 'mono');
    else b.append(el('div', 'muted', 'empty'));
    b.append(el('div', 'subh', 'Response headers' + (s.status ? ' (' + s.status + ')' : '')));
    b.append(el('pre', 'mono', headerText(d.resp_headers) || '—'));
    b.append(el('div', 'subh', 'Reply (raw)'));
    if (d.evicted) b.append(el('div', 'muted', 'evicted'));
    else if (d.raw_reply) longText(b, d.raw_reply, s.id + '|raw|reply', 'mono');
    else b.append(el('div', 'muted', 'empty'));
  }

  // ------------------------------------------------------------ controls
  $('chip').addEventListener('click', () => setFollow(true));
  $('f-follow').addEventListener('change', (e) => setFollow(e.target.checked));
  $('f-errors').addEventListener('change', (e) => { S.errorsOnly = e.target.checked; applyFilters(); });
  $('f-nonmsg').addEventListener('change', (e) => { S.hideNonMsg = e.target.checked; applyFilters(); });
  $('f-privacy').addEventListener('change', (e) => {
    S.privacy = e.target.checked;
    for (const s of S.ex.values()) placeRow(s.id, buildRow(s));
    renderPills();
    renderDetail(false);
  });

  renderDetail(true);
  renderTop();
  connect();
})();
