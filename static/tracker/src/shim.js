/*
 * A small stand-in for the Claude dashboard runtime, so the tracker's page code (md.js, app.js,
 * mapview.js) runs inside Forge Custom UI with almost no changes.
 *
 * It provides the same globals the page expects:
 *   window.d3                       d3 v7
 *   window.dash                     data(id), onData(fn), calc(id, def), loader(id, def), draw(name, fn|{mount,update,unmount}),
 *                                   params(), setParams(obj), resetParams(), refresh(id), setLink(name), colors
 *   window.claude.use('db')         db.doc(path).set(data) / .delete()   -> Forge storage via the resolver
 *
 * Sources (what the original dashboard called datasets) are declared in SOURCES below.
 */
import {invoke, router} from '@forge/bridge';
import * as d3 from 'd3';

window.d3 = d3;

/* ---------- sources ---------- */
const SOURCES = {
  tickets: {kind: 'jira', query: 'tickets', uses: ['release', 'prev_release']},
  detail: {kind: 'jira', query: 'detail', uses: ['keys']},
  reportcards: {kind: 'jira', query: 'reportcards', uses: []},
  schedule: {kind: 'store', path: 'data/refresh/schedule'},
  roster: {kind: 'store', path: 'data/refresh/roster'},
  csleads: {kind: 'store', path: 'data/refresh/cs_leads'},
  notes: {kind: 'store', path: 'data/refresh/notes'},
  skips: {kind: 'store', path: 'data/refresh/skips'},
  usmap: {kind: 'file', url: './data/usmap.json'},
};
const DEFAULT_PARAMS = {keys: ['PRD-5116'], release: '', prev_release: ''};
const AUTO_REFRESH_MINUTES = 5; // re-pull Jira while the page is visible; 0 turns it off

/* ---------- state ---------- */
let params = {...DEFAULT_PARAMS};
let version = 0;
const state = {};      // id -> {status, data, columns, truncated, refreshing, message, sig, seq}
const loaders = {};    // id -> fn
const calcs = {};      // id -> {inputs, fn}
const calcCache = {};  // id -> {version, value}
const drawings = {};   // name -> spec
const made = new WeakMap();
const onDataFns = [];

const sigFor = (id) => JSON.stringify((SOURCES[id].uses || []).map((k) => params[k]));
const toRows = (v) => {
  if (Array.isArray(v)) return {data: v, truncated: false};
  if (v && Array.isArray(v.data)) return {data: v.data, truncated: !!v.truncated};
  return {data: v, truncated: false};
};
const columnsOf = (rows) => (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : []);

async function fetchSource(id) {
  const src = SOURCES[id];
  if (src.kind === 'file') {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`Couldn’t load ${src.url}`);
    return toRows(await res.json());
  }
  if (src.kind === 'store') {
    const r = await invoke('storeList', {path: src.path});
    if (r && r.error) throw new Error(r.error);
    return toRows(r.data || []);
  }
  const args = {query: src.query, params: Object.fromEntries((src.uses || []).map((k) => [k, params[k]]))};
  const answer = await invoke('jiraSearch', args);
  if (answer && answer.error) throw new Error(answer.error);
  const call = async (tool, a) => {
    const next = await invoke('jiraSearch', {...args, ...a, query: args.query, params: args.params});
    if (next && next.error) throw new Error(next.error);
    return next;
  };
  const fn = loaders[id];
  return toRows(fn ? await fn({answer, call, args}) : (answer.issues || []));
}

function load(id, keepData) {
  const prev = state[id];
  const seq = (prev ? prev.seq : 0) + 1;
  const sig = SOURCES[id].kind === 'jira' ? sigFor(id) : '';
  state[id] = keepData && prev && prev.status === 'ok'
    ? {...prev, refreshing: true, seq, sig}
    : {status: 'loading', data: [], columns: [], truncated: false, refreshing: false, message: '', seq, sig};
  bump();
  fetchSource(id).then(({data, truncated}) => {
    if (state[id].seq !== seq) return; // a newer load won
    state[id] = {status: 'ok', data, columns: columnsOf(data), truncated, refreshing: false, message: '', seq, sig};
    bump();
  }).catch((e) => {
    if (state[id].seq !== seq) return;
    console.error(`[tracker] ${id}:`, e);
    const old = state[id];
    state[id] = old.status === 'ok' || old.refreshing
      ? {...old, refreshing: false, message: String(e.message || e)}
      : {status: 'error', data: [], columns: [], truncated: false, refreshing: false, message: String(e.message || e), seq, sig};
    bump();
  });
}

function sourceData(id) {
  const src = SOURCES[id];
  if (!src) return {status: 'missing', data: [], columns: [], refreshing: false, truncated: false, message: `No source “${id}”`};
  const s = state[id];
  if (!s || (src.kind === 'jira' && s.sig !== sigFor(id) && s.status !== 'loading')) load(id, false);
  return state[id];
}

function calcData(id) {
  const c = calcs[id];
  const hit = calcCache[id];
  if (hit && hit.version === version) return hit.value;
  const ins = c.inputs.map((i) => dash.data(i));
  let value;
  if (ins.some((d) => d.status === 'loading')) value = {status: 'loading', data: null, refreshing: false, truncated: false};
  else if (ins.some((d) => d.status !== 'ok')) value = {status: 'error', data: null, refreshing: false, truncated: false, message: (ins.find((d) => d.status !== 'ok') || {}).message || ''};
  else {
    try {
      const out = c.fn(...ins.map((d) => (Array.isArray(d.data) ? d.data : d.data == null ? [] : d.data)));
      value = {status: 'ok', data: out, columns: columnsOf(out), refreshing: ins.some((d) => d.refreshing), truncated: ins.some((d) => d.truncated)};
    } catch (e) {
      console.error(`[tracker] calc ${id}:`, e);
      value = {status: 'error', data: null, refreshing: false, truncated: false, message: String(e.message || e)};
    }
  }
  calcCache[id] = {version, value};
  return value;
}

