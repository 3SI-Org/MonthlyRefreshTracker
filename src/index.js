// Backend for the CUSP Monthly Refresh Tracker (Forge resolver).
//
//  jiraSearch   runs one of three fixed Jira searches AS THE SIGNED-IN USER, so everyone sees
//               only what their own Jira permissions allow.
//  storeList    lists the hand-kept data (schedule, roster, CS leads, pinned notes, skips).
//  storeSet     writes one document (editors only, see EDITOR_GROUP below).
//  storeDelete  removes one document (editors only).
//  bootstrap    seeds storage with the data exported from the Claude dashboard on first run,
//               and tells the page whether this user may edit.

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { QUERIES } from './queries';
import { adfToMarkdown } from './adf';
import seed from './seed.json';

const resolver = new Resolver();

/* ---------- Jira ---------- */
resolver.define('jiraSearch', async ({payload}) => {
  const q = QUERIES[payload && payload.query];
  if (!q) return {error: 'Unknown query'};
  let jql;
  try { jql = q.build((payload && payload.params) || {}); } catch (e) { return {error: e.message}; }
  const body = {jql, fields: q.fields, maxResults: q.maxResults};
  if (payload.nextPageToken) body.nextPageToken = String(payload.nextPageToken);
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!res.ok) return {error: `Jira search failed (${res.status}): ${(await res.text()).slice(0, 300)}`};
  const answer = await res.json();
  if (q.richText) {
    for (const it of answer.issues || []) {
      const f = it.fields || {};
      if (f.description) f.description = adfToMarkdown(f.description);
      for (const c of (f.comment && f.comment.comments) || []) c.body = adfToMarkdown(c.body);
    }
  }
  return {issues: answer.issues || [], nextPageToken: answer.nextPageToken || null, isLast: answer.isLast !== false};
});

/* ---------- storage ---------- */
// Paths look like data/refresh/notes/DC (same as the Claude dashboard). KVS keys can't hold "/",
// so they are stored with ":" instead.
const COLLECTIONS = ['schedule', 'roster', 'cs_leads', 'notes', 'skips'];
const PATH = new RegExp(`^data/refresh/(${COLLECTIONS.join('|')})(/[A-Za-z0-9_.-]{1,64})?$`);
const toKey = (path) => path.replace(/\//g, ':');

async function isEditor() {
  // Set EDITOR_GROUP (forge variables set EDITOR_GROUP "group-name") to limit edits to one
  // Jira group. Unset, anyone who can open the app can edit, like the Refresh button.
  const group = process.env.EDITOR_GROUP;
  if (!group) return true;
  const res = await api.asUser().requestJira(route`/rest/api/3/myself?expand=groups`, {headers: {Accept: 'application/json'}});
  if (!res.ok) return false;
  const me = await res.json();
  return ((me.groups && me.groups.items) || []).some((g) => g.name === group);
}

async function listPrefix(prefix) {
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

resolver.define('storeList', async ({payload}) => {
  const path = String((payload && payload.path) || '');
  const m = path.match(PATH);
  if (!m || m[2]) return {error: 'Not a collection'};
  const rows = await listPrefix(toKey(path) + ':');
  return {data: rows.map((r) => ({id: r.key.split(':').pop(), ...r.value})).sort((a, b) => String(a.id).localeCompare(String(b.id)))};
});

resolver.define('storeSet', async ({payload}) => {
  const path = String((payload && payload.path) || '');
  const m = path.match(PATH);
  if (!m || !m[2]) return {ok: false, error: 'Not a document path'};
  if (!(await isEditor())) return {ok: false, error: 'Only editors can change this'};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  if (JSON.stringify(data).length > 20000) return {ok: false, error: 'Too large'};
  await kvs.set(toKey(path), data);
  return {ok: true};
});

resolver.define('storeDelete', async ({payload}) => {
  const path = String((payload && payload.path) || '');
  const m = path.match(PATH);
  if (!m || !m[2]) return {ok: false, error: 'Not a document path'};
  if (!(await isEditor())) return {ok: false, error: 'Only editors can change this'};
  await kvs.delete(toKey(path));
  return {ok: true};
});

/* ---------- first run ---------- */
resolver.define('bootstrap', async () => {
  const flag = await kvs.get('meta:seeded');
  if (!flag) {
    for (const [path, value] of Object.entries(seed.documents || {})) {
      if (PATH.test(path)) await kvs.set(toKey(path), value);
    }
    await kvs.set('meta:seeded', {at: new Date().toISOString(), from: seed.exportedFrom || 'seed.json'});
  }
  return {editor: await isEditor(), seeded: !flag};
});

export const handler = resolver.getDefinitions();
