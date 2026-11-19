/* Monthly Refresh Tracker: data shaping, status logic and drawings. */
const {MONTHS, MON3, h, fmtDay, fmtStamp, ago, daysSince, md, signals} = window.RTU;
const JIRA_SITE = 'https://team-1605722649546.atlassian.net';
const JIRA_BROWSE = JIRA_SITE + '/browse/';
const releaseName = (d) => `${d.getFullYear()} ${MONTHS[d.getMonth()]} Monthly Data Refresh`;

window.RT = {sel: null, pendingHash: null};
(function initParams() {
  const now = new Date();
  dash.setParams({
    release: releaseName(new Date(now.getFullYear(), now.getMonth(), 1)),
    prev_release: releaseName(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
  });
  if (/^#state-[A-Za-z]{2,3}$/.test(location.hash)) RT.pendingHash = location.hash.slice(7).toUpperCase();
})();

/* ---------- loaders: Jira answers -> rows ---------- */
const jiraList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object'
  ? (jiraList(v.nodes) || jiraList(v.issues) || jiraList(v.values) || (Array.isArray(v.edges) ? v.edges.map((e) => e.node) : null))
  : null);
const jiraIso = (s) => {
  if (!s) return '';
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};
const jiraFail = (answer) => {
  if (answer && answer.error) throw new Error(typeof answer.error === 'string' ? answer.error : (answer.error.message || 'Jira search failed'));
};

dash.loader('tickets', {
  description: 'One row per Jira ticket. State, release month, step and track (Standard or Risk & Audit) are read from the ticket title, e.g. "[GA] November Release - QA - Risk & Audit".',
  fn: async ({answer, call, args}) => {
    jiraFail(answer);
    let issues = jiraList(answer && answer.issues);
    if (!issues) throw new Error('Unexpected Jira answer: ' + JSON.stringify(answer).slice(0, 900));
    const paging = (p) => (p && p.nextPageToken ? p : p && p.issues && !Array.isArray(p.issues) && p.issues.nextPageToken ? p.issues : null);
    let page = paging(answer), pages = 0;
    while (page && page.isLast === false && pages < 4) {
      const next = await call('searchJiraIssuesUsingJql', {...args, nextPageToken: page.nextPageToken});
      issues = issues.concat(jiraList(next && next.issues) || []);
      page = paging(next);
      pages++;
    }
    const stepOf = (rest) => {
      const t = rest.toLowerCase();
      if (/source data/.test(t)) return 'source';
      if (/run release/.test(t)) return 'run';
      if (/upload/.test(t)) return 'upload';
      if (/report card/.test(t)) return 'drc';
      if (/snapshot/.test(t)) return 'snap';
      if (/dashboard/.test(t)) return 'dash';
      if (/^qa\b/.test(t)) return 'qa';
      return 'other';
    };
    const data = issues.map((it) => {
      const f = it.fields || {};
      const summary = f.summary || '';
      const m = summary.match(/^\s*\[([A-Za-z]{2,3})\]\s*([A-Za-z]+)\s+Release\s*-\s*(.+)$/);
      const rest = m ? m[3] : '';
      const sprints = Array.isArray(f.customfield_10020) ? f.customfield_10020 : [];
      const sprint = sprints.find((s) => s.state === 'active') || sprints[sprints.length - 1];
      const st = f.status || {};
      return {
        key: it.key,
        summary,
        task: rest || summary,
        state: m ? m[1].toUpperCase() : '',
        month: m ? m[2] : '',
        step: m ? stepOf(rest) : '',
        track: /risk\s*&?\s*audit/i.test(rest) ? 'Risk & Audit' : 'Standard',
        status: st.name || '',
        status_group: (st.statusCategory && st.statusCategory.key) || '',
        assignee: (f.assignee && f.assignee.displayName) || '',
        updated: jiraIso(f.updated),
        resolved: jiraIso(f.resolutiondate),
        sprint: sprint ? sprint.name : '',
        labels: (f.labels || []).join(' | '),
        fix_versions: (f.fixVersions || []).map((v) => v.name).join(' | '),
      };
    });
    return {data, truncated: !!(page && page.isLast === false)};
  },
});

dash.loader('detail', {
  description: 'One row per ticket description and per comment, for the state that is open on the page.',
  fn: ({answer}) => {
    jiraFail(answer);
    const issues = jiraList(answer && answer.issues);
    if (!issues) throw new Error('Unexpected Jira answer: ' + JSON.stringify(answer).slice(0, 900));
    const data = [];
    let truncated = false;
    for (const it of issues) {
      const f = it.fields || {};
      if (f.description) data.push({key: it.key, kind: 'description', id: '', author: '', created: '', body: String(f.description)});
      const c = f.comment || {};
      for (const x of c.comments || []) data.push({key: it.key, kind: 'comment', id: String(x.id || ''), author: (x.author && x.author.displayName) || '', created: jiraIso(x.created), body: String(x.body || '')});
      if (c.total && c.comments && c.total > c.comments.length) truncated = true;
    }
    return {data, truncated};
  },
});

dash.loader('reportcards', {
  description: 'One row per data report card file (.csv or .xlsx) attached to a state’s Jira ticket: a file named like a report card (“report card”, “drc”), or any such file on a Report Card ticket. Its release month comes from the ticket title (“[DC] October Release - …”), or else the month it was attached.',
  fn: ({answer}) => {
    jiraFail(answer);
    const issues = jiraList(answer && answer.issues);
    if (!issues) throw new Error('Unexpected Jira answer: ' + JSON.stringify(answer).slice(0, 900));
    const data = [];
    for (const it of issues) {
      const f = it.fields || {};
      const summary = f.summary || '';
      const m = summary.match(/^\s*\[([A-Za-z]{2,3})\]/);
      if (!m) continue;
      const onReportCard = /report card/i.test(summary);
      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const mm = summary.match(/\]\s*([A-Za-z]+)\s+Release/i);
      const titleMonth = mm ? MONTHS.findIndex((x) => x.toLowerCase() === mm[1].toLowerCase()) : -1;
      for (const a of f.attachment || []) {
        const name = String(a.filename || '');
        const ext = (name.match(/\.(csv|xlsx)$/i) || [])[1];
        if (!ext) continue;
        if (!(onReportCard || /report.?card|(^|[^a-z])drc([^a-z]|$)/i.test(name))) continue;
        const made = new Date(jiraIso(a.created) || Date.now());
        let mon = titleMonth >= 0 ? titleMonth : made.getMonth(), year = made.getFullYear();
        if (titleMonth >= 0 && titleMonth > made.getMonth() + 1) year -= 1; // a December file attached in January
        data.push({
          id: String(a.id), state: m[1].toUpperCase(), key: it.key, ticket: summary,
          release: `${year} ${MONTHS[mon]} Monthly Data Refresh`,
          filename: name, format: ext.toUpperCase(), created: jiraIso(a.created), size: Number(a.size) || 0,
          author: (a.author && a.author.displayName) || '',
          url: `${JIRA_SITE}/secure/attachment/${encodeURIComponent(a.id)}/${encodeURIComponent(name)}`,
        });
      }
    }
    data.sort((x, y) => String(y.created).localeCompare(String(x.created)));
    return {data, truncated: !!(answer && answer.isLast === false)};
  },
});