/* ---------- rendering ---------- */
let pending = false;
function bump() { version++; schedule(); }
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(render);
}
function runDrawing(name, el) {
  const spec = drawings[name];
  if (!spec || el.closest('[hidden]')) return;
  try {
    if (typeof spec === 'function') { spec(el); return; }
    let m = made.get(el);
    if (!m) {
      el.replaceChildren();
      m = {value: spec.mount ? spec.mount(el) : undefined};
      made.set(el, m);
    }
    if (spec.update) spec.update(el, m.value);
  } catch (e) {
    console.error(`[tracker] drawing ${name}:`, e);
    const m = made.get(el);
    if (m && typeof spec === 'object') { made.delete(el); try { spec.unmount && spec.unmount(el, m.value); } catch (_) { /* ignore */ } }
  }
}
function render() {
  pending = false;
  for (const fn of onDataFns) { try { fn(); } catch (e) { console.error('[tracker] onData:', e); } }
  for (const name of Object.keys(drawings)) {
    document.querySelectorAll(`[data-draw="${CSS.escape(name)}"]`).forEach((el) => { runDrawing(name, el); watch(el); });
  }
}
const widths = new WeakMap();
const ro = new ResizeObserver((entries) => {
  let changed = false;
  for (const e of entries) {
    const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
    const old = widths.get(e.target);
    if (!old || old[0] !== w || old[1] !== h) { widths.set(e.target, [w, h]); changed = changed || !!old; }
  }
  if (changed) schedule();
});
const watched = new WeakSet();
function watch(el) { if (!watched.has(el)) { watched.add(el); ro.observe(el); } }
window.addEventListener('resize', schedule);

/* ---------- public API ---------- */
const dash = {
  colors: ['#2E63FF', '#30C7A9', '#F0B435', '#FF5733', '#7336D9', '#52C5EB', '#58DD70', '#EF35B2'],
  data(id) { return calcs[id] ? calcData(id) : sourceData(id); },
  onData(fn) { onDataFns.push(fn); try { fn(); } catch (e) { console.error('[tracker] onData:', e); } },
  calc(id, def) { calcs[id] = {inputs: def.inputs || [], fn: def.fn}; delete calcCache[id]; },
  loader(id, def) { loaders[id] = def.fn; },
  draw(name, spec) {
    if (spec !== undefined) { drawings[name] = spec; schedule(); return; }
    document.querySelectorAll(`[data-draw="${CSS.escape(name)}"]`).forEach((el) => runDrawing(name, el));
  },
  params() { return {...params}; },
  setParams(obj) {
    const before = {...params};
    params = {...params, ...obj};
    const changed = Object.keys(obj).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(params[k]));
    if (!changed.length) return;
    for (const [id, src] of Object.entries(SOURCES)) {
      if (state[id] && (src.uses || []).some((k) => changed.includes(k))) load(id, false);
    }
    bump();
  },
  resetParams() { dash.setParams({...DEFAULT_PARAMS}); },
  refresh(id) { if (SOURCES[id]) load(id, true); },
  setLink() { /* deep links aren't wired up in Forge yet; see README */ },
};
window.dash = dash;

/* ---------- saving (Forge storage through the resolver) ---------- */
function reloadStoreFor(path) {
  for (const [id, src] of Object.entries(SOURCES)) {
    if (src.kind === 'store' && path.startsWith(src.path + '/') && state[id]) load(id, true);
  }
}
const db = {
  doc(path) {
    return {
      async set(data) {
        const r = await invoke('storeSet', {path, data});
        if (!r || !r.ok) throw new Error((r && r.error) || 'Not saved');
        reloadStoreFor(path);
      },
      async delete() {
        const r = await invoke('storeDelete', {path});
        if (!r || !r.ok) throw new Error((r && r.error) || 'Not deleted');
        reloadStoreFor(path);
      },
    };
  },
};
window.claude = {use: async (name) => (name === 'db' ? db : null)};

/* ---------- Forge specifics ---------- */
// Links: Custom UI runs in a sandboxed iframe, so open http(s) links through Forge.
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) { e.preventDefault(); router.open(href); }
}, true);

// The iframe grows with its content, so size the fixed-height layout from the screen instead
// of the iframe. app.js's fit() calls this when it exists. Tune the 230px for Jira's header.
window.RT_VIEWPORT_HEIGHT = () => Math.max(640, (window.screen && window.screen.availHeight ? window.screen.availHeight : 900) - 230);

// First run: copy the data exported from the Claude dashboard into Forge storage.
invoke('bootstrap').then((r) => { window.RT_EDITOR = !!(r && r.editor); if (r && r.seeded) Object.keys(SOURCES).forEach((id) => { if (SOURCES[id].kind === 'store' && state[id]) load(id, true); }); }).catch((e) => console.error('[tracker] bootstrap:', e));

// Keep Jira data fresh while the page is open.
if (AUTO_REFRESH_MINUTES > 0) {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    ['tickets', 'reportcards', 'detail'].forEach((id) => { if (state[id] && state[id].status === 'ok') load(id, true); });
  }, AUTO_REFRESH_MINUTES * 60 * 1000);
}
