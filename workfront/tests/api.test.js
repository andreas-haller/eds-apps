import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkfrontClient } from '../api.js';

const page = { siteId: 'northstar/website', path: '/collections/fall.html', url: 'https://da.live/edit#/northstar/website/collections/fall.html' };
const task = { ID: 'task-1', name: 'Write copy', projectID: 'project-1', parameterValues: {} };
const options = {
  workfrontOrigin: 'https://northstar.my.workfront.com',
  apiVersion: 'v21.0',
  getToken: () => 'ims-access-token',
};
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('direct mode requires a safe Workfront origin and supported API version', () => {
  assert.throws(() => createWorkfrontClient({ ...options, workfrontOrigin: 'https://attacker.example' }), /valid HTTPS/);
  assert.throws(() => createWorkfrontClient({ ...options, workfrontOrigin: 'http://northstar.my.workfront.com' }), /valid HTTPS/);
  assert.throws(() => createWorkfrontClient({ ...options, apiVersion: 'latest' }), /supported Workfront API version/);
});

test('catalog calls the tenant API with the host SessionID and normalizes records', async () => {
  const calls = [];
  const client = createWorkfrontClient({ ...options, fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.SessionID, 'ims-access-token');
    assert.equal(init.headers.Authorization, undefined);
    assert.match(url, /^https:\/\/northstar\.my\.workfront\.com\/attask\/api\/v21\.0\//);
    if (url.includes('/user/current')) return response({ ID: 'alex', name: 'Alex Morgan' });
    if (url.includes('/user/search')) return response([{ ID: 'alex', name: 'Alex Morgan' }]);
    if (url.includes('/project/')) return response([{ ID: 'project-1', name: 'Fall launch', parameterValues: { 'DE:EW Site': page.siteId } }]);
    return response([{ ...task, assignedToID: 'alex', parameterValues: { 'DE:EW Page Links': JSON.stringify([page]) }, notes: [{ noteText: 'Approved messaging.', owner: { name: 'Sam' } }] }]);
  } });
  const catalog = await client.load();
  assert.equal(catalog.userId, 'alex');
  assert.equal(calls.some((url) => url.includes('/user/current?fields=ID%2Cname')), true);
  assert.equal(calls.some((url) => url.includes('/session')), false);
  assert.deepEqual(catalog.tasks[0].pageLinks, [page]);
  assert.deepEqual(catalog.projects[0].siteIds, [page.siteId]);
  assert.deepEqual(catalog.tasks[0].assigneeIds, ['alex']);
  assert.equal(catalog.tasks[0].notes[0].text, 'Approved messaging.');
  assert.equal(catalog.tasks[0].url, 'https://northstar.my.workfront.com/task/task-1/overview');
});

test('a task is reread before linking and an existing association is never rewritten', async () => {
  const calls = [];
  const client = createWorkfrontClient({ ...options, fetchImpl: async (url, init) => {
    calls.push(init.method);
    return response({ ...task, parameterValues: { 'DE:EW Page Links': JSON.stringify([page]) } });
  } });
  assert.equal((await client.linkPage(task.ID, page)).added, false);
  assert.deepEqual(calls, ['GET']);
});

test('concurrent clicks share one write and preserve existing page links', async () => {
  const anotherPage = { ...page, path: '/about.html', url: 'https://da.live/edit#/northstar/website/about.html' };
  let writes = 0;
  const client = createWorkfrontClient({ ...options, fetchImpl: async (url, init) => {
    if (init.method === 'PUT') {
      writes += 1;
      assert.deepEqual(JSON.parse(init.body.get('DE:EW Page Links')), [anotherPage, page]);
      assert.equal(init.body.has('status'), false);
      assert.equal(init.body.has('assignedToID'), false);
      return response({ ID: task.ID });
    }
    return response({ ...task, parameterValues: { 'DE:EW Page Links': JSON.stringify([anotherPage]) } });
  } });
  await Promise.all([client.linkPage(task.ID, page), client.linkPage(task.ID, page)]);
  assert.equal(writes, 1);
});