/* ---------- calculations ---------- */
dash.calc('steps', {
  title: 'Each state’s steps against the schedule',
  description: 'One row per state, track and step of the chosen release: its Jira ticket and status, the target date from the schedule, days overdue (none when the state is skipped this month), and how many times the step was run (more than one ticket for the step, or “rerun” in its title or labels).',
  inputs: ['tickets', 'schedule', 'skips'],
  fn: (tickets, schedule, skips) => {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const STEPS = [['source', 'Provide source data'], ['run', 'Run release / QA data'], ['qa', 'BI QA'], ['dash', 'Refresh dashboards'], ['snap', 'Analytics snapshot'], ['drc', 'Data report card'], ['upload', 'Upload report card']];
    const TRACKS = ['Standard', 'Risk & Audit'];
    const release = String(dash.params().release || '');
    const m = release.match(/^(\d{4}) ([A-Za-z]+) Monthly Data Refresh$/);
    if (!m) return [];
    const year = Number(m[1]), mon = MONTHS.indexOf(m[2]);
    if (mon < 0) return [];
    const monthDays = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
    const now = new Date();
    const todayDay = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(year, mon, 1)) / 864e5) + 1;
    const pad = (n) => String(n).padStart(2, '0');
    const dayFor = (state, step) => {
      const pick = (s) => schedule.find((r) => r.state === s && r.step === step && Number(r.day) > 0);
      const row = pick(state) || pick('ALL');
      return row ? Math.min(Math.round(Number(row.day)), monthDays) : monthDays;
    };
    const kindOf = (t) => {
      if (t.status_group === 'done') return /abandon|won.?t|cancel|duplicate/i.test(t.status) ? 'abandoned' : 'done';
      if (/block/i.test(t.status)) return 'blocked';
      if (t.status_group === 'indeterminate') return 'active';
      return 'todo';
    };
    const isRerun = (t) => /\bre-?run/i.test(t.summary) || /re-?run/i.test(String(t.labels || ''));
    const skipOf = new Map(skips.filter((r) => r.release === release && r.state).map((r) => [r.state, String(r.reason || '')]));
    const main = tickets.filter((t) => t.state && t.month === m[2] && String(t.fix_versions).split(' | ').includes(release));
    const rows = [];
    for (const state of [...new Set(main.map((t) => t.state))]) {
      TRACKS.forEach((track) => {
        STEPS.forEach(([step, label], order) => {
          const hits = main.filter((t) => t.state === state && t.track === track && t.step === step)
            .sort((a, b) => Number(b.key.split('-')[1]) - Number(a.key.split('-')[1]));
          if (!hits.length) return;
          const t = hits[0];
          const kind = kindOf(t);
          const targetDay = dayFor(state, step);
          const open = kind !== 'done' && kind !== 'abandoned';
          const skipped = skipOf.has(state);
          rows.push({
            state, track, lane: track === 'Standard' ? state : `${state} R&A`,
            skipped, skip_reason: skipped ? skipOf.get(state) : '',
            order, step, step_label: label, key: t.key, status: t.status, kind,
            assignee: t.assignee, updated: t.updated,
            attempts: Math.max(hits.length, hits.some(isRerun) ? 2 : 1),
            target: `${year}-${pad(mon + 1)}-${pad(targetDay)}`, target_day: targetDay,
            days_late: !skipped && open && todayDay > targetDay ? todayDay - targetDay : 0,
            month_days: monthDays, today_day: todayDay,
          });
        });
      });
    }
    return rows;
  },
});

dash.calc('lanes', {
  title: 'Where each state’s track is',
  description: 'One row per state and track (Standard refresh, or Risk & Audit): its current step (the first one not closed), its owner, whether that step is past its target date and by how many days, and how many steps are closed or were rerun. A state skipped this month shows as Skipped.',
  inputs: ['steps'],
  fn: (steps) => {
    const ORDER = ['DC', 'MA', 'IL', 'GA', 'MD'];
    const rank = (s) => (ORDER.indexOf(s) + 1) || 99;
    const lanes = [...new Set(steps.map((r) => r.lane))].map((lane) => steps.find((r) => r.lane === lane))
      .sort((a, b) => rank(a.state) - rank(b.state) || a.state.localeCompare(b.state) || (a.track === 'Standard' ? -1 : 1));
    return lanes.map(({lane, state, track}) => {
      const mine = steps.filter((r) => r.lane === lane).sort((a, b) => a.order - b.order);
      const closed = (r) => r.kind === 'done' || r.kind === 'abandoned';
      const cur = mine.find((r) => !closed(r));
      const todayDay = mine[0].today_day, monthDays = mine[0].month_days;
      let status;
      if (mine[0].skipped) status = 'Skipped';
      else if (!cur) status = 'Complete';
      else if (cur.days_late > 0) status = 'Behind';
      else if (todayDay < 1) status = 'Not started';
      else if (cur.target_day - todayDay <= 2) status = 'Due soon';
      else status = 'On track';
      return {
        lane, state, track, status, skip_reason: mine[0].skip_reason || '',
        days_behind: cur ? cur.days_late : 0,
        current_step: cur ? cur.step_label : 'All steps closed',
        current_key: cur ? cur.key : '',
        current_status: cur ? cur.status : '',
        current_owner: cur ? (cur.assignee || 'Unassigned') : '',
        current_due: cur ? cur.target : '',
        steps_closed: mine.filter(closed).length,
        steps_total: mine.length,
        reruns: mine.filter((r) => r.attempts > 1).length,
        bar_end_day: cur ? Math.max(0, Math.min(todayDay, cur.target_day)) : monthDays,
      };
    });
  },
});

dash.calc('states', {
  title: 'Where each state is',
  description: 'One row per state, from its Standard refresh track: its current step, whether that step is past its target date and by how many days, and how many steps are closed. Risk & Audit is shown as its own track.',
  inputs: ['lanes', 'tickets', 'steps'],
  fn: (lanes, tickets, steps) => {
    const NAMES = {DC: 'DC OSSE', MA: 'MA EEC', IL: 'IL IDEC', GA: 'GA DECAL', MD: 'Maryland'};
    const states = [...new Set(lanes.map((r) => r.state))];
    return states.map((state) => {
      const mine = lanes.filter((r) => r.state === state);
      const l = mine.find((r) => r.track === 'Standard') || mine[0];
      const laneKeys = new Set(steps.filter((r) => r.state === state).map((r) => r.key));
      const mineAll = tickets.filter((t) => t.state === state);
      const updates = mineAll.map((t) => t.updated).filter(Boolean).sort();
      return {
        state, name: NAMES[state] || state, status: l.status, skip_reason: l.skip_reason || '',
        days_behind: l.days_behind,
        current_step: l.current_step, current_key: l.current_key, current_status: l.current_status,
        current_owner: l.current_owner, current_due: l.current_due,
        steps_closed: l.steps_closed, steps_total: l.steps_total,
        tracks: mine.length,
        other_open: mineAll.filter((t) => !laneKeys.has(t.key) && t.status_group !== 'done').length,
        last_update: updates.length ? updates[updates.length - 1] : '',
      };
    });
  },
});

dash.calc('overview', {
  title: 'Release at a glance',
  description: 'How many of the states expected this month are behind their schedule on the Standard refresh, which one is furthest behind, and how many are skipped this month.',
  inputs: ['states'],
  fn: (all) => {
    if (!all.length) return [];
    const states = all.filter((s) => s.status !== 'Skipped');
    const behind = states.filter((s) => s.status === 'Behind').sort((a, b) => b.days_behind - a.days_behind);
    const w = behind[0];
    return [{
      states: states.length, behind: behind.length, skipped: all.length - states.length,
      complete: states.filter((s) => s.status === 'Complete').length,
      worst_state: w ? w.name : '', worst_step: w ? w.current_step : '',
      worst_due: w ? w.current_due : '', worst_days: w ? w.days_behind : 0,
    }];
  },
});
/* ---------- shared bits ---------- */
const STATUS_CLASS = {'Behind': 'bad', 'Due soon': 'warn', 'On track': 'ok', 'Complete': 'ok', 'Not started': 'muted', 'Skipped': 'muted'};
const STATUS_FILL = {'Behind': 'var(--s-late)', 'Due soon': 'var(--risk-mod-fill)', 'On track': 'var(--s-done)', 'Complete': 'var(--s-done)', 'Not started': 'var(--g400)', 'Skipped': 'var(--g300)'};
const monthOf = () => { const m = String(dash.params().release || '').match(/^(\d{4}) ([A-Za-z]+)/); return m ? `${m[2]} ${m[1]}` : 'this month'; };
const TRACK_LABEL = {'Standard': 'Standard refresh', 'Risk & Audit': 'Risk & Audit'};
const stepKind = (r) => (r.kind === 'todo' && r.days_late > 0 ? 'late' : r.kind);
const failMsg = (text) => h('p', {class: 'rt-fail', text});
const statusOk = (...ids) => ids.every((id) => dash.data(id).status === 'ok');
const anyLoading = (...ids) => ids.some((id) => dash.data(id).status === 'loading');
const ticketKind = (t) => {
  if (t.status_group === 'done') return /abandon|won.?t|cancel|duplicate/i.test(t.status) ? 'abandoned' : 'done';
  if (/block/i.test(t.status)) return 'blocked';
  if (t.status_group === 'indeterminate') return 'active';
  return 'todo';
};
const isNobody = (name) => !name || name === 'Unassigned';
const initials = (name) => {
  if (isNobody(name)) return '?';
  const w = String(name).trim().split(/\s+/);
  return ((w[0] || '')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
};
const avatar = (name, big) => h('span', {class: 'rt-av' + (big ? ' rt-av--lg' : '') + (isNobody(name) ? ' rt-av--none' : ''), 'aria-hidden': 'true', text: initials(name)});
const shortName = (name) => {
  if (isNobody(name)) return 'No owner';
  const w = String(name).trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0];
};
const enc = (v) => encodeURIComponent(v);
const markState = (state, field, text, cls) => h('span', {class: cls, 'data-source': 'states', 'data-field': field, 'data-where': `state=${enc(state)}`, text});
const markLane = (lane, field, text, cls) => h('span', {class: cls, 'data-source': 'lanes', 'data-field': field, 'data-where': `lane=${enc(lane)}`, text});
const jiraLink = (key, text, commentId) => h('a', {class: 'rt-key', href: JIRA_BROWSE + key + (commentId ? `?focusedCommentId=${enc(commentId)}` : ''), target: '_blank', rel: 'noopener noreferrer', text: text || key});

