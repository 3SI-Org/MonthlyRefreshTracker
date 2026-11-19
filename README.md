# CUSP Monthly Refresh Tracker: Forge app

The Monthly Refresh Tracker, rebuilt as an **Atlassian Forge app** that lives inside Jira (Apps menu → **CUSP Refresh Tracker**). It is a port of the Claude dashboard “Monthly Refresh Tracker (Tom’s copy)” as of 2026‑11‑19: same page code, same look, same rules, with Jira and storage wired up the Forge way.

<img width="1920" height="874" alt="image" src="https://github.com/user-attachments/assets/b8ff6643-3ed1-4487-adae-982248483820" />

What you get in Jira:

- **All states view**: map of the client states (eastern US) plus the schedule timeline, with CS leads, the Georgia standard / Risk & Audit fork, retry dots for reruns, skipped months, upcoming states and leads.
- **State view**: pinned note, “Waiting on” per track, step cards with Jira links, the report card download for the chosen month (grey / late / flashing when missing), conversations grouped by ticket with Reply links, Skip this month.
- **Refresh** button, plus an automatic re-pull every 5 minutes while the page is open.

---

## 1. One-time setup (about 15 minutes)

You need Node 20+ and an Atlassian account that can install apps on `team-1605722649546.atlassian.net` (a site admin, or ask one to approve the install).

```bash
npm install -g @forge/cli          # Forge CLI (tested with 15.1.0)
forge login                        # paste an API token from id.atlassian.com/manage-profile/security/api-tokens
```

Then, in this folder:

```bash
npm install                        # backend packages
npm --prefix static/tracker install
npm run build                      # builds the page into static/tracker/build
forge register                     # creates the app in your developer console and writes app.id into manifest.yml
forge deploy                       # deploys to the "development" environment
forge install                      # choose Jira, then the site team-1605722649546.atlassian.net
```

Open Jira → **Apps** → **CUSP Refresh Tracker**. The first time, each person clicks **Allow access** so the app can read Jira *as them*.

The first load copies the data exported from the Claude dashboard (`src/seed.json`) into the app’s storage: the schedule, upcoming states and leads, CS leads, DC’s pinned note and GA’s November skip. It only does this once.

### Going to production

```bash
forge deploy -e production
forge install -e production        # same site
```

Development is for you to try things; production is what the team uses. Each environment has its own storage, so the seed runs once in each.

### Who can edit notes, skips and the schedule

By default anyone who can open the app can edit, like the Refresh button. To limit editing to one Jira group:

```bash
forge variables set EDITOR_GROUP "cusp-refresh-editors"            # development
forge variables set -e production EDITOR_GROUP "cusp-refresh-editors"
forge deploy                                                       # variables apply on the next deploy
```

Anyone else sees the same page, and a save shows “That wasn’t saved. Only editors…”.

### Day to day

```bash
forge tunnel        # run the backend on your machine against real Jira while you edit (page changes still need npm run build)
forge logs          # backend errors
```

After any change: `npm run build && forge deploy`.

---

## 2. How it fits together

```
Jira global page (Custom UI iframe)                         Forge backend (src/index.js)
┌───────────────────────────────────────────┐   invoke()   ┌──────────────────────────────────────┐
│ static/tracker/public/index.html          │ ───────────▶ │ jiraSearch  → Jira REST, asUser()    │
│   page/md.js, page/app.js, page/mapview.js│              │              /rest/api/3/search/jql  │
│   (the dashboard's page code, as-is)      │ ◀─────────── │              ADF → markdown (adf.js) │
│ shim.js = stand-in for the dashboard      │              │ storeList / storeSet / storeDelete   │
│   runtime: dash.*, claude.use('db'), d3   │              │              → Forge KVS              │
└───────────────────────────────────────────┘              │ bootstrap   → seed once, editor flag │
                                                           └──────────────────────────────────────┘
```

- **Jira access is per person.** Every search runs with `api.asUser()`, so people only see tickets their own Jira permissions allow, exactly like the Claude dashboard.
- **The JQL lives on the server** (`src/queries.js`). The page can only ask for the three named searches, with validated values: a release name or ticket keys.
- **Hand-kept data lives in Forge storage** under the same paths the dashboard used, with `:` in place of `/` in the keys:

| Data | Path | Written by |
|---|---|---|
| Target day per step (default + per state) | `data/refresh/schedule/<STATE>_<step>` | Schedule panel |
| Upcoming states and leads (MD, CT, AR) | `data/refresh/roster/<STATE>` | seed only (edit in code or add a form) |
| CS lead per state | `data/refresh/cs_leads/<STATE>` | seed only |
| Pinned note per state | `data/refresh/notes/<STATE>` | Pinned note editor |
| Skipped month | `data/refresh/skips/<STATE>_<YYYY-MM>` | Skip this month |

### Files

| Path | What it is |
|---|---|
| `manifest.yml` | Forge app: one `jira:globalPage`, one resolver function, scopes |
| `src/index.js` | Resolver: Jira searches, storage, editor check, first-run seed |
| `src/queries.js` | The three JQL searches (tickets, detail, reportcards) and their fields |
| `src/adf.js` | Converts Jira’s rich text (ADF) into the markdown the page renders |
| `src/seed.json` | Data exported from the Claude dashboard on 2026‑11‑19 |
| `static/tracker/public/index.html` | Page markup and styles (3Si / CUSP palette, fonts) |
| `static/tracker/public/page/*.js` | Page code from the dashboard: `md.js`, `app.js`, `mapview.js` |
| `static/tracker/src/shim.js` | Stand-in for the dashboard runtime: data loading, calcs, drawings, saving, link handling |
| `static/tracker/public/dash-base.css` | The two styles the dashboard runtime supplied (`.dash-select`, `.dash-skeleton`) |
| `static/tracker/public/fonts/` | Space Grotesk, Inter, JetBrains Mono (SIL OFL, licenses included) |
| `static/tracker/public/data/usmap.json` | US state outlines (US Census via us-atlas, Albers USA projection) |
| `static/tracker/test/` | Mock bridge for local testing without Jira |
| `test/unit.test.mjs` | Checks for the ADF converter and the JQL validation |

### What changed from the Claude dashboard

| In the dashboard | In Forge |
|---|---|
| Live queries through Claude’s Atlassian connector | `jiraSearch` resolver, `asUser()`, Jira REST v3 enhanced search |
| Comments arrived as markdown | Comments arrive as ADF and are converted in `src/adf.js` (mentions keep the same shape, so “Asks @Name” still works) |
| Dashboard store (`write_db`) | Forge KVS via `storeSet` / `storeDelete` |
| “Only editors of this dashboard” | Anyone, or members of `EDITOR_GROUP` |
| Refresh button only | Refresh button plus auto re-pull every 5 minutes (`AUTO_REFRESH_MINUTES` in `shim.js`) |
| Page filled the window | The Jira iframe grows with its content, so the page sizes itself to the screen height minus 230 px (`RT_VIEWPORT_HEIGHT` in `shim.js`) |
| Links opened in a new tab | Links go through `router.open()` (required in Custom UI) |
| Sources panel (where each number came from, CSV download) | Not included |
| Deep links (`#state-DC`) | Not wired up yet (`dash.setLink` is a no-op) |

Only one edit was made to `page/app.js` for Forge, marked in the code: `fit()` uses `RT_VIEWPORT_HEIGHT`. `JIRA_SITE` is still hard-coded to `team-1605722649546.atlassian.net` at the top of `page/app.js`.

---

## 3. Testing without Jira

```bash
cd static/tracker
npm run build:mock                 # builds ./build-mock with a fake @forge/bridge
npx http-server build-mock -p 8765 # or: python3 -m http.server 8765 --directory build-mock
```

Open http://localhost:8765. The mock reads `test/fixtures/seed.json`, which is included, and two Jira answers you add yourself:

- `test/fixtures/tickets.json`: the JSON of a Jira search for the tickets query (`{"issues": [...]}`)
- `test/fixtures/reportcards.json`: the same for the report card query

These were left out of the package on purpose, because they hold real ticket titles and names. Comments in the mock are fake.

Backend checks (ADF conversion, JQL validation): `npm test` from the project root.

---

## 4. Ideas for later

- **Update on ticket changes instead of polling:** add a `trigger` module on `avi:jira:updated:issue` that writes a “last changed” stamp to storage, and have the page poll that cheap value every 30 seconds.
- **Forms for CS leads and the upcoming-states list:** today they come from the seed.
- **Jira dashboard gadget** (`jira:dashboardGadget`) showing just the All states view.
- **Deep links:** use `view.createHistory()` from `@forge/bridge` so `/state-DC` opens that state.
