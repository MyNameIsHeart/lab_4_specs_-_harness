// Team feature: Growth (SPEC.md section 14.2): how the context grows, and what caching does.
// One person, one branch: this file is the whole feature. It uses only /api/exchanges, and
// opens an exchange by clicking its timeline row (app.js keeps its functions private).
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const C = { read: '#9ca3af', write: '#b45309', unc: '#2563eb', out: '#16a34a', grid: 'rgba(100,116,139,.35)', axis: '#64748b' };   // SVG attributes: no var(), so greys that read on light and dark
  const SUBCOL = ['#9333ea', '#db2777', '#a16207', '#4d7c0f'];   // same as app.js pillColor()
  const btn = document.getElementById('b-growth');
  if (!btn) return;

  const css = document.createElement('style');
  css.textContent = [
    '#growth-ov{position:fixed;inset:20px;z-index:50;background:var(--panel,#fff);color:var(--fg,#0f172a);border:1px solid var(--line,#cbd5e1);border-radius:10px;',
    'box-shadow:0 12px 40px rgba(15,23,42,.25);display:flex;flex-direction:column}',
    '#growth-ov[hidden]{display:none}',
    '#growth-ov .gh{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line,#e2e8f0);font:600 14px system-ui}',
    '#growth-ov .gh .sub{font-weight:400;color:var(--muted,#64748b)}',
    '#growth-ov .gh button{margin-left:auto}',
    '#growth-ov .banner{padding:12px 14px;border-bottom:1px solid var(--line2,#f1f5f9)}',
    '#growth-ov .grew{font:600 20px system-ui;color:var(--fg,#0f172a);margin-bottom:8px}',
    '#growth-ov .kpis{display:flex;gap:28px;flex-wrap:wrap;font:13px system-ui;color:var(--muted,#475569)}',
    '#growth-ov .kpis b{display:block;font:600 17px system-ui;color:var(--fg,#0f172a)}',
    '#growth-ov .legend{display:flex;gap:14px;padding:6px 14px;font:12px system-ui;color:var(--muted,#475569);border-bottom:1px solid var(--line2,#f1f5f9);flex-wrap:wrap}',
    '#growth-ov .legend i{display:inline-block;width:12px;height:12px;vertical-align:-2px;margin-right:5px;border-radius:2px}',
    '#growth-ov .legend i.ln{height:3px;width:18px;vertical-align:middle;border-radius:0}',
    '#growth-ov .legend i.ol{background:transparent;border:2px solid #9333ea}',
    '#growth-ov .gb{overflow:auto;flex:1;padding:4px 8px}',
    '#growth-ov svg text{font:11px system-ui;fill:var(--muted,#475569)}',
    '#growth-ov .bar{cursor:pointer}',
    '#growth-ov .bar:hover rect.hit{fill:rgba(37,99,235,.07)}',
    '#growth-tip{position:fixed;z-index:60;pointer-events:none;background:var(--code-bg,#0f172a);color:var(--code-fg,#f8fafc);border:1px solid var(--line,transparent);font:12px/1.45 system-ui;',
    'padding:7px 9px;border-radius:6px;white-space:pre;box-shadow:0 4px 14px rgba(0,0,0,.25)}',
    '#growth-tip[hidden]{display:none}',
  ].join('\n');
  document.head.appendChild(css);

  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // overlay: header, banner, legend, scrollable chart
  const ov = mk('div');
  ov.id = 'growth-ov';
  ov.hidden = true;
  const head = mk('div', 'gh');
  const sub = mk('span', 'sub');
  const close = mk('button', 'tb', 'Close (Esc)');
  head.append(mk('span', null, 'Growth: every request resends the whole conversation'), sub, close);
  const banner = mk('div', 'banner');
  const legend = mk('div', 'legend');
  [['cache read', C.read, ''], ['cache write', C.write, ''], ['uncached input', C.unc, ''],
    ['output tokens (right axis)', C.out, 'ln'], ['subagent bar (outlined in its thread colour)', '', 'ol']].forEach(([label, col, k]) => {
    const s = mk('span');
    const i = mk('i', k);
    if (col) i.style.background = col;
    s.append(i, document.createTextNode(label));
    legend.appendChild(s);
  });
  const body = mk('div', 'gb');
  ov.append(head, banner, legend, body);
  document.body.appendChild(ov);
  const tip = mk('div');
  tip.id = 'growth-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  let timer = null;
  let lastSig = '';
  function open() { ov.hidden = false; lastSig = ''; refresh(); timer = setInterval(refresh, 1500); }
  function hide() { ov.hidden = true; tip.hidden = true; clearInterval(timer); timer = null; }
  close.onclick = hide;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden) hide(); });
  btn.disabled = false;
  btn.title = 'How the context grows, and what caching does';
  btn.onclick = () => (ov.hidden ? open() : hide());

  function svg(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const kfmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n || 0)));
  const num = n => Math.round(n || 0).toLocaleString();
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');
  function threadColor(t) {
    if (!t || t === 'main') return null;
    const m = /^sub-(\d+)$/.exec(t);
    return m ? SUBCOL[(m[1] - 1) % 4] : '#475569';
  }
  // Open an exchange the way a click on its timeline row does (follow off, then select).
  function goTo(id) {
    hide();
    const row = document.querySelector('#timeline [data-id="' + id + '"]');
    if (row) { row.click(); row.scrollIntoView({ block: 'nearest' }); }
  }
  // The selected exchange's session, else the newest one (as Flow and Stats do).
  function currentSession(msgs) {
    const selRow = document.querySelector('#timeline .sel');
    const selId = selRow ? Number(selRow.dataset.id) : null;
    const s = msgs.find(x => x.id === selId) || msgs[msgs.length - 1];
    return s.session;
  }
  // Round an axis maximum up to a value whose quarters read well.
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  async function refresh() {
    let list;
    try {
      const r = await fetch('/api/exchanges', { cache: 'no-store' });
      const d = await r.json();
      list = Array.isArray(d) ? d : (d.exchanges || []);
    } catch (e) { return; }
    const msgs = list.filter(s => s.is_message).sort((a, b) => a.id - b.id);
    if (!msgs.length) {
      banner.textContent = '';
      body.textContent = 'No message exchanges yet.';
      sub.textContent = '';
      lastSig = '';
      return;
    }
    const session = currentSession(msgs);
    const ex = msgs.filter(s => s.session === session);
    const sig = session + ':' + ex.map(s => s.id + '.' + s.version).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    drawBanner(ex);
    drawChart(ex);
    sub.textContent = session + ' · ' + ex.length + ' message exchanges · hover a bar for numbers, click to open it';
  }

  // Context growth along one thread: main if present, else the thread with most requests.
  function growthThread(ex) {
    const counts = {};
    ex.forEach(s => { if (s.thread !== 'side' && s.in) counts[s.thread] = (counts[s.thread] || 0) + 1; });
    if (counts.main) return 'main';
    let best = null;
    for (const t in counts) if (best === null || counts[t] > counts[best]) best = t;
    return best;
  }

  function drawBanner(ex) {
    let inp = 0, cr = 0, cw = 0, cw1 = 0, out = 0;
    ex.forEach(s => { inp += s.input || 0; cr += s.cache_read || 0; cw += s.cache_write || 0; cw1 += s.cache_write_1h || 0; out += s.out || 0; });
    const tin = inp + cr + cw;
    // same formula as Stats: a cache read costs 0.1x, a write 1.25x (5 min) or 2x (1 h)
    const actual = inp + 0.1 * cr + 1.25 * (cw - cw1) + 2 * cw1;
    const saved = tin ? ((1 - actual / tin) * 100).toFixed(1) + '%' : '-';

    banner.textContent = '';
    const t = growthThread(ex);
    const seq = ex.filter(s => s.thread === t && s.in);
    const grew = mk('div', 'grew');
    if (seq.length >= 2) {
      const x = seq[0].in, y = seq[seq.length - 1].in;
      const per = (y - x) / (seq.length - 1);
      grew.textContent = 'The context grew from ' + num(x) + ' to ' + num(y) + ' tokens, ' +
        (per >= 0 ? '+' : '−') + num(Math.abs(per)) + ' per turn' + (t !== 'main' ? ' (' + t + ')' : '') +
        ' — and every request sent all of it again.';
    } else if (seq.length === 1) {
      grew.textContent = 'The context is ' + num(seq[0].in) + ' tokens after one request. Growth shows from the second turn.';
    } else {
      grew.textContent = 'Waiting for the first finished request…';
    }
    const kpis = mk('div', 'kpis');
    const kpi = (label, value) => { const d = mk('div', null, label); d.prepend(mk('b', null, value)); kpis.appendChild(d); };
    kpi('total input tokens', num(tin));
    kpi('cache-hit share (cache read / input)', pct(cr, tin));
    kpi('input cost saved by caching', saved);
    kpi('uncached · cache write · cache read', kfmt(inp) + ' · ' + kfmt(cw) + ' · ' + kfmt(cr));
    kpi('output tokens', num(out));
    banner.append(grew, kpis);
  }

  function drawChart(ex) {
    const n = ex.length;
    const L = 70, R = 70, T = 16, B = 46;
    const plotH = Math.max(220, Math.min(460, (window.innerHeight || 800) - 300));
    const step = Math.max(14, Math.min(44, Math.floor(((body.clientWidth || 1000) - L - R - 10) / n)));
    const bw = Math.max(8, Math.round(step * 0.72));
    const W = L + R + n * step;
    const H = T + plotH + B;
    const maxIn = niceMax(Math.max(1, ...ex.map(s => s.in || 0)));
    const maxOut = niceMax(Math.max(1, ...ex.map(s => s.out || 0)));
    const yIn = v => T + plotH - (v / maxIn) * plotH;
    const yOut = v => T + plotH - (v / maxOut) * plotH;

    body.textContent = '';
    const root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, body);

    // grid and axes
    for (let i = 0; i <= 4; i++) {
      const y = T + plotH - (i / 4) * plotH;
      svg('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: C.grid }, root);
      const a = svg('text', { x: L - 6, y: y + 4, 'text-anchor': 'end' }, root);
      a.textContent = kfmt(maxIn * i / 4);
      const b = svg('text', { x: W - R + 6, y: y + 4, fill: C.out }, root);
      b.textContent = kfmt(maxOut * i / 4);
      b.style.fill = C.out;
    }
    const ax1 = svg('text', { x: 12, y: T + plotH / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (T + plotH / 2) + ')' }, root);
    ax1.textContent = 'input tokens per request';
    const ax2x = W - 10;
    const ax2 = svg('text', { x: ax2x, y: T + plotH / 2, 'text-anchor': 'middle', transform: 'rotate(90 ' + ax2x + ' ' + (T + plotH / 2) + ')' }, root);
    ax2.textContent = 'output tokens';
    ax2.style.fill = C.out;

    // stacked bars: cache read at the bottom (the resent history), then cache write, then uncached
    const pts = [];
    const labelEvery = Math.ceil(n / Math.max(1, Math.floor((n * step) / 34)));
    ex.forEach((s, i) => {
      const x = L + i * step + (step - bw) / 2;
      const cx = x + bw / 2;
      const g = svg('g', { class: 'bar' }, root);
      svg('rect', { class: 'hit', x: L + i * step, y: T, width: step, height: plotH, fill: 'transparent' }, g);
      const parts = [[s.cache_read || 0, C.read], [s.cache_write || 0, C.write], [s.input || 0, C.unc]];
      let acc = 0;
      for (const [v, col] of parts) {
        if (v <= 0) continue;
        const y1 = yIn(acc + v), y0 = yIn(acc);
        svg('rect', { x: x, y: y1, width: bw, height: Math.max(0.5, y0 - y1), fill: col }, g);
        acc += v;
      }
      const tc = threadColor(s.thread);
      if (!s.in && (s.state === 'pending' || s.state === 'streaming')) {
        svg('rect', { x: x, y: T + plotH - 6, width: bw, height: 6, fill: 'none', stroke: '#94a3b8', 'stroke-dasharray': '2 2' }, g);
      } else if (tc && acc > 0) {
        svg('rect', { x: x - 1, y: yIn(acc) - 1, width: bw + 2, height: yIn(0) - yIn(acc) + 2, fill: 'none', stroke: tc, 'stroke-width': 2 }, g);
      }
      if (s.red || s.state === 'error') {
        const m = svg('text', { x: cx, y: yIn(acc) - 4, 'text-anchor': 'middle' }, g);
        m.textContent = '✗';
        m.style.fill = '#dc2626';
      }
      if (i % labelEvery === 0 || i === n - 1) {
        const lb = svg('text', { x: cx, y: T + plotH + 14, 'text-anchor': 'middle' }, g);
        lb.textContent = '#' + s.id;
        if (tc) lb.style.fill = tc;
      }
      g.addEventListener('mousemove', ev => showTip(ev, s));
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
      g.addEventListener('click', () => goTo(s.id));
      if (s.t_end || s.out) pts.push([cx, yOut(s.out || 0)]);
    });
    svg('line', { x1: L, x2: W - R, y1: T + plotH, y2: T + plotH, stroke: C.axis }, root);
    const xl = svg('text', { x: L + (W - L - R) / 2, y: H - 8, 'text-anchor': 'middle' }, root);
    xl.textContent = 'message exchanges of this session, in order';

    // output tokens: a green line on the right axis
    if (pts.length) {
      svg('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: C.out, 'stroke-width': 2, 'pointer-events': 'none' }, root);
      pts.forEach(p => svg('circle', { cx: p[0], cy: p[1], r: 2.8, fill: C.out, 'pointer-events': 'none' }, root));
    }
  }

  function showTip(ev, s) {
    const tin = s.in || 0;
    const line = (label, v) => label + '  ' + num(v) + (tin ? '  (' + pct(v, tin) + ')' : '');
    tip.textContent = [
      '#' + s.id + ' · ' + (s.thread || '-') + ' · ' + s.state + (s.status ? ' · ' + s.status : ''),
      'input  ' + num(tin) + ' tokens',
      '  ' + line('cache read ', s.cache_read || 0),
      '  ' + line('cache write', s.cache_write || 0),
      '  ' + line('uncached   ', s.input || 0),
      'output ' + num(s.out || 0) + (s.thinking_tokens ? ' (' + num(s.thinking_tokens) + ' thinking)' : ''),
      'click to open',
    ].join('\n');
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
})();