const csLead = (state) => {
  const C = dash.data('csleads');
  const r = C.status === 'ok' && Array.isArray(C.data) ? C.data.find((x) => x.state === state) : null;
  return r ? String(r.cs_lead || '') : '';
};
RT.csLead = csLead;

/* ---------- views, selection, layout ---------- */
const each = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
// view: 'all' (map + timeline), 'state' (one state's detail) or 'schedule'
function setView(v) {
  RT.view = v;
  each('#all-states', (s) => { s.hidden = v !== 'all'; });
  each('#detail', (s) => { s.hidden = v !== 'state'; });
  each('#schedule', (s) => { s.hidden = v !== 'schedule'; });
  each('#map-btn', (b) => b.setAttribute('aria-pressed', v === 'all' ? 'true' : 'false'));
  each('#sched-btn', (b) => b.setAttribute('aria-pressed', v === 'schedule' ? 'true' : 'false'));
  ['detail', 'cards', 'timeline', 'map'].forEach((n) => dash.draw(n));
}
RT.view = 'all';
RT.open = (state) => {
  if (RT.sel !== state) each('#skip-form, #note-form', (f) => { f.hidden = true; });
  RT.sel = state;
  const T = dash.data('tickets');
  const keys = (T.status === 'ok' ? T.data : []).filter((t) => t.state === state).map((t) => t.key).slice(0, 80);
  dash.setParams({keys: keys.length ? keys : ['PRD-5116']});
  setView('state');
  dash.setLink('state-' + state);
};
RT.close = () => {
  RT.sel = null;
  setView('all');
  dash.setLink('all-states');
};
RT.toggle = (state) => (RT.sel === state && RT.view === 'state' ? RT.close() : RT.open(state));

each('#map-btn', (b) => b.addEventListener('click', () => RT.close()));
each('#sched-btn', (b) => b.addEventListener('click', () => (RT.view === 'schedule' ? (RT.sel ? RT.open(RT.sel) : RT.close()) : setView('schedule'))));
each('#sched-close', (b) => b.addEventListener('click', () => (RT.sel ? RT.open(RT.sel) : RT.close())));

/* ---------- skip a state for one month (saved on the dashboard; editors only) ---------- */
const skipId = (state) => {
  const m = String(dash.params().release || '').match(/^(\d{4}) ([A-Za-z]+)/);
  return m ? `${state}_${m[1]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}` : '';
};
async function writeSkip(state, reason) {
  let saved = true;
  try {
    const db = await claude.use('db');
    const id = skipId(state);
    if (!db || !id) throw new Error('no db');
    const ref = db.doc(`data/refresh/skips/${id}`);
    if (reason === null) await ref.delete();
    else await ref.set({state, release: String(dash.params().release || ''), reason, at: new Date().toISOString()});
  } catch (e) { saved = false; }
  each('#skip-unsaved', (p) => { p.hidden = saved; });
  return saved;
}
RT.showSkip = (on) => {
  each('#skip-form', (f) => { f.hidden = !on; });
  each('#skip-unsaved', (p) => { p.hidden = true; });
  if (on) { dash.draw('skip-what'); each('#skip-reason', (i) => { i.value = ''; i.focus(); }); }
};
RT.undoSkip = (state) => writeSkip(state, null);
each('#skip-form', (f) => f.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!RT.sel) return;
  const inp = document.querySelector('#skip-reason');
  const reason = inp ? inp.value.trim().slice(0, 300) : '';
  if (await writeSkip(RT.sel, reason || 'No reason given')) RT.showSkip(false);
}));
each('#skip-cancel', (b) => b.addEventListener('click', () => RT.showSkip(false)));
dash.draw('skip-what', (el) => { el.textContent = RT.sel ? `${RT.sel} for ${monthOf()}` : '—'; });

/* ---------- pinned note per state (saved on the dashboard; editors only) ---------- */
const noteFor = (state) => {
  const N = dash.data('notes');
  const r = N.status === 'ok' && Array.isArray(N.data) ? N.data.find((x) => x.state === state) : null;
  return r && String(r.text || '').trim() ? r : null;
};
RT.noteFor = noteFor;
async function writeNote(state, text) {
  let saved = true;
  try {
    const db = await claude.use('db');
    if (!db || !/^[A-Z]{2,3}$/.test(state)) throw new Error('no db');
    const ref = db.doc(`data/refresh/notes/${state}`);
    if (!text) await ref.delete();
    else await ref.set({state, text, at: new Date().toISOString()});
  } catch (e) { saved = false; }
  each('#note-unsaved', (p) => { p.hidden = saved; });
  return saved;
}
RT.showNote = (on) => {
  each('#note-form', (f) => { f.hidden = !on; });
  each('#note-unsaved', (p) => { p.hidden = true; });
  if (on) {
    const n = RT.sel ? noteFor(RT.sel) : null;
    dash.draw('note-what');
    each('#note-text', (i) => { i.value = n ? n.text : ''; i.focus(); });
    each('#note-remove', (b) => { b.hidden = !n; });
  }
};
each('#note-form', (f) => f.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!RT.sel) return;
  const inp = document.querySelector('#note-text');
  const text = inp ? inp.value.trim().slice(0, 1000) : '';
  if (await writeNote(RT.sel, text)) RT.showNote(false);
}));
each('#note-cancel', (b) => b.addEventListener('click', () => RT.showNote(false)));
each('#note-remove', (b) => b.addEventListener('click', async () => { if (RT.sel && await writeNote(RT.sel, '')) RT.showNote(false); }));
dash.draw('note-what', (el) => { el.textContent = RT.sel || '—'; });

/* ---------- refresh from Jira (anyone) ---------- */
const JIRA_SOURCES = () => ['tickets', 'reportcards', ...(RT.sel ? ['detail'] : [])];
const busy = () => JIRA_SOURCES().some((id) => { const d = dash.data(id); return d.status === 'loading' || d.refreshing; });
each('#refresh-btn', (b) => b.addEventListener('click', () => {
  if (busy()) return;
  RT.lastRefresh = Date.now();
  JIRA_SOURCES().forEach((id) => dash.refresh(id));
  b.disabled = true;
  b.classList.add('is-busy');
  dash.draw('refresh-label');
}));
dash.onData(() => {
  const on = busy();
  each('#refresh-btn', (b) => { b.disabled = on; b.classList.toggle('is-busy', on); });
});
dash.draw('refresh-label', (el) => {
  if (busy()) { el.textContent = 'Refreshing…'; return; }
  el.textContent = RT.lastRefresh ? `Refreshed ${new Date(RT.lastRefresh).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : 'Refresh';
});

// Size the dashboard to the window so only the panels scroll.
function fit() {
  each('.rt-shell', (el) => {
    const top = el.getBoundingClientRect().top + (window.scrollY || 0);
    // Forge: the iframe grows with its content, so the shim supplies a viewport height.
    const vh = window.RT_VIEWPORT_HEIGHT ? window.RT_VIEWPORT_HEIGHT() + top : window.innerHeight;
    const hgt = Math.max(600, Math.floor(vh - top - 20));
    el.style.setProperty('--rt-h', `${hgt}px`);
  });
}
window.addEventListener('resize', fit);
requestAnimationFrame(fit);

dash.onData(() => {
  fit();
  if (!RT.pendingHash) return;
  const S = dash.data('states');
  if (S.status !== 'ok') return;
  const s = RT.pendingHash;
  RT.pendingHash = null;
  if (S.data.some((r) => r.state === s)) RT.open(s);
});

// Small outline of a state, from the map's shapes (absolute M/L paths).
const shapeBox = new Map();
function stateShape(state, fill, dashed, w = 30, hh = 24) {
  const G = dash.data('usmap');
  const row = G.status === 'ok' ? G.data.find((r) => r.state === state) : null;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'rt-shape');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(hh));
  svg.setAttribute('aria-hidden', 'true');
  if (!row) return svg;
  const d = (state === 'DC' && row.detail) ? row.detail : row.d;
  if (!shapeBox.has(state)) {
    const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]); }
    shapeBox.set(state, [x0, y0, x1, y1]);
  }
  const [x0, y0, x1, y1] = shapeBox.get(state);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  const p = document.createElementNS(svgNS, 'path');
  p.setAttribute('d', d);
  p.style.fill = fill;
  p.style.stroke = dashed ? 'var(--g400)' : fill;
  if (dashed) p.style.strokeDasharray = '3 2';
  svg.append(p);
  return svg;
}
window.RT.stateShape = stateShape;

/* ---------- header ---------- */
dash.draw('release', (sel) => {
  const now = new Date();
  const opts = [];
  for (let i = 1; i >= -6; i--) opts.push(new Date(now.getFullYear(), now.getMonth() + i, 1));
  sel.replaceChildren(...opts.map((d) => new Option(`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, releaseName(d))));
  sel.value = dash.params().release || '';
  sel.onchange = () => {
    const [y, mo] = sel.value.split(' ');
    const prev = new Date(Number(y), MONTHS.indexOf(mo) - 1, 1);
    RT.close();
    dash.setParams({release: sel.value, prev_release: releaseName(prev)});
  };
});
dash.draw('target', (el) => {
  const m = String(dash.params().release || '').match(/^(\d{4}) ([A-Za-z]+)/);
  if (!m) { el.textContent = '—'; return; }
  const mon = MONTHS.indexOf(m[2]);
  const last = new Date(Number(m[1]), mon + 1, 0);
  el.textContent = `${MON3[mon]} ${last.getDate()}`;
});

