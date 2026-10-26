import assert from 'node:assert/strict';
import test from 'node:test';
import { applySource, edsRows, previewUrls } from '../model.js';
import { createSourceLookup } from '../source-lookup.js';
import { createClient } from '../api.js';

const t = (iso) => Date.parse(iso);

test('builds EDS-only rows with provisional statuses', () => {
  const rows = edsRows([
    { path: '/b', previewLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/a', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/en/index.md', previewLastModified: '2026-10-03T10:00:00Z', publishLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/never' },
    { path: '/.helix/config.json', previewLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
  ]);
  assert.deepEqual(rows.map((row) => [row.webPath, row.status, row.da]), [
    ['/a', 'synced', 'pending'],
    ['/b', 'preview-only', 'pending'],
    ['/en/', 'pending', 'pending'],
  ]);
});

test('applies a DA source, or its absence, to an EDS row', () => {
  const [row] = edsRows([{ path: '/a', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' }]);
  const edited = applySource(row, { daPath: '/acme/web/a.html', lastModified: '2026-10-02T00:00:00Z' });
  assert.equal(edited.status, 'edited');
  assert.equal(edited.sourceModified, t('2026-10-02T00:00:00Z'));
  assert.equal(edited.da, 'loaded');
  const synced = applySource(row, { daPath: '/acme/web/a.html', lastModified: t('2026-09-01T00:00:00Z') });
  assert.equal(synced.status, 'synced');
  const missing = applySource(row, null);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.daPath, '');
});

test('formats selected rows as preview URLs', () => {
  assert.equal(
    previewUrls([{ webPath: '/' }, { webPath: '/en/page' }], 'acme', 'web'),
    'https://main--web--acme.aem.page/\nhttps://main--web--acme.aem.page/en/page',
  );
});

test('looks up sources per folder, caches listings and confirms unlisted paths', async () => {
  const listed = [];
  const confirmed = [];
  const client = {
    listFolder: async (folder) => {
      listed.push(folder);
      if (folder === '/acme/web/en') {
        return [
          { path: '/acme/web/en/page.html', ext: 'html', lastModified: 5 },
          { path: '/acme/web/en/index.html', ext: 'html', lastModified: 6 },
        ];
      }
      return [];
    },
    confirmSources: async ([daPath]) => {
      confirmed.push(daPath);
      return new Map(daPath === '/acme/web/odd.html' ? [[daPath, { daPath, lastModified: 'x' }]] : []);
    },
  };
  const lookup = createSourceLookup({ client, org: 'acme', repo: 'web' });
  assert.deepEqual(await lookup('/en/page'), { daPath: '/acme/web/en/page.html', lastModified: 5 });
  assert.deepEqual(await lookup('/en/'), { daPath: '/acme/web/en/index.html', lastModified: 6 });
  assert.deepEqual(await lookup('/odd'), { daPath: '/acme/web/odd.html', lastModified: 'x' });
  assert.equal(await lookup('/gone'), null);
  assert.deepEqual(listed, ['/acme/web/en', '/acme/web']);
  assert.deepEqual(confirmed, ['/acme/web/odd.html', '/acme/web/gone.html']);
});

test('retries a folder listing after a failure', async () => {
  let calls = 0;
  const client = {
    listFolder: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return []; },
    confirmSources: async () => new Map(),
  };
  const lookup = createSourceLookup({ client, org: 'acme', repo: 'web' });
  await assert.rejects(lookup('/a'), /boom/);
  assert.equal(await lookup('/a'), null);
  assert.equal(calls, 2);
});

test('lists a single DA folder with pagination and treats a missing folder as empty', async () => {
  const fetchImpl = async (url, init) => {
    const ok = (body, headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body });
    if (url.endsWith('/list/acme/web/none')) return { ok: false, status: 404, headers: new Headers() };
    if (!init.headers['da-continuation-token']) {
      return ok([{ name: 'a', ext: 'html', path: '/acme/web/en/a.html' }, { name: 'sub', path: '/acme/web/en/sub' }], { 'da-continuation-token': 'next' });
    }
    return ok([{ name: 'b', ext: 'html', path: '/acme/web/en/b.html' }, { name: '.hidden', ext: 'html', path: '/acme/web/en/.hidden.html' }]);
  };
  const client = createClient({ org: 'acme', repo: 'web', fetchImpl });
  assert.deepEqual((await client.listFolder('/acme/web/en')).map((item) => item.name), ['a', 'b']);
  assert.deepEqual(await client.listFolder('/acme/web/none'), []);
});
