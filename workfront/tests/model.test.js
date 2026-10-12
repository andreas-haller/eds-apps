import assert from 'node:assert/strict';
import test from 'node:test';
import { addPageLink, filterCatalog, formatBrief, isLinkedToPage, taskDraft } from '../model.js';

const page = {
  siteId: 'northstar/website',
  path: '/products/trail.html',
  url: 'https://da.live/edit#/northstar/website/products/trail.html',
  userId: 'alex',
};

const catalog = {
  projects: [
    { id: 'launch', type: 'project', name: 'Trail launch', siteIds: ['northstar/website'] },
    { id: 'other', type: 'project', name: 'Trail launch', siteIds: ['northstar/other'] },
  ],
  tasks: [
    { id: 'linked', type: 'task', name: 'Write product copy', projectId: 'launch', pageLinks: [page], assigneeIds: ['alex'] },
    { id: 'title-only', type: 'task', name: 'Trail launch', projectId: 'other', pageLinks: [], assigneeIds: ['sam'] },
    { id: 'site-only', type: 'task', name: 'Update navigation', projectId: 'launch', pageLinks: [], assigneeIds: ['sam'] },
  ],
  users: [{ id: 'alex', name: 'Alex Morgan' }, { id: 'sam', name: 'Sam Chen' }],
};

test('defaults to this page and never infers relevance from titles', () => {
  const result = filterCatalog(catalog, page);
  assert.deepEqual(result.tasks.map((task) => task.id), ['linked']);
  assert.deepEqual(result.projects.map((project) => project.id), ['launch']);
  assert.equal(result.projects[0].matchReason, '1 task linked to this page');
});

test('site filter uses explicit associations, including the parent project', () => {
  const result = filterCatalog(catalog, page, 'site');
  assert.deepEqual(result.tasks.map((task) => task.id), ['linked', 'site-only']);
  assert.equal(result.tasks[1].matchReason, 'Project linked to this site');
});

test('All includes every accessible record', () => {
  assert.equal(filterCatalog(catalog, page, 'all').tasks.length, 3);
  assert.equal(filterCatalog(catalog, page, 'all').projects.length, 2);
});

test('Assigned to me and selected user use exact assignee IDs', () => {
  assert.deepEqual(filterCatalog(catalog, page, 'me').tasks.map((task) => task.id), ['linked']);
  const selected = filterCatalog(catalog, page, 'user', 'sam');
  assert.deepEqual(selected.tasks.map((task) => task.id), ['title-only', 'site-only']);
  assert.equal(selected.tasks[0].matchReason, 'Assigned to Sam Chen');
  assert.equal(filterCatalog(catalog, { ...page, userId: null }, 'me').tasks.length, 0);
});

test('search narrows the selected context rather than bypassing it', () => {
  assert.equal(filterCatalog(catalog, page, 'page', '', 'Trail launch').tasks.length, 0);
  assert.equal(filterCatalog(catalog, page, 'page', '', 'product').tasks.length, 1);
});

test('linking is immutable and does not duplicate a page-to-task association', () => {
  const task = catalog.tasks[2];
  const first = addPageLink(task, page);
  const second = addPageLink(first.item, { ...page, path: 'products/trail.html' });
  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(second.item.pageLinks.length, 1);
  assert.equal(task.pageLinks.length, 0);
});

test('identical paths on different sites are not the same page', () => {
  assert.equal(isLinkedToPage(catalog.tasks[0], { ...page, siteId: 'northstar/other' }), false);
});

test('missing page context never matches or permits writes', () => {
  assert.equal(filterCatalog(catalog, {}).tasks.length, 0);
  assert.throws(() => addPageLink(catalog.tasks[2], {}), /current page/);
  assert.throws(() => taskDraft({ name: 'New task', projectId: 'launch' }, {}), /current page/);
});

test('new task includes the selected project and current page link', () => {
  const draft = taskDraft({ name: '  New copy  ', projectId: 'launch', description: 'Keep it concise.' }, page);
  assert.equal(draft.name, 'New copy');
  assert.equal(draft.projectId, 'launch');
  assert.equal(draft.description, `Keep it concise.\n\nPage: ${page.url}`);
  assert.equal(isLinkedToPage(draft, page), true);
  assert.throws(() => taskDraft({ name: ' ', projectId: 'launch' }, page), /task name/);
  assert.throws(() => taskDraft({ name: 'New task' }, page), /project/);
});

test('chat brief includes title, Workfront URL, brief and attributed notes', () => {
  const brief = formatBrief({
    ...catalog.tasks[0],
    url: 'https://northstar.my.workfront.com/task/linked',
    description: 'A useful brief.',
    notes: [{ author: 'Sam', text: 'Use the approved messaging.' }],
  }, catalog.projects[0]);
  assert.match(brief, /^Write product copy\n\nhttps:\/\/northstar.my.workfront.com\/task\/linked/);
  assert.match(brief, /Project: Trail launch/);
  assert.match(brief, /A useful brief/);
  assert.match(brief, /Sam: Use the approved messaging/);
});