const ov = (field, fmt) => (el) => {
  const O = dash.data('overview');
  const r = O.status === 'ok' && O.data && O.data[0];
  el.textContent = r ? (fmt ? fmt(r[field]) : String(r[field])) : '—';
};
dash.draw('nbehind', ov('behind'));
dash.draw('nstates', ov('states'));
dash.draw('wstate', ov('worst_state'));
dash.draw('wstep', ov('worst_step', (v) => String(v).toLowerCase()));
dash.draw('wdue', ov('worst_due', fmtDay));
dash.draw('wdays', ov('worst_days'));
dash.draw('nskipped', ov('skipped'));
dash.draw('lede-switch', (el) => {
  const O = dash.data('overview');
  const r = O.status === 'ok' && O.data && O.data[0];
  const set = (id, show) => each('#' + id, (e) => { e.hidden = !show; });
  const loaded = O.status === 'ok';
  set('lede-main', !loaded || !!r);
  set('lede-worst', !loaded || !!(r && r.behind > 0));
  set('lede-none', loaded && !!r && r.behind === 0);
  set('lede-empty', loaded && !r);
  set('lede-skip', loaded && !!r && r.skipped > 0);
  el.replaceChildren();
});

/* ---------- state rail ---------- */
dash.draw('cards', (el) => {
  const S = dash.data('states'), P = dash.data('steps'), L = dash.data('lanes');
  if (!statusOk('states', 'steps', 'lanes')) {
    if (anyLoading('tickets', 'schedule', 'states', 'steps', 'lanes')) {
      el.replaceChildren(...[0, 1, 2, 3].map(() => h('div', {class: 'rt-card rt-card--ghost dash-skeleton'})));
    } else el.replaceChildren(failMsg('Couldn’t load the Jira tickets for this release.'));
    return;
  }
  if (!S.data.length) { el.replaceChildren(h('p', {class: 'rt-empty', text: 'No state tickets found for this release yet.'})); return; }
  el.replaceChildren(...S.data.map((s) => {
    const steps = P.data.filter((r) => r.state === s.state && r.track === 'Standard').sort((a, b) => a.order - b.order);
    const extra = L.data.filter((l) => l.state === s.state && l.track !== 'Standard');
    const chip = h('span', {class: `rt-chip rt-chip--${STATUS_CLASS[s.status] || 'muted'}`},
      markState(s.state, 'status', s.status),
      s.status === 'Behind' ? [' · ', markState(s.state, 'days_behind', String(s.days_behind)), 'd'] : null);
    const agency = s.name.replace(s.state, '').trim();
    const none = s.current_key && isNobody(s.current_owner);
    const note = noteFor(s.state);
    const who = s.status === 'Skipped'
      ? h('div', {class: 'rt-who-line rt-who-line--skip'}, h('span', {text: `Skipped for ${monthOf().split(' ')[0]} · `}), markState(s.state, 'skip_reason', s.skip_reason))
      : s.current_key
        ? h('div', {class: 'rt-who-line' + (none ? ' is-none' : '')},
          avatar(s.current_owner),
          h('span', {class: 'rt-who-name'}, markState(s.state, 'current_owner', none ? 'No owner' : shortName(s.current_owner))),
          h('span', {class: 'rt-who-step'}, ' · ', markState(s.state, 'current_step', s.current_step)))
        : h('div', {class: 'rt-who-line'}, markState(s.state, 'current_step', s.current_step));
    const rc = rcStatus(s.state);
    const flag = rc.kind === 'late' || rc.kind === 'missed' ? rcPill(s.state) : null;
    const on = RT.sel === s.state && RT.view === 'state';
    return h('button', {type: 'button', id: `card-${s.state}`, class: 'rt-card' + (on ? ' is-selected' : '') + (s.status === 'Skipped' ? ' is-skipped' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => RT.toggle(s.state),
      title: [s.current_key ? `${s.current_owner} · ${s.current_step} · ${s.current_status} · due ${fmtDay(s.current_due)}` : '', note ? `📌 ${note.text}` : '', csLead(s.state) ? `CS · ${csLead(s.state)}` : ''].filter(Boolean).join('\n')},
      h('div', {class: 'rt-card-top'},
        stateShape(s.state, STATUS_FILL[s.status] || 'var(--g400)', false, 24, 20),
        h('span', {class: 'rt-code', text: s.state}),
        agency ? h('span', {class: 'rt-agency', text: agency}) : null,
        note ? h('span', {class: 'rt-pin', title: note.text, 'aria-label': 'Has a pinned note', text: '📌'}) : null,
        chip),
      who,
      h('div', {class: 'rt-seg', 'aria-hidden': 'true'}, steps.map((r) => h('i', {class: `k-${stepKind(r)}` + (r.key === s.current_key ? ' is-current' : ''), title: `${r.step_label}: ${r.status} · ${r.assignee || 'Unassigned'}`}))),
      extra.filter((l) => l.current_key && s.status !== 'Skipped').map((l) => h('div', {class: 'rt-who-line rt-who-line--track'},
        h('span', {class: 'rt-chip rt-chip--track', text: 'R&A'}),
        h('span', {class: 'rt-who-step'}, markLane(l.lane, 'current_step', l.current_step)))),
      flag ? h('div', {class: 'rt-card-flags'}, flag) : null);
  }));
});

/* ---------- states starting soon, and leads ---------- */
dash.draw('pipeline', (el) => {
  const R = dash.data('roster'), S = dash.data('states');
  if (R.status !== 'ok') {
    el.replaceChildren(R.status === 'loading' ? h('div', {class: 'rt-pcard dash-skeleton'}) : failMsg('Couldn’t load the list of upcoming states.'));
    return;
  }
  const active = new Set(S.status === 'ok' ? S.data.map((s) => s.state) : []);
  const rows = R.data.filter((r) => r.state && !active.has(r.state)).sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99));
  if (!rows.length) { el.replaceChildren(h('p', {class: 'rt-empty', text: 'None right now.'})); return; }
  el.replaceChildren(...rows.map((r) => {
    const where = `state=${enc(r.state)}`;
    const lead = r.stage === 'Lead';
    return h('div', {class: `rt-pcard rt-pcard--${lead ? 'Lead' : 'Starting'}`, id: `pipeline-${r.state}`},
      stateShape(r.state, lead ? 'transparent' : 'var(--s-start)', lead),
      h('div', {class: 'rt-pcard-text'},
        h('span', {class: 'rt-pcard-name'}, h('span', {text: `${r.state} `}), h('span', {class: 'rt-muted', 'data-source': 'roster', 'data-field': 'name', 'data-where': where, text: r.name || ''})),
        h('span', {class: 'rt-pcard-note', 'data-source': 'roster', 'data-field': 'note', 'data-where': where, text: r.note || ''}),
        csLead(r.state) ? h('span', {class: 'rt-pcard-note', text: `CS · ${csLead(r.state)}`}) : null),
      h('span', {class: `rt-chip rt-chip--${lead ? 'muted' : 'accent'}`, 'data-source': 'roster', 'data-field': 'short', 'data-where': where, text: r.short || r.stage || ''}));
  }));
});

