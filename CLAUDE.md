# CLAUDE.md: CUSP Monthly Refresh Tracker (Forge)

Context for anyone, human or Claude, picking this project up. Read README.md for setup; this file holds the *why* and the business rules.

## What this is

3Si runs a monthly data refresh for each CUSP state client. Every month each state gets a set of Jira tickets (project **PRD**) under a monthly epic and fix version, and this app shows where every state stands: who holds the current step, what's late, whether the data report card file was dropped in, and the team's conversation on each ticket.

It started as a Claude dashboard artifact (Nov 2026) and was ported here verbatim. The page code in `static/tracker/public/page/` is the dashboard's code. `static/tracker/src/shim.js` re-implements the small runtime it expected (`dash.*`). Keep that boundary: page logic goes in `page/*.js`, plumbing goes in the shim or the resolver.

## Jira conventions the app depends on

- **Fix version per month:** `"<YYYY> <Month> Monthly Data Refresh"`, e.g. `2026 November Monthly Data Refresh`. Epic per month: `2026-11 Nov Data Refresh` (PRD-5116); December is PRD-5144.
- **Ticket title format:** `[ST] <Month> Release - <Step>`, e.g. `[IL] November Release - QA`. The state, month and step are parsed from the title (loader in `page/app.js`).
- **Steps, in order** (keyword → step id → label):
  `source data` → source → Provide source data · `run release` → run → Run release / QA data · `qa` (title starts with QA) → qa → BI QA · `dashboard` → dash → Refresh dashboards · `snapshot` → snap → Analytics snapshot · `report card` → drc → Data report card · `upload` → upload → Upload report card.
  States have different subsets (DC has no source step; GA has all seven).
- **Tracks:** a title containing `Risk & Audit` is on the **R&A track**, and only GA has one (run, qa, dash). It draws as a fork off GA's row after the shared first step.
- **Required fields when creating tickets:** `customfield_10055` Clients (DC OSSE = 10138, GA DECAL = 10028, IL IDEC = 10105, MA EEC = 10030, MD MSDE = 10338), Team `customfield_10001` (Business Intelligence = `763945da-3c8e-4815-b9d1-d44cb2ebdff9`), parent = the month's epic, fixVersions = the month.
- **DC uploads its report card to the Resource Hub**, not the Analytics Library (PRD-5505 Nov, PRD-5506 Dec).

## Business rules (all in `page/app.js` calcs)

- **Current step** = first step not Done/Abandoned. **Abandoned counts as closed.**
- **Status of a state** (standard track): Skipped (if skipped this month) → Complete → Behind (today past the current step's target) → Not started → Due soon (target within 2 days) → On track.
- **Targets** = day of month from the schedule (`data/refresh/schedule`): a state's own value, else the `ALL` default, else month end. R&A uses the same targets as the matching standard step.
- **Rerun** (retry dot ↻): a step with more than one ticket in the same release, or `rerun` / `re-run` in its title or labels.
- **Report card for the chosen month:** the latest `.csv`/`.xlsx` attached to a state's ticket whose title names that month (else the month it was attached), where the file name looks like a report card (`report card`, `drc`) or the ticket is a Report Card ticket.
  - ready → blue download button
  - **missed** → flashing: Run release Done and BI QA closed, but no file
  - late → coral: no file and the run step's target has passed
  - pending → grey
  - skipped month → "No report card expected"
- **Skip this month:** per state per month (`data/refresh/skips/<ST>_<YYYY-MM>` with a reason). The state isn't counted as behind, nothing turns late, and no report card is due. The next month is tracked as usual.
- **Pinned note:** one per state, kept until edited or removed, shows "edited <date>".
- **"x of y states are behind"** counts only states expected this month, using the standard track.

## People and states (as of Nov 2026)

- **CS leads:** IL → Erin Moran · DC and MD → Laura Wallace · GA and MA → Grace Dong. Stored in `data/refresh/cs_leads`; shown on the All states view.
- **Active states:** DC (OSSE), MA (EEC), IL (IDEC), GA (DECAL).
- **Starting soon:** MD (monthly refreshes start February 2027).
- **Leads:** CT, AR.
- **Product owner of this tracker:** Tom Riecken (product management / data engineering, CUSP).

## Design decisions to keep

- **3Si / CUSP color system:** warm grays, Dk Blue `#0F1E46` headings, Space Grotesk / Inter / JetBrains Mono.
- **No red/blue for good/bad, on purpose (politics, US map):**
  - green `#43A630` = done / on track
  - charcoal `#403E3C` = in progress
  - CUSP coral `#FF5733` = behind / blocked; text uses `#D63E1A`
  - gold = due soon
  - teal = starting soon
  - grey = skipped
  - 3Si Blue `#2E63FF` only for buttons, links, focus and selection
- **Map:** zoomed to the client states (eastern US); DC is magnified in an inset; labels avoid each other; lead bubbles nudge off active ones.
- **Rail cards** stay minimal: shape + code + status, owner · current step, step bar, and a report card pill only when late or missing. Detail lives in the state view.
- **The All states view shows CS leads,** not step owners. The state view shows step owners.

## Working on it

- `npm run build` after any change under `static/tracker/`, then `forge deploy`.
- `npm --prefix static/tracker run build:mock` serves a local, Jira-free version (see README §3).
- `npm test` checks the ADF converter and the JQL validation.
- Searches are fixed on the server (`src/queries.js`). Add new ones there, never by sending JQL from the page.
- The page only runs drawings that aren't inside a `[hidden]` element. After un-hiding a section, call `dash.draw(name)` (see `setView` in app.js).