test('task creation submits the page link and association in a single write', async () => {
  let writes = 0;
  const client = createWorkfrontClient({ ...options, fetchImpl: async (url, init) => {
    writes += 1;
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('projectID'), 'project-1');
    assert.match(init.body.get('description'), /Page: https:\/\/da.live\/edit#/);
    assert.deepEqual(JSON.parse(init.body.get('DE:EW Page Links')), [page]);
    return response({ ...task, parameterValues: { 'DE:EW Page Links': init.body.get('DE:EW Page Links') } });
  } });
  const created = await client.createTask({ name: 'Write copy', projectId: 'project-1' }, page);
  assert.equal(writes, 1);
  assert.deepEqual(created.pageLinks, [page]);
});

test('authentication and permission errors have actionable messages', async () => {
  for (const status of [401, 403]) {
    const client = createWorkfrontClient({ ...options, fetchImpl: async () => response(null, status) });
    await assert.rejects(client.load(), (error) => error.status === status && /token|permission/.test(error.message));
  }
});

test('the latest host token is read for each direct API request', async () => {
  let token = 'first-ims-token';
  const headers = [];
  const client = createWorkfrontClient({
    ...options,
    getToken: () => token,
    fetchImpl: async (url, init) => {
      headers.push(init.headers.SessionID);
      if (url.includes('/user/current')) return response({ ID: 'alex', name: 'Alex Morgan' });
      if (url.includes('/user/search')) return response([]);
      return response([]);
    },
  });
  await client.load();
  token = 'refreshed-ims-token';
  await client.load();
  assert.equal(headers.includes('first-ims-token'), true);
  assert.equal(headers.includes('refreshed-ims-token'), true);
});

test('missing host token blocks the request without sending credentials', async () => {
  let calls = 0;
  const client = createWorkfrontClient({ ...options, getToken: () => '', fetchImpl: async () => { calls += 1; } });
  await assert.rejects(client.load(), /Experience Workspace Workfront token is unavailable/);
  assert.equal(calls, 0);
});

test('invalid association data fails explicitly rather than inferring a match', async () => {
  const client = createWorkfrontClient({ ...options, fetchImpl: async () => response({ ...task, parameterValues: { 'DE:EW Page Links': 'not-json' } }) });
  await assert.rejects(client.linkPage(task.ID, page), /associations.*invalid/);
});

test('failed writes are marked uncertain and are not automatically retried', async () => {
  let calls = 0;
  const client = createWorkfrontClient({ ...options, fetchImpl: async () => { calls += 1; throw new TypeError('Network failure'); } });
  await assert.rejects(client.createTask({ name: 'New copy', projectId: 'project-1' }, page), (error) => error.uncertain);
  assert.equal(calls, 1);
});

test('an incomplete success response does not invite a duplicate task creation', async () => {
  const client = createWorkfrontClient({ ...options, fetchImpl: async () => response({ ID: 'new-task' }) });
  await assert.rejects(client.createTask({ name: 'New copy', projectId: 'project-1' }, page), (error) => error.uncertain && /may have been created/.test(error.message));
});

test('catalog paginates instead of silently truncating All', async () => {
  let pages = 0;
  const client = createWorkfrontClient({ ...options, fetchImpl: async (url) => {
    if (url.includes('/user/current')) return response({ ID: 'alex', name: 'Alex Morgan' });
    if (url.includes('/user/search')) return response([{ ID: 'alex', name: 'Alex Morgan' }]);
    if (url.includes('/task/')) return response([]);
    if (url.includes('/user/')) return response([{ ID: 'alex', name: 'Alex' }]);
    pages += 1;
    const offset = Number(new URL(url, 'https://plugin.example').searchParams.get('$$FIRST'));
    return response(offset === 0 ? Array.from({ length: 100 }, (_, index) => ({ ID: `project-${index}`, name: `Project ${index}` })) : [{ ID: 'project-last', name: 'Last project' }]);
  } });
  assert.equal((await client.load()).projects.length, 101);
  assert.equal(pages, 2);
});