/* ---------- schedule vs progress chart: one row per state; a state with a second track forks into two ---------- */
dash.draw('timeline', {
  mount: (el) => {
    const svg = d3.select(el).append('svg').attr('role', 'img').attr('class', 'rt-svg');
    const tip = h('div', {class: 'rt-tip', hidden: true});
    el.append(tip);
    return {svg, tip};
  },
  update: (el, {svg, tip}) => {
    el.querySelectorAll('.rt-fail, .rt-empty').forEach((n) => n.remove());
    if (!statusOk('lanes', 'steps')) {
      svg.selectAll('*').remove();
      svg.attr('height', 0);
      if (!anyLoading('tickets', 'schedule', 'lanes', 'steps')) el.prepend(failMsg('Failed to load'));
      return;
    }
    const L = dash.data('lanes').data, P = dash.data('steps').data;
    if (!L.length) { svg.selectAll('*').remove(); svg.attr('height', 0); return; }
    const monthDays = P[0].month_days, todayDay = P[0].today_day;
    const m = String(dash.params().release || '').match(/^(\d{4}) ([A-Za-z]+)/);
    const mon3 = m ? MON3[MONTHS.indexOf(m[2])] : '';
    const W = Math.max(280, el.clientWidth);
    const narrow = W < 340;
    const left = narrow ? 46 : 120, right = 14, top = 36;
    const x = d3.scaleLinear([0.5, monthDays + 0.5], [left, W - right]);

    // one group per state: its standard lane, plus a second lane if it has one
    const groups = [...new Set(L.map((l) => l.state))].map((state) => {
      const lanes = L.filter((l) => l.state === state);
      const std = lanes.find((l) => l.track === 'Standard') || lanes[0];
      const alt = lanes.find((l) => l !== std) || null;
      return {state, std, alt};
    });
    const weight = (g) => (g.alt ? 1.6 : 1);
    const units = d3.sum(groups, weight);
    const unit = Math.max(50, Math.min(100, Math.floor((el.clientHeight - top - 8) / units) || 50));
    let yAt = top;
    groups.forEach((g) => { g.y = yAt; g.h = Math.round(unit * weight(g)); yAt += g.h; });
    const H = yAt + 4;
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H)
      .attr('aria-label', `Each state's progress through the ${m ? m[2] : ''} release schedule compared with today. Georgia forks into its standard and Risk & Audit tracks.`);
    svg.selectAll('*').remove();

    const ticks = [1, ...d3.range(5, monthDays + 1, narrow ? 10 : 5)].filter((d, i, a) => a.indexOf(d) === i && d <= monthDays);
    const ax = svg.append('g').attr('class', 'rt-ax');
    ax.selectAll('line').data(ticks).join('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', top - 4).attr('y2', H - 2).style('stroke', 'var(--g200)');
    ax.selectAll('text').data(ticks).join('text')
      .attr('x', (d) => x(d)).attr('y', top - 9).attr('text-anchor', 'middle').text((d) => (d === 1 ? `${mon3} 1` : String(d)));

    const tClamp = Math.max(0.5, Math.min(monthDays + 0.5, todayDay));
    const tg = svg.append('g');
    tg.append('line').attr('x1', x(tClamp)).attr('x2', x(tClamp)).attr('y1', top - 2).attr('y2', H - 2)
      .style('stroke', 'var(--b-dk)').style('stroke-width', 1.5).style('stroke-dasharray', '3 3');
    const tLabel = todayDay > monthDays ? 'Today →' : todayDay < 1 ? '← Today' : 'Today';
    const tText = tg.append('text').attr('class', 'rt-today').attr('x', x(tClamp)).attr('y', 10).attr('text-anchor', 'middle').text(tLabel);
    const tw = tText.node().getComputedTextLength();
    if (x(tClamp) + tw / 2 > W) tText.attr('text-anchor', 'end');
    if (x(tClamp) - tw / 2 < 0) tText.attr('text-anchor', 'start');

    const dotStyle = {
      done: ['var(--s-done)', 'var(--s-done)'], abandoned: ['var(--g300)', 'var(--g300)'],
      active: ['var(--s-active)', '#FFFFFF'], blocked: ['var(--s-late)', 'var(--s-late)'],
      late: ['#FFFFFF', 'var(--s-late)'], todo: ['#FFFFFF', 'var(--g400)'],
    };
    const showTip = (e, d) => {
      const r = el.getBoundingClientRect();
      tip.replaceChildren(
        h('strong', {text: `${d.state}${d.track !== 'Standard' ? ' R&A' : ''} · ${d.step_label}`}),
        h('div', {text: `${d.assignee || 'Unassigned'} · ${d.status}`}),
        d.attempts > 1 ? h('div', {text: `↻ Rerun: ${d.attempts} runs this release`}) : null,
        h('div', {class: 'rt-muted', text: `Target ${fmtDay(d.target)}${d.days_late ? ` · ${d.days_late} days overdue` : ''} · ${d.key}`}));
      tip.hidden = false;
      const px = e.clientX - r.left, py = e.clientY - r.top + el.scrollTop;
      const tw2 = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(px - tw2 / 2, r.width - tw2 - 4))}px`;
      tip.style.top = `${py + 14}px`;
    };
    const line = d3.line();

    groups.forEach((gr, gi) => {
      const row = svg.append('g').attr('class', 'rt-row').attr('transform', `translate(0,${gr.y})`)
        .style('cursor', 'pointer').on('click', () => RT.open(gr.state));
      row.append('rect').attr('class', 'rt-row-bg').attr('x', 0).attr('y', 1).attr('width', W).attr('height', gr.h - 2).attr('rx', 8);
      if (gi > 0) row.append('line').attr('x1', 0).attr('x2', W).attr('y1', 0).attr('y2', 0).style('stroke', 'var(--g200)');
      const mid = gr.alt ? gr.h / 2 : Math.min(gr.h / 2, 24);
      const off = gr.alt ? Math.max(10, Math.min(16, gr.h / 5)) : 0;

      // left labels: state and its CS lead
      row.append('text').attr('class', 'rt-row-code').attr('x', 6).attr('y', narrow ? mid + 5 : mid - 2).text(gr.state);
      if (!narrow) {
        const lead = csLead(gr.state);
        row.append('text').attr('class', 'rt-row-sub').attr('x', 6).attr('y', mid + 12)
          .text(lead ? `CS · ${shortName(lead)}` : 'CS lead not set')
          .each(function () {
            const t = d3.select(this);
            let s = t.text();
            while (this.getComputedTextLength() > left - 12 && s.length > 2) { s = s.slice(0, -1); t.text(s + '…'); }
          });
      }

      // where the fork happens: after the standard steps that come before every step of the second track
      const stdSteps = P.filter((r) => r.lane === gr.std.lane).sort((a, b) => a.order - b.order);
      const altSteps = gr.alt ? P.filter((r) => r.lane === gr.alt.lane).sort((a, b) => a.order - b.order) : [];
      const firstAlt = altSteps.length ? altSteps[0].order : Infinity;
      const trunkSteps = gr.alt ? stdSteps.filter((r) => r.order < firstAlt) : [];
      const forkDay = trunkSteps.length ? d3.max(trunkSteps, (r) => r.target_day) : 0.5;
      const fx = x(forkDay), bend = gr.alt ? Math.min(18, (x(monthDays + 0.5) - fx) / 4) : 0;
      // path of a branch from day a to day b
      const branch = (by, a, b) => {
        if (!gr.alt) return [[x(a), mid], [x(b), mid]];
        const pts = [];
        const xa = x(a), xb = x(b);
        if (xa < fx) pts.push([xa, mid]);
        if (xb <= fx) { pts.push([xb, mid]); return pts.length > 1 ? pts : [[xb, mid], [xb, mid]]; }
        if (xa < fx) pts.push([fx, mid]);
        const xs = Math.max(xa, fx);
        const yAtX = (xx) => (xx >= fx + bend ? by : mid + (by - mid) * ((xx - fx) / (bend || 1)));
        pts.push([xs, yAtX(xs)]);
        if (xb > fx + bend && xs < fx + bend) pts.push([fx + bend, by]);
        pts.push([xb, yAtX(xb)]);
        return pts;
      };
      const tracks = gr.alt ? [{lane: gr.std, y: mid - off, steps: stdSteps}, {lane: gr.alt, y: mid + off, steps: altSteps}] : [{lane: gr.std, y: mid, steps: stdSteps}];

      tracks.forEach((t) => {
        row.append('path').attr('d', line(branch(t.y, 0.5, monthDays + 0.5)))
          .style('fill', 'none').style('stroke', 'var(--g100)').style('stroke-width', 8).style('stroke-linecap', 'round').style('stroke-linejoin', 'round');
      });
      const skipped = gr.std.status === 'Skipped';
      if (skipped) row.style('opacity', 0.55);
      tracks.forEach((t) => {
        const l = t.lane;
        row.append('path').attr('d', line(branch(t.y, 0.5, Math.max(0.5, l.bar_end_day))))
          .style('fill', 'none').style('stroke', skipped ? 'var(--g300)' : l.status === 'Complete' ? 'var(--s-done)' : 'var(--s-active)')
          .style('stroke-width', 8).style('stroke-linecap', 'round').style('stroke-linejoin', 'round');
        if (l.status === 'Behind') {
          row.append('path').attr('d', line(branch(t.y, l.bar_end_day, tClamp)))
            .style('fill', 'none').style('stroke', 'var(--s-late)').style('stroke-width', 8).style('stroke-opacity', 0.35);
        }
      });
      if (skipped) {
        row.append('text').attr('class', 'rt-row-step').attr('x', x(0.5)).attr('y', Math.min(gr.h - 6, (gr.alt ? mid + off : mid) + 22))
          .text(`Skipped for ${monthOf()} · ${gr.std.skip_reason}`)
          .each(function () {
            const tt = d3.select(this);
            let s = tt.text();
            const max = W - right - x(0.5) - 4;
            while (this.getComputedTextLength() > max && s.length > 4) { s = s.slice(0, -1); tt.text(s + '…'); }
          });
      } else if (gr.alt) {
        // track names just after the fork, outside the branches
        const tx = fx + bend + 6;
        const firstStd = d3.min(stdSteps.filter((r) => r.order >= firstAlt), (r) => x(r.target_day)) ?? Infinity;
        const firstRa = d3.min(altSteps, (r) => x(r.target_day)) ?? Infinity;
        const tagFits = (lim, txt) => tx + txt.length * 6.5 < lim - 9;
        if (tagFits(firstStd, 'STD')) row.append('text').attr('class', 'rt-row-tag').attr('x', tx).attr('y', mid - off - 7).text('STD');
        if (tagFits(firstRa, 'R&A')) row.append('text').attr('class', 'rt-row-tag').attr('x', tx).attr('y', mid + off + 14).text('R&A');
      } else if (gr.h >= 58 && gr.std.current_key) {
        const l = gr.std;
        row.append('text').attr('class', 'rt-row-step').attr('x', x(0.5)).attr('y', mid + 22)
          .text(`${l.current_step} · ${shortName(l.current_owner)} · due ${fmtDay(l.current_due)}${l.days_behind ? ` · ${l.days_behind}d late` : ''}`)
          .each(function () {
            const t = d3.select(this);
            let s = t.text();
            const max = W - right - x(0.5) - 4;
            while (this.getComputedTextLength() > max && s.length > 4) { s = s.slice(0, -1); t.text(s + '…'); }
          });
      }

      tracks.forEach((t) => {
        const isCur = (d) => d.key === t.lane.current_key;
        const dots = row.selectAll(null).data(t.steps).join('g').attr('class', 'rt-dot')
          .attr('transform', (d) => `translate(${x(d.target_day)},${gr.alt && d.track === 'Standard' && d.order < firstAlt ? mid : t.y})`)
          .on('pointerenter pointermove', showTip).on('pointerleave', () => { tip.hidden = true; });
        dots.append('circle')
          .attr('r', (d) => (d.attempts > 1 ? 8.5 : isCur(d) ? 7.5 : 5.5))
          .style('fill', (d) => (d.attempts > 1 ? 'var(--b-dk)' : dotStyle[stepKind(d)][0]))
          .style('stroke', (d) => (d.attempts > 1 ? (dotStyle[stepKind(d)][0] === '#FFFFFF' ? dotStyle[stepKind(d)][1] : dotStyle[stepKind(d)][0]) : dotStyle[stepKind(d)][1]))
          .style('stroke-width', (d) => (isCur(d) || d.attempts > 1 ? 2.5 : 2));
        dots.filter((d) => d.attempts > 1).append('text').attr('class', 'rt-retry').attr('text-anchor', 'middle').attr('dy', '0.36em').text('↻');
      });
    });
  },
});

/* ---------- state detail ---------- */
function stepper(rows, curKey) {
  return h('ol', {class: 'rt-stepper'}, rows.map((r) => h('li', {class: `rt-step k-${stepKind(r)}` + (r.key === curKey ? ' is-current' : '') + (r.days_late > 0 ? ' is-late' : '')},
    h('div', {class: 'rt-step-row'},
      h('span', {class: 'rt-step-dot', 'aria-hidden': 'true'}),
      h('span', {class: 'rt-step-name', text: r.step_label})),
    h('a', {class: 'rt-key rt-step-key', href: JIRA_BROWSE + r.key, target: '_blank', rel: 'noopener noreferrer', title: `Open ${r.key} in Jira`, text: `${r.key} ↗`}),
    h('span', {class: 'rt-step-meta'}, avatar(r.assignee), h('span', {'data-source': 'steps', 'data-field': 'assignee', 'data-where': `key=${r.key}`, text: shortName(r.assignee)})),
    h('span', {class: 'rt-step-meta'},
      h('span', {'data-source': 'steps', 'data-field': 'status', 'data-where': `key=${r.key}`, text: r.status}),
      h('span', {text: ` · ${fmtDay(r.target)}`}),
      r.days_late ? h('span', {class: 'rt-step-late', text: ` · ${r.days_late}d late`}) : null),
    r.attempts > 1 ? h('span', {class: 'rt-step-retry'}, '↻ rerun ×', h('span', {'data-source': 'steps', 'data-field': 'attempts', 'data-where': `key=${r.key}`, text: String(r.attempts)})) : null)));
}

function laneBlock(l, P, showLabel) {
  const none = l.current_key && isNobody(l.current_owner);
  let call;
  if (!l.current_key) {
    call = h('div', {class: 'rt-call rt-call--done'}, h('div', {class: 'rt-call-main'}, h('span', {class: 'rt-call-who', text: `Every ${showLabel ? TRACK_LABEL[l.track].toLowerCase() : ''} step of this release is closed.`.replace('  ', ' ')})));
  } else {
    call = h('div', {class: 'rt-call' + (none ? ' rt-call--none' : l.days_behind ? ' rt-call--late' : '')},
      avatar(l.current_owner, true),
      h('div', {class: 'rt-call-main'},
        none
          ? h('span', {class: 'rt-call-who'}, h('strong', null, markLane(l.lane, 'current_step', l.current_step)), ' has no owner yet')
          : h('span', {class: 'rt-call-who'}, 'Waiting on ', h('strong', null, markLane(l.lane, 'current_owner', l.current_owner)), ' to finish ', h('strong', null, markLane(l.lane, 'current_step', l.current_step.toLowerCase()))),
        h('span', {class: 'rt-call-meta'},
          showLabel ? h('span', {class: 'rt-chip rt-chip--track', text: TRACK_LABEL[l.track]}) : null,
          jiraLink(l.current_key),
          h('span', null, '· ', markLane(l.lane, 'current_status', l.current_status), ` · due ${fmtDay(l.current_due)}`),
          l.days_behind ? h('span', {class: 'rt-chip rt-chip--bad'}, markLane(l.lane, 'days_behind', String(l.days_behind)), l.days_behind === 1 ? ' day late' : ' days late') : null)));
  }
  return h('div', {class: 'rt-lane', id: `lane-${l.lane.replace(/[^A-Za-z]/g, '')}`},
    call,
    stepper(P.filter((r) => r.lane === l.lane).sort((a, b) => a.order - b.order), l.current_key));
}

// Report card for the chosen month: ready (a file is attached), missed (run and BI QA closed but no file),
// late (no file and the run step's target has passed) or pending (not due yet).
function rcStatus(state) {
  const R = dash.data('reportcards'), P = dash.data('steps');
  if (R.status === 'loading' || P.status !== 'ok') return {kind: 'loading'};
  if (R.status !== 'ok') return {kind: 'error'};
  const release = String(dash.params().release || '');
  const files = Array.isArray(R.data) ? R.data.filter((r) => r.state === state && r.release === release) : [];
  const steps = P.data.filter((r) => r.state === state && r.track === 'Standard');
  const run = steps.find((r) => r.step === 'run'), qa = steps.find((r) => r.step === 'qa');
  const closed = (r) => !r || r.kind === 'done' || r.kind === 'abandoned';
  const base = {files, file: files[0], run, qa};
  if (files.length) return {...base, kind: 'ready'};
  if (steps.some((x) => x.skipped)) return {...base, kind: 'skipped'};
  if (run && run.kind === 'done' && closed(qa)) return {...base, kind: 'missed'};
  if (run && run.today_day > run.target_day) return {...base, kind: 'late', days: run.today_day - run.target_day};
  return {...base, kind: 'pending'};
}

function reportCard(state) {
  const r = rcStatus(state);
  if (r.kind === 'loading') return h('span', {class: 'rt-btn dash-skeleton', text: 'Report card'});
  if (r.kind === 'error') return h('span', {class: 'rt-dl-note', text: 'Report card files didn’t load'});
  const due = r.run ? fmtDay(r.run.target) : '';
  if (r.kind === 'ready') {
    const f = r.file;
    return h('a', {class: 'rt-btn rt-btn--primary', href: f.url, target: '_blank', rel: 'noopener noreferrer',
      title: `${f.filename} · attached to ${f.key} by ${f.author || 'someone'} on ${fmtStamp(f.created)}${r.files.length > 1 ? ` · latest of ${r.files.length} files this month` : ''}. Opens in Jira, so you need to be signed in.`},
    h('span', {'aria-hidden': 'true', text: '↓'}),
    'Report card ', h('span', {'data-source': 'reportcards', 'data-field': 'format', 'data-where': `id=${enc(f.id)}`, text: f.format}),
    h('span', {style: 'opacity:.8; font-weight:400', text: ` · ${fmtStamp(f.created)}`}));
  }
  if (r.kind === 'skipped') return h('span', {class: 'rt-btn rt-rc rt-rc--pending', 'aria-disabled': 'true', text: 'No report card expected this month'});
  if (r.kind === 'missed') {
    return h('a', {class: 'rt-btn rt-rc rt-rc--missed', href: JIRA_BROWSE + r.run.key, target: '_blank', rel: 'noopener noreferrer',
      title: `Run release and BI QA are closed, but no report card file is attached for this month. Open ${r.run.key} to drop it in.`},
    h('span', {'aria-hidden': 'true', text: '!'}), `Report card missing · add to ${r.run.key}`);
  }
  if (r.kind === 'late') {
    return h('span', {class: 'rt-btn rt-rc rt-rc--late', title: `Expected with Run release / QA data, which was due ${due}.`},
      `Report card late · due ${due}`);
  }
  return h('span', {class: 'rt-btn rt-rc rt-rc--pending', 'aria-disabled': 'true', title: due ? `Expected with Run release / QA data, due ${due}.` : 'Not attached yet.'},
    'Report card not ready', due ? h('span', {style: 'font-weight:400', text: ` · due ${due}`}) : null);
}

function rcPill(state) {
  const r = rcStatus(state);
  if (r.kind === 'loading' || r.kind === 'error' || r.kind === 'skipped') return null;
  const text = {ready: 'Report card ✓', missed: 'Report card missing', late: 'Report card late', pending: 'Report card pending'}[r.kind];
  return h('span', {class: `rt-rcpill rt-rc--${r.kind}`, text});
}

function commentBlock(c, clamp, key) {
  const body = h('div', {class: 'md'}, md(c.body));
  const wrap = h('div', {class: 'rt-comment' + (clamp ? ' is-clamped' : '')},
    h('div', {class: 'rt-comment-head'},
      h('strong', {text: c.author || 'Unknown'}),
      h('span', {class: 'rt-muted', text: `${fmtStamp(c.created)} · ${ago(c.created)}`}),
      h('a', {class: 'rt-reply', href: `${JIRA_BROWSE}${key}?focusedCommentId=${enc(c.id)}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open this comment in Jira to reply'}, h('span', {'aria-hidden': 'true', text: '↩'}), 'Reply')),
    body);
  if (clamp) {
    const btn = h('button', {type: 'button', class: 'rt-link', text: 'Show full comment'});
    btn.addEventListener('click', () => {
      const open = wrap.classList.toggle('is-open');
      btn.textContent = open ? 'Show less' : 'Show full comment';
    });
    wrap.append(btn);
  }
  return wrap;
}

