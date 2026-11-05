// Team feature: Flow (SPEC.md section 14.1): the agent loop as a sequence diagram.
// One person, one branch: this file is the whole feature. It uses only /api/exchanges and
// app.js's global select() / setFollow() to open an exchange, like the lanes do.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const C = { req: '#334155', model: '#16a34a', call: '#d97706', you: '#2563eb', err: '#dc2626', sub: '#9333ea', tool: '#b45309' };
  const btn = document.getElementById('b-flow');
  if (!btn) return;

  const css = document.createElement('style');
  css.textContent = [
    '#flow-ov{position:fixed;inset:20px;z-index:50;background:#fff;border:1px solid #cbd5e1;border-radius:10px;',
    'box-shadow:0 12px 40px rgba(15,23,42,.25);display:flex;flex-direction:column}',
    '#flow-ov[hidden]{display:none}',
    '#flow-ov .fh{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #e2e8f0;font:600 14px system-ui}',
    '#flow-ov .fh .sub{font-weight:400;color:#64748b}',
    '#flow-ov .fh button{margin-left:auto}',
    '#flow-ov .fb{overflow:auto;flex:1;padding:4px}',
    '#flow-ov svg text{font:12px system-ui;fill:#0f172a}',
    '#flow-ov .lab{cursor:pointer}',
    '#flow-ov .lab:hover text{text-decoration:underline}',
    '#flow-ov text.t{fill:#94a3b8;font-size:11px}',
    '#flow-ov .legend{display:flex;gap:14px;padding:6px 14px;font:12px system-ui;color:#475569;border-bottom:1px solid #f1f5f9}',
    '#flow-ov .legend i{display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:5px}',
  ].join('\n');
  document.head.appendChild(css);

  // overlay: header, legend, scrollable body
  const ov = document.createElement('div');
  ov.id = 'flow-ov';
  ov.hidden = true;
  const head = document.createElement('div');
  head.className = 'fh';
  const title = document.createElement('span');
  title.textContent = 'Flow: the agent loop';
  const sub = document.createElement('span');
  sub.className = 'sub';
  const close = document.createElement('button');
  close.className = 'tb';
  close.textContent = 'Close (Esc)';
  head.append(title, sub, close);
  const legend = document.createElement('div');
  legend.className = 'legend';
  [['request to the model', C.req], ['model answers with text', C.model], ['model asks for a tool', C.call],
    ['tool runs', C.tool], ['subagent', C.sub], ['error', C.err]].forEach(([label, col]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = col;
    s.append(i, document.createTextNode(label));
    legend.appendChild(s);
  });
  const body = document.createElement('div');
  body.className = 'fb';
  ov.append(head, legend, body);
  document.body.appendChild(ov);

  let timer = null;
  let lastSig = '';
  function open() { ov.hidden = false; lastSig = ''; refresh(); timer = setInterval(refresh, 1500); }
  function hide() { ov.hidden = true; clearInterval(timer); timer = null; }
  close.onclick = hide;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden) hide(); });
  btn.disabled = false;
  btn.title = 'The agent loop as a sequence diagram';
  btn.onclick = () => (ov.hidden ? open() : hide());

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const kfmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
  const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function goTo(id) {
    hide();
    try {
      if (typeof setFollow === 'function') setFollow(false);
      if (typeof select === 'function') select(id);
    } catch (e) { /* app.js changed: nothing to open */ }
  }

  async function refresh() {
    let list;
    try {
      const r = await fetch('/api/exchanges', { cache: 'no-store' });
      const d = await r.json();
      list = Array.isArray(d) ? d : (d.exchanges || []);
    } catch (e) { return; }
    const msgs = list.filter(s => s.is_message && s.t_start);
    if (!msgs.length) { body.textContent = 'No message exchanges yet.'; sub.textContent = ''; return; }
    let selId = null;
    try { selId = (typeof S !== 'undefined' && S) ? S.sel : null; } catch (e) { selId = null; }
    const session = (msgs.find(s => s.id === selId) || msgs[msgs.length - 1]).session;
    const ex = msgs.filter(s => s.session === session).sort((a, b) => a.t_start - b.t_start);
    const sig = session + ':' + ex.map(s => s.id + '.' + s.version).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    draw(ex, session);
  }

  // Turn the session's exchanges into time-ordered arrows between lifelines.
  function buildEvents(ex, threads) {
    const byId = new Map(ex.map(s => [s.id, s]));
    const events = [];
    const spawned = new Set();
    for (const s of ex) {
      const lane = s.thread || 'main';
      if (lane === 'main' && /^YOU\b/.test(s.up || '')) {
        events.push({ t: s.t_start - 0.002, from: 'you', to: 'main', label: s.up, color: C.you, id: s.id });
      }
      if (lane === 'main' && /subagent result/i.test(s.up || '') && threads.length) {
        // it comes back from the subagent that finished last before this request
        let src = threads[0];
        let best = -Infinity;
        for (const t of threads) {
          const done = ex.filter(e => e.thread === t && e.t_end && e.t_end <= s.t_start);
          const last = done[done.length - 1];
          if (last && last.t_end > best) { best = last.t_end; src = t; }
        }
        events.push({ t: s.t_start - 0.001, from: src, to: 'main', label: 'result comes back (task-notification)', color: C.sub, id: s.id, dashed: true });
      }
      const red = s.red || s.state === 'error';
      const flags = (s.flags || []).length ? ' · ' + s.flags.join(', ') : '';
      events.push({ t: s.t_start, from: lane, to: 'model', label: '#' + s.id + ' · in ' + kfmt(s.in) + flags, color: red ? C.err : C.req, id: s.id, dashed: red });
      if (!s.t_end) continue;
      const isCall = /^CALL\b/.test(s.down || '');
      const answer = red ? 'ERROR ' + (s.error || s.status || '') : (s.down || s.stop_reason || 'reply');
      events.push({ t: s.t_end, from: 'model', to: lane, label: answer, color: red ? C.err : (isCall ? C.call : C.model), id: s.id });
      const calls = s.calls || [];
      const tools = calls.filter(c => c.name !== 'Agent');
      if (tools.length) {
        const res = tools.map(c => byId.get(c.from)).find(Boolean);
        const failed = tools.some(c => c.state === 'error');
        const tt = res ? res.tool_time : null;
        const took = tt == null ? 'running…' : (tt < 1 ? Math.round(tt * 1000) + ' ms' : tt.toFixed(1) + ' s');
        const names = tools.map(c => c.name + (c.arg_short ? ' ' + c.arg_short : '')).join(', ');
        events.push({ t: s.t_end + 0.0002, from: lane, to: 'tools', label: '⚙ ' + names, color: C.tool, id: s.id });
        events.push({ t: (res ? res.t_start : s.t_end) - 0.0003, from: 'tools', to: lane, label: (failed ? 'ERROR · ' : 'result · ') + took, color: failed ? C.err : C.tool, id: res ? res.id : s.id, dashed: true });
      }
      for (const c of calls.filter(c => c.name === 'Agent')) {
        const child = threads.find(t => !spawned.has(t) && ex.some(e => e.thread === t && e.parent === s.id)) ||
                      threads.find(t => !spawned.has(t));
        if (!child) continue;
        spawned.add(child);
        const first = ex.find(e => e.thread === child);
        events.push({ t: first ? first.t_start - 0.0004 : s.t_end + 0.0004, from: lane, to: child, label: 'Agent · ' + (c.arg_short || 'subagent'), color: C.sub, id: s.id, dashed: true });
      }
    }
    return events.sort((a, b) => a.t - b.t);
  }

  function draw(ex, session) {
    const threads = [];
    for (const s of ex) if (s.thread && s.thread !== 'main' && !threads.includes(s.thread)) threads.push(s.thread);
    // lifelines: You | Claude Code | subagents | Model | Tools
    const lanes = [['you', 'You'], ['main', 'Claude Code']].concat(threads.map(t => [t, 'Claude Code · ' + t]))
      .concat([['model', 'Model'], ['tools', 'Tools']]);
    const X = {};
    lanes.forEach(([key], i) => { X[key] = 150 + i * 200; });
    const xOf = key => (X[key] !== undefined ? X[key] : X.main);
    const events = buildEvents(ex, threads);
    const t0 = ex[0].t_start;
    const rowH = 30;
    const top = 74;
    const W = xOf('tools') + 200;
    const H = top + events.length * rowH + 30;

    body.textContent = '';
    const root = el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, body);
    const defs = el('defs', {}, root);
    for (const name in C) {
      const m = el('marker', { id: 'fa-' + name, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z', fill: C[name] }, m);
    }
    const markerFor = col => 'url(#fa-' + (Object.keys(C).find(n => C[n] === col) || 'req') + ')';

    for (const [key, name] of lanes) {
      const x = X[key];
      const isSub = threads.includes(key);
      el('line', { x1: x, y1: 50, x2: x, y2: H - 8, stroke: isSub ? '#d8b4fe' : '#cbd5e1', 'stroke-dasharray': '4 4' }, root);
      el('rect', { x: x - 80, y: 14, width: 160, height: 32, rx: 7, fill: isSub ? '#faf5ff' : '#f8fafc', stroke: isSub ? C.sub : '#94a3b8' }, root);
      const tx = el('text', { x: x, y: 35, 'text-anchor': 'middle', 'font-weight': '600' }, root);
      tx.textContent = name;
    }
    events.forEach((ev, i) => {
      const y = top + i * rowH;
      const x1 = xOf(ev.from);
      const x2 = xOf(ev.to);
      const tt = el('text', { x: 8, y: y + 4, class: 't' }, root);
      tt.textContent = '+' + (ev.t - t0).toFixed(1) + 's';
      const g = el('g', { class: 'lab' }, root);
      g.addEventListener('click', () => goTo(ev.id));
      el('rect', { x: Math.min(x1, x2), y: y - 18, width: Math.max(Math.abs(x2 - x1), 4), height: 22, fill: 'transparent' }, g);
      el('line', { x1: x1, y1: y, x2: x2 + (x2 > x1 ? -3 : 3), y2: y, stroke: ev.color, 'stroke-width': 1.7,
        'stroke-dasharray': ev.dashed ? '5 4' : '', 'marker-end': markerFor(ev.color) }, g);
      const maxChars = Math.max(16, Math.floor(Math.abs(x2 - x1) / 6.6));
      const t = el('text', { x: Math.min(x1, x2) + 8, y: y - 6 }, g);
      t.textContent = cut(ev.label, maxChars);
      const tip = el('title', {}, g);
      tip.textContent = ev.label + '  (#' + ev.id + ', click to open)';
    });
    const last = ex[ex.length - 1];
    const span = ((last.t_end || last.t_start) - t0).toFixed(1);
    sub.textContent = session + ' · ' + ex.length + ' requests · ' + (threads.length + 1) + ' threads · ' + span + ' s · click an arrow to open it';
  }
})();
