// The three Jira searches the tracker runs. They mirror the live queries of the original
// Claude dashboard, but the JQL is built here on the server from validated values, so the
// page can only ask for these searches and nothing else.

const RELEASE = /^20[0-9]{2} (January|February|March|April|May|June|July|August|September|October|November|December) Monthly Data Refresh$/;
const KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/;

export const QUERIES = {
  // Every ticket on the chosen month's fix version, plus last month's tickets still open.
  tickets: {
    build: ({release, prev_release}) => {
      if (!RELEASE.test(String(release)) || !RELEASE.test(String(prev_release))) throw new Error('Bad release name');
      return `fixVersion = "${release}" OR (fixVersion = "${prev_release}" AND statusCategory != Done) ORDER BY key ASC`;
    },
    fields: ['summary', 'status', 'assignee', 'duedate', 'updated', 'resolutiondate', 'fixVersions', 'customfield_10020', 'labels'],
    maxResults: 100,
  },
  // Description and comments of the tickets of the state that is open on the page.
  detail: {
    build: ({keys}) => {
      const list = (Array.isArray(keys) ? keys : []).filter((k) => KEY.test(String(k))).slice(0, 80);
      if (!list.length) throw new Error('No ticket keys');
      return `key in (${list.join(',')}) ORDER BY key ASC`;
    },
    fields: ['summary', 'description', 'comment'],
    maxResults: 100,
    richText: true, // description and comments come back as ADF; convert to markdown
  },
  // Report card data files attached to Run Release and Report Card tickets in the last 200 days.
  reportcards: {
    build: () => 'project = PRD AND attachments IS NOT EMPTY AND (summary ~ "\\"Run Release\\"" OR summary ~ "\\"Report Card\\"") AND created >= -200d ORDER BY created DESC',
    fields: ['summary', 'attachment'],
    maxResults: 100,
  },
};