// One conversation per ticket: its latest comment, with earlier ones folded under it.
function thread(t, comments, step, label, D) {
  const kind = ticketKind(t);
  const latest = comments[0];
  const sig = signals(latest.body);
  const desc = D.data.find((r) => r.key === t.key && r.kind === 'description');
  const flags = [];
  if (step && step.days_late) flags.push(h('span', {class: 'rt-chip rt-chip--bad', text: `${step.days_late} days past target`}));
  if (step && step.attempts > 1) flags.push(h('span', {class: 'rt-chip rt-chip--track', text: `↻ rerun ×${step.attempts}`}));
  if (sig.fail) flags.push(h('span', {class: 'rt-chip rt-chip--bad', text: `${sig.fail} failing QA check${sig.fail > 1 ? 's' : ''}`}));
  if (sig.review) flags.push(h('span', {class: 'rt-chip rt-chip--warn', text: `${sig.review} QA check${sig.review > 1 ? 's' : ''} to review`}));
  if (sig.questions) flags.push(h('span', {class: 'rt-chip rt-chip--warn', text: 'Open question'}));
  if (sig.mentions.length) flags.push(h('span', {class: 'rt-chip rt-chip--accent', text: `Asks ${sig.mentions.join(', ')}`}));
  return h('article', {class: `rt-thread k-${kind}`, id: `thread-${t.key}`},
    h('div', {class: 'rt-thread-head'},
      jiraLink(t.key),
      h('span', {class: 'rt-thread-title', text: t.task}),
      label ? h('span', {class: 'rt-chip rt-chip--track', text: label}) : null,
      h('span', {class: 'rt-thread-who'}, avatar(t.assignee), h('span', {'data-source': 'tickets', 'data-field': 'assignee', 'data-where': `key=${t.key}`, text: t.assignee || 'Unassigned'})),
      h('span', {class: `rt-chip rt-chip--${kind === 'active' ? 'accent' : kind === 'blocked' ? 'bad' : kind === 'done' ? 'ok' : 'muted'}`, 'data-source': 'tickets', 'data-field': 'status', 'data-where': `key=${t.key}`, text: t.status})),
    flags.length ? h('div', {class: 'rt-flags'}, flags) : null,
    commentBlock(latest, true, t.key),
    comments.length > 1 ? h('details', {class: 'rt-more'}, h('summary', {text: `${comments.length - 1} earlier comment${comments.length > 2 ? 's' : ''}`}), comments.slice(1).map((c) => commentBlock(c, false, t.key))) : null,
    desc ? h('details', {class: 'rt-more'}, h('summary', {text: 'Ticket description'}), h('div', {class: 'md rt-desc'}, md(desc.body))) : null);
}

