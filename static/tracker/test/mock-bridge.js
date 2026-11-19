// Local stand-in for @forge/bridge, used only by `npm run build:mock`.
// Serves saved Jira answers from ./fixtures and the seed data, and keeps writes in memory.
const store = {};
let seedLoaded = null;
const json = (u) => fetch(u).then((r) => r.json());
async function seed() {
  if (!seedLoaded) seedLoaded = json('./fixtures/seed.json').then((s) => { Object.assign(store, s.documents || {}); });
  return seedLoaded;
}
const SAMPLE_COMMENTS = (keys) => ({
  isLast: true,
  issues: keys.map((key, i) => ({key, fields: {
    summary: key,
    description: i === 0 ? '**Summary**\n\nSample description (mock data).' : '',
    comment: {total: 1, comments: [{id: String(10000 + i), author: {displayName: 'Sample Person'}, created: new Date(Date.now() - i * 864e5).toISOString(),
      body: i === 0 ? 'Mock comment: <custom data-type="mention">@Sample Owner</custom> can you check the **FAIL** row?\n\n| Check | Result |\n| --- | --- |\n| Row counts | **FAIL** |' : 'Mock comment for ' + key}]},
  }})),
});
export async function invoke(name, payload = {}) {
  await seed();
  if (name === 'bootstrap') return {editor: true, seeded: false};
  if (name === 'jiraSearch') {
    if (payload.query === 'tickets') return json('./fixtures/tickets.json');
    if (payload.query === 'reportcards') return json('./fixtures/reportcards.json');
    if (payload.query === 'detail') return SAMPLE_COMMENTS((payload.params && payload.params.keys) || []);
    return {error: 'Unknown query'};
  }
  if (name === 'storeList') {
    const pre = payload.path + '/';
    return {data: Object.entries(store).filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, v]) => ({id: k.slice(pre.length), ...v}))};
  }
  if (name === 'storeSet') { store[payload.path] = payload.data; return {ok: true}; }
  if (name === 'storeDelete') { delete store[payload.path]; return {ok: true}; }
  return {error: 'Unknown resolver ' + name};
}
export const router = {open: (u) => { console.log('[mock] router.open', u); window.__opened = u; }, navigate: (u) => console.log('[mock] navigate', u)};
export const view = {getContext: async () => ({siteUrl: 'https://example.atlassian.net'})};
