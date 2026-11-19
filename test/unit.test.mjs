// Quick checks for the backend helpers: node test/run-unit.mjs
import assert from 'node:assert/strict';
import {adfToMarkdown} from '../src/adf.js';
import {QUERIES} from '../src/queries.js';

const doc = {type: 'doc', version: 1, content: [
  {type: 'paragraph', content: [{type: 'mention', attrs: {id: 'abc', text: '@Collin Marsden'}}, {type: 'text', text: ' please review '}, {type: 'text', text: 'FAIL', marks: [{type: 'strong'}]}]},
  {type: 'bulletList', content: [{type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'one'}]}]}, {type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'two', marks: [{type: 'link', attrs: {href: 'https://x.test'}}]}]}]}]},
  {type: 'table', content: [
    {type: 'tableRow', content: [{type: 'tableHeader', content: [{type: 'paragraph', content: [{type: 'text', text: 'Check'}]}]}, {type: 'tableHeader', content: [{type: 'paragraph', content: [{type: 'text', text: 'Result'}]}]}]},
    {type: 'tableRow', content: [{type: 'tableCell', content: [{type: 'paragraph', content: [{type: 'text', text: 'Rows'}]}]}, {type: 'tableCell', content: [{type: 'paragraph', content: [{type: 'text', text: 'Recommended status: REVIEW'}]}]}]},
  ]},
  {type: 'codeBlock', content: [{type: 'text', text: 'select 1'}]},
]};
const md = adfToMarkdown(doc);
assert.match(md, /<custom data-type="mention" data-id="abc">@Collin Marsden<\/custom> please review \*\*FAIL\*\*/);
assert.match(md, /- one\n- \[two\]\(https:\/\/x\.test\)/);
assert.match(md, /\| Check \| Result \|\n\| --- \| --- \|\n\| Rows \| Recommended status: REVIEW \|/);
assert.match(md, /```\nselect 1\n```/);

assert.equal(QUERIES.tickets.build({release: '2026 November Monthly Data Refresh', prev_release: '2026 October Monthly Data Refresh'}),
  'fixVersion = "2026 November Monthly Data Refresh" OR (fixVersion = "2026 October Monthly Data Refresh" AND statusCategory != Done) ORDER BY key ASC');
assert.throws(() => QUERIES.tickets.build({release: 'x" OR project = SECRET', prev_release: '2026 October Monthly Data Refresh'}));
assert.equal(QUERIES.detail.build({keys: ['PRD-1', 'bad key', 'PRD-22']}), 'key in (PRD-1,PRD-22) ORDER BY key ASC');
assert.throws(() => QUERIES.detail.build({keys: []}));
console.log('unit tests passed');