dash.draw('detail', (el) => {
  const s = RT.sel;
  if (!s) { el.replaceChildren(); return; }
  if (!statusOk('tickets', 'states', 'steps', 'lanes')) { el.replaceChildren(h('div', {class: 'rt-comment rt-comment--ghost dash-skeleton'})); return; }
  const st = dash.data('states').data.find((r) => r.state === s);
  const T = dash.data('tickets').data.filter((t) => t.state === s);
  const P = dash.data('steps').data.filter((r) => r.state === s);
  const L = dash.data('lanes').data.filter((r) => r.state === s);
  const D = dash.data('detail');
  if (!st) { el.replaceChildren(h('p', {class: 'rt-empty', text: `No tickets for ${s} in this release.`})); return; }
  const stepByKey = new Map(P.map((r) => [r.key, r]));
  const relMonth = String(dash.params().release || '').split(' ')[1];
  const isMain = (t) => stepByKey.has(t.key);
  const isOpen = (t) => ticketKind(t) !== 'done' && ticketKind(t) !== 'abandoned';
  const curKeys = new Set(L.map((l) => l.current_key).filter(Boolean));
  const trackOrder = (t) => (t.track === 'Standard' ? 0 : 1);
  const mainOpen = T.filter((t) => isOpen(t) && isMain(t)).sort((a, b) => (curKeys.has(b.key) - curKeys.has(a.key)) || trackOrder(a) - trackOrder(b) || stepByKey.get(a.key).order - stepByKey.get(b.key).order);
  const sideOpen = T.filter((t) => isOpen(t) && !isMain(t)).sort((a, b) => a.key.localeCompare(b.key, undefined, {numeric: true}));
  const closed = T.filter((t) => !isOpen(t));
  const sideLabel = (t) => (t.month && t.month !== relMonth ? `From ${t.month}` : t.track === 'Risk & Audit' ? 'R&A' : 'Other');
  const multi = L.length > 1;

  // Open tickets that aren't one of this release's steps (carried over, other work)
  const otherList = sideOpen.length ? h('ul', {class: 'rt-closed-list'}, sideOpen.map((t) => h('li', null,
    jiraLink(t.key), ` ${t.task} · `, h('span', {class: 'rt-chip rt-chip--track', text: sideLabel(t)}), ' ',
    h('span', {'data-source': 'tickets', 'data-field': 'status', 'data-where': `key=${t.key}`, text: t.status}),
    ` · ${t.assignee || 'Unassigned'}`))) : null;

  // Conversations across all of this state's tickets, newest first
  let convo;
  if (D.status === 'loading') convo = h('div', {class: 'rt-comment rt-comment--ghost dash-skeleton'});
  else if (D.status !== 'ok') convo = failMsg('Comments failed to load.');
  else {
    const threads = T.map((t) => ({t, comments: D.data.filter((r) => r.key === t.key && r.kind === 'comment').sort((a, b) => String(b.created).localeCompare(String(a.created)))}))
      .filter((x) => x.comments.length)
      .sort((a, b) => String(b.comments[0].created).localeCompare(String(a.comments[0].created)));
    convo = threads.length
      ? h('div', {class: 'rt-threads'}, threads.map(({t, comments}) => thread(t, comments, stepByKey.get(t.key),
        isMain(t) ? (t.track !== 'Standard' ? 'R&A' : '') : sideLabel(t), D)))
      : h('p', {class: 'rt-muted rt-small', text: 'No comments on this state’s tickets yet.'});
    if (D.truncated) convo = [convo, h('p', {class: 'rt-muted rt-small', text: 'Some tickets have more comments than Jira returned; open the ticket for the full thread.'})];
  }

  const backBtn = h('button', {type: 'button', class: 'rt-btn', text: '← All states'});
  backBtn.addEventListener('click', () => RT.close());
  const note = noteFor(s);
  const editNote = h('button', {type: 'button', class: 'rt-link', text: note ? 'Edit' : '+ Add a pinned note'});
  editNote.addEventListener('click', () => RT.showNote(true));
  const pinned = note
    ? h('div', {class: 'rt-pinned', id: 'pinned-note'},
      h('span', {class: 'rt-pin', 'aria-hidden': 'true', text: '📌'}),
      h('div', {class: 'rt-pinned-body'},
        h('p', {class: 'rt-pinned-text', 'data-source': 'notes', 'data-field': 'text', 'data-where': `state=${enc(s)}`, text: note.text}),
        h('span', {class: 'rt-pinned-meta'}, `Pinned note · edited ${fmtStamp(note.at)} (${ago(note.at)}) · `, editNote)))
    : h('div', {class: 'rt-pinned-add'}, editNote);
  const isSkipped = st.status === 'Skipped';
  const skipBtn = isSkipped ? null : h('button', {type: 'button', class: 'rt-btn', title: `Mark ${s} as not expected for ${monthOf()}`, text: 'Skip this month'});
  if (skipBtn) skipBtn.addEventListener('click', () => RT.showSkip(true));
  let skipBanner = null;
  if (isSkipped) {
    const undo = h('button', {type: 'button', class: 'rt-btn', text: 'Undo skip'});
    undo.addEventListener('click', () => RT.undoSkip(s));
    skipBanner = h('div', {class: 'rt-skipbanner'},
      h('div', {class: 'rt-call-main'},
        h('span', {class: 'rt-call-who'}, h('strong', {text: `Skipped for ${monthOf()}`}), ' · not expected this month, so it isn’t counted as behind and no report card is due.'),
        h('span', {class: 'rt-call-meta'}, 'Reason: ', markState(s, 'skip_reason', st.skip_reason))),
      undo);
  }
  el.replaceChildren(
    h('div', {class: 'rt-d-top'},
      h('div', {class: 'rt-d-head'},
        stateShape(s, STATUS_FILL[st.status] || 'var(--g400)', false, 36, 28),
        h('h2', {class: 'rt-d-title', text: st.name}),
        h('span', {class: `rt-chip rt-chip--${STATUS_CLASS[st.status] || 'muted'}`},
          markState(s, 'status', st.status),
          st.status === 'Behind' ? [' · ', markState(s, 'days_behind', String(st.days_behind)), ' days'] : null),
        h('span', {class: 'rt-muted rt-small'}, markState(s, 'steps_closed', String(st.steps_closed)), ' of ', markState(s, 'steps_total', String(st.steps_total)), ' steps closed'),
        h('div', {class: 'rt-d-actions'}, reportCard(s), skipBtn, backBtn)),
      pinned,
      skipBanner,
      h('div', {class: 'rt-lanes' + (isSkipped ? ' is-skipped' : '')},
        h('span', {class: 'rt-eyebrow', text: multi ? 'Waiting on · by track' : 'Waiting on'}),
        L.map((l) => laneBlock(l, P, multi)))),
    h('div', {class: 'rt-d-scroll'},
      h('section', {class: 'rt-d-sec', id: 'conversations'},
        h('h3', {class: 'rt-h3', text: 'Conversations · latest first'}),
        convo),
      otherList ? h('section', {class: 'rt-d-sec', id: 'other-open'},
        h('details', {class: 'rt-more'}, h('summary', {text: `Also open: carried over and other tickets (${sideOpen.length})`}), otherList)) : null,
      closed.length ? h('section', {class: 'rt-d-sec', id: 'closed'},
        h('details', {class: 'rt-more'}, h('summary', {text: `Closed tickets (${closed.length})`}),
          h('ul', {class: 'rt-closed-list'}, closed.map((t) => h('li', null,
            jiraLink(t.key), ` ${t.task}${t.track !== 'Standard' ? ' (R&A)' : ''} — ${t.status}`,
            t.resolved ? ` ${fmtStamp(t.resolved)}` : ''))))) : null));
});

/* ---------- schedule editor ---------- */
async function saveSchedule(state, step, value) {
  let saved = true;
  try {
    const db = await claude.use('db');
    if (!db) throw new Error('no db');
    const ref = db.doc(`data/refresh/schedule/${state}_${step}`);
    if (value === '' || value === null) await ref.delete();
    else await ref.set({state, step, day: value});
  } catch (e) { saved = false; }
  document.querySelectorAll('#unsaved').forEach((p) => { p.hidden = saved; });
}

dash.draw('schedule-editor', (el) => {
  const S = dash.data('schedule'), T = dash.data('tickets');
  if (S.status === 'loading') { el.replaceChildren(h('div', {class: 'rt-comment rt-comment--ghost dash-skeleton'})); return; }
  if (S.status !== 'ok') { el.replaceChildren(failMsg('The schedule failed to load.')); return; }
  const ORDER = ['DC', 'MA', 'IL', 'GA'];
  const fromTickets = T.status === 'ok' ? T.data.map((t) => t.state).filter(Boolean) : [];
  const states = [...new Set([...ORDER, ...fromTickets])];
  const STEPS = [['source', 'Provide source data'], ['run', 'Run release / QA data'], ['qa', 'BI QA'], ['dash', 'Refresh dashboards'], ['snap', 'Analytics snapshot'], ['drc', 'Data report card'], ['upload', 'Upload report card']];
  const find = (state, step) => S.data.find((r) => r.state === state && r.step === step);
  const input = (state, step) => {
    const row = find(state, step);
    const def = find('ALL', step);
    const inp = h('input', {type: 'number', min: 1, max: 31, step: 1, inputmode: 'numeric', class: 'rt-day',
      'aria-label': `${state === 'ALL' ? 'Default' : state} target day for ${step}`,
      placeholder: state === 'ALL' ? '' : (def ? String(def.day) : '')});
    inp.value = row ? String(row.day) : '';
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const n = Math.round(Number(v));
      if (v !== '' && !(n >= 1 && n <= 31)) { inp.value = row ? String(row.day) : ''; return; }
      saveSchedule(state, step, v === '' ? '' : n);
    });
    return inp;
  };
  el.replaceChildren(h('div', {class: 'md-tablewrap'}, h('table', {class: 'rt-sched-table'},
    h('thead', null, h('tr', null, h('th', {text: 'Step'}), h('th', {text: 'Default'}), states.map((s) => h('th', {text: s})))),
    h('tbody', null, STEPS.map(([step, label]) => h('tr', null,
      h('th', {scope: 'row', text: label}),
      h('td', null, input('ALL', step)),
      states.map((s) => h('td', null, input(s, step)))))))));
});
