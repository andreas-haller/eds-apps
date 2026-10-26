import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../api.js';

const json = (data, { status = 200, headers = {} } = {}) => ({
  ok: status < 400,
  status,
  headers: new Headers(headers),
  json: async () => data,
});
const base = { org: 'acme', repo: 'web', getToken: () => 'ims-token', sleep: async () => {} };

test('rejects missing or unsafe site context', () => {
  assert.throws(() => createClient({ ...base, org: '' }), /valid org and site/);
  assert.throws(() => createClient({ ...base, repo: '../x' }), /valid org and site/);
});

test('crawls the DA source tree with continuation tokens and skips hidden folders', async () => {
  const calls = [];
  const client = createClient({ ...base, fetchImpl: async (url, init) => {
    calls.push({ url, token: init.headers['da-continuation-token'] });
    assert.equal(init.headers.Authorization, 'Bearer ims-token');
    assert.equal(init.credentials, 'omit');
    if (url === 'https://admin.da.live/list/acme/web' && !init.headers['da-continuation-token']) {
      return json([
        { path: '/acme/web/index.html', name: 'index', ext: 'html', lastModified: 1 },
        { path: '/acme/web/en', name: 'en' },
        { path: '/acme/web/.da', name: '.da' },
      ], { headers: { 'da-continuation-token': 'next' } });
    }
    if (url === 'https://admin.da.live/list/acme/web') {
      return json([{ path: '/acme/web/data.json', name: 'data', ext: 'json', lastModified: 2 }]);
    }
    if (url === 'https://admin.da.live/list/acme/web/en') {
      return json([{ path: '/acme/web/en/about us.html', name: 'about us', ext: 'html', lastModified: 3 }]);
    }
    throw new Error(`unexpected ${url}`);
  } });
  const progress = [];
  const files = await client.listSource((update) => progress.push(update));
  assert.deepEqual(files.map((file) => file.path).sort(), ['/acme/web/data.json', '/acme/web/en/about us.html', '/acme/web/index.html']);
  assert.equal(calls.some((call) => call.url.includes('/.da')), false);
  assert.equal(calls.some((call) => call.url === 'https://admin.da.live/list/acme/web/en'), true);
  assert.equal(calls.find((call) => call.token).token, 'next');
  assert.deepEqual(progress.at(-1), { folders: 2, files: 3 });
});

test('surfaces DA listing permission errors', async () => {
  const client = createClient({ ...base, fetchImpl: async () => json(null, { status: 403 }) });
  await assert.rejects(client.listSource(), /Listing DA content failed: you do not have permission/);
});

test('runs the EDS bulk status job and returns its resources', async () => {
  const calls = [];
  let polls = 0;
  const client = createClient({ ...base, fetchImpl: async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    assert.equal(init.headers.Authorization, 'Bearer ims-token');
    if (url === 'https://admin.hlx.page/status/acme/web/main/*') {
      return json({ status: 202, job: { name: 'job-42', state: 'created' }, links: { self: 'https://evil.example/job' } }, { status: 202 });
    }
    if (url === 'https://admin.hlx.page/job/acme/web/main/status/job-42') {
      polls += 1;
      return json(polls < 2
        ? { state: 'running', progress: { total: 2, processed: 1 } }
        : { state: 'stopped', progress: { total: 2, processed: 2 } });
    }
    if (url === 'https://admin.hlx.page/job/acme/web/main/status/job-42/details') {
      return json({ state: 'stopped', data: { resources: [{ path: '/', previewLastModified: 'x' }] } });
    }
    throw new Error(`unexpected ${url}`);
  } });
  const progress = [];
  const resources = await client.fetchStatus((update) => progress.push(update));
  assert.deepEqual(resources, [{ path: '/', previewLastModified: 'x' }]);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { paths: ['/*'], select: ['preview', 'live'], forceAsync: true });
  assert.equal(calls.some((call) => call.url.includes('evil.example')), false);
  assert.deepEqual(progress, [{ state: 'running', total: 2, processed: 1 }, { state: 'stopped', total: 2, processed: 2 }]);
});

test('reports failed, cancelled and timed out status jobs', async () => {
  const job = (final) => async (url) => (url.endsWith('/*')
    ? json({ job: { name: 'job-1', state: 'created' } }, { status: 202 })
    : json(final));
  await assert.rejects(createClient({ ...base, fetchImpl: job({ state: 'stopped', error: 'boom' }) }).fetchStatus(), /job failed: boom/);
  await assert.rejects(createClient({ ...base, fetchImpl: job({ state: 'stopped', cancelled: true }) }).fetchStatus(), /cancelled/);
  let clock = 0;
  const slow = createClient({ ...base, jobTimeout: 1000, now: () => { clock += 600; return clock; }, fetchImpl: job({ state: 'running' }) });
  await assert.rejects(slow.fetchStatus(), /did not finish in time/);
  const denied = createClient({ ...base, fetchImpl: async () => json(null, { status: 401 }) });
  await assert.rejects(denied.fetchStatus(), /not signed in/);
});

test('confirms candidate sources with the DA source API', async () => {
  const methods = new Set();
  const client = createClient({ ...base, fetchImpl: async (url, init) => {
    methods.add(init.method);
    if (url === 'https://admin.da.live/source/acme/web/kept%20page.html') {
      return json(null, { headers: { 'last-modified': 'Thu, 01 Oct 2026 09:00:00 GMT' } });
    }
    return json(null, { status: 404 });
  } });
  const found = await client.confirmSources(['/acme/web/kept page.html', '/acme/web/gone.html']);
  assert.deepEqual([...methods], ['HEAD']);
  assert.deepEqual([...found.keys()], ['/acme/web/kept page.html']);
  assert.equal(found.get('/acme/web/kept page.html').lastModified, 'Thu, 01 Oct 2026 09:00:00 GMT');
  const failing = createClient({ ...base, fetchImpl: async () => json(null, { status: 500 }) });
  await assert.rejects(failing.confirmSources(['/acme/web/x.html']), /Checking DA source failed: HTTP 500/);
});
