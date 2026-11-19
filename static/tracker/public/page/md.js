/* Shared helpers: formatting, element builder and a small, safe Markdown renderer for Jira comments. */
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = MONTHS.map((m) => m.slice(0, 3));

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }

  // 'YYYY-MM-DD' -> 'Nov 13' (read as a calendar date, no time zone shift)
  function fmtDay(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '—';
    return `${MON3[Number(m[2]) - 1]} ${Number(m[3])}`;
  }
  // full timestamp -> 'Nov 13' in the reader's time zone
  function fmtStamp(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const d = new Date(t);
    return `${MON3[d.getMonth()]} ${d.getDate()}`;
  }
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const days = Math.floor((Date.now() - t) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }
  function daysSince(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null;
  }

  /* ---------- Markdown (Jira comment) renderer: builds DOM nodes, never parses HTML ---------- */
  function clean(src) {
    return String(src || '')
      .replace(/<custom[^>]*>([\s\S]*?)<\/custom>/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
      .replace(/[​‌‍]/g, '');
  }
  function unesc(s) { return s.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1'); }
  function link(url, label) {
    const ok = /^https?:\/\//i.test(url);
    return ok ? h('a', {href: url, target: '_blank', rel: 'noopener noreferrer', text: label}) : document.createTextNode(label);
  }
  function inline(text, parent) {
    const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(unesc(text.slice(last, m.index)));
      if (m[1]) { const b = h('strong'); inline(m[2], b); if (/^(FAIL|REVIEW)\b/.test(m[2])) b.className = 'md-flag'; parent.append(b); }
      else if (m[3]) parent.append(h('code', {text: m[4]}));
      else if (m[5]) parent.append(link(m[7], unesc(m[6])));
      else if (m[8]) {
        let label = m[8].replace(/^https?:\/\//, '');
        if (label.length > 48) label = label.slice(0, 45) + '…';
        parent.append(link(m[8], label));
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(unesc(text.slice(last)));
  }
  function table(rows) {
    const split = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const body = rows.filter((r) => !/^\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(r));
    const thead = h('thead'), tbody = h('tbody');
    body.forEach((r, i) => {
      const tr = h('tr');
      split(r).forEach((c) => {
        const cell = h(i === 0 ? 'th' : 'td');
        inline(c, cell);
        if (i > 0 && /\b(FAIL|REVIEW)\b/.test(c)) cell.classList.add('md-flag');
        tr.append(cell);
      });
      (i === 0 ? thead : tbody).append(tr);
    });
    return h('div', {class: 'md-tablewrap'}, h('table', {class: 'md-table'}, thead, tbody));
  }
  function md(src) {
    const frag = document.createDocumentFragment();
    const lines = clean(src).replace(/\r/g, '').split('\n');
    let i = 0, para = null, list = null;
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { para = null; list = null; i++; continue; }
      if (line.startsWith('```')) {
        para = null; list = null;
        const buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
        i++;
        frag.append(h('pre', {text: buf.join('\n')}));
        continue;
      }
      const hd = line.match(/^(#{1,6})\s+(.*)$/);
      if (hd) { para = null; list = null; const e = h('p', {class: 'md-h'}); inline(hd[2], e); frag.append(e); i++; continue; }
      if (line.startsWith('|')) {
        para = null; list = null;
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
        frag.append(table(rows));
        continue;
      }
      const li = raw.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
      if (li) {
        para = null;
        if (!list) { list = h(/\d/.test(li[2]) ? 'ol' : 'ul'); frag.append(list); }
        const item = h('li', li[1].length >= 2 ? {class: 'md-sub'} : null);
        inline(li[3], item);
        list.append(item);
        i++;
        continue;
      }
      list = null;
      if (!para) { para = h('p'); frag.append(para); } else para.append(h('br'));
      inline(line, para);
      i++;
    }
    return frag;
  }

  // Signals in a comment that say what a ticket is waiting on.
  function signals(body) {
    const raw = String(body || '');
    const mentions = [...new Set([...raw.matchAll(/<custom[^>]*data-type="mention"[^>]*>@?([^<]+)<\/custom>/g)].map((m) => m[1].trim()))];
    const review = (raw.match(/Recommended status:\s*\**\s*REVIEW/g) || []).length;
    const fail = (raw.match(/Recommended status:\s*\**\s*\(?FAIL/g) || []).length;
    const questions = /open questions?|\?\s*$/im.test(clean(raw));
    return {mentions, review, fail, questions};
  }

  window.RTU = {MONTHS, MON3, h, fmtDay, fmtStamp, ago, daysSince, md, signals, clean};
})();
