import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compare, daEditUrl, daPathToWebPath, edsRows, filterRows, normalizeWebPath, resolveMissing,
  sortRows, summarize, toCsv, webPathToDaPath,
} from '../model.js';

const site = { org: 'acme', repo: 'web' };
const t = (iso) => Date.parse(iso);

test('maps DA source paths to EDS web paths', () => {
  assert.equal(daPathToWebPath('/acme/web/index.html', 'acme', 'web'), '/');
  assert.equal(daPathToWebPath('/acme/web/en/index.html', 'acme', 'web'), '/en/');
  assert.equal(daPathToWebPath('/acme/web/en/About Us.html', 'acme', 'web'), '/en/about-us');
  assert.equal(daPathToWebPath('/acme/web/Café/Été.html', 'acme', 'web'), '/cafe/ete');
  assert.equal(daPathToWebPath('/acme/web/data/Products.json', 'acme', 'web'), '/data/products.json');
  assert.equal(daPathToWebPath('/acme/web/docs/guide.PDF', 'acme', 'web'), '/docs/guide.pdf');
  assert.equal(daPathToWebPath('/other/web/x.html', 'acme', 'web'), null);
});

test('normalizes EDS status paths', () => {
  assert.equal(normalizeWebPath('/en/About'), '/en/about');
  assert.equal(normalizeWebPath('/en/index'), '/en/');
  assert.equal(normalizeWebPath('/index.md'), '/');
  assert.equal(normalizeWebPath('/en/page.md'), '/en/page');
  assert.equal(normalizeWebPath(''), null);
});

test('maps web paths back to DA source paths and edit URLs', () => {
  assert.equal(webPathToDaPath('/', 'acme', 'web'), '/acme/web/index.html');
  assert.equal(webPathToDaPath('/en/page', 'acme', 'web'), '/acme/web/en/page.html');
  assert.equal(webPathToDaPath('/data.json', 'acme', 'web'), '/acme/web/data.json');
  assert.equal(daEditUrl('/acme/web/en/page.html'), 'https://da.live/canvas#/acme/web/en/page');
  assert.equal(daEditUrl('/acme/web/data.json'), 'https://da.live/sheet#/acme/web/data');
  assert.equal(daEditUrl('/acme/web/docs/a b.pdf'), 'https://da.live/#/acme/web/docs');
  assert.equal(daEditUrl(''), '');
});

test('classifies every EDS resource against the DA source', () => {
  const resources = [
    { path: '/', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/edited', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/pending', previewLastModified: '2026-10-03T10:00:00Z', publishLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/draft', previewLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/gone', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', publishLastModifiedBy: 'sam@acme.com', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/live-only', publishLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
    { path: '/neither' },
    { path: '/.helix/config.json', previewLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' },
  ];
  const sources = [
    { path: '/acme/web/index.html', name: 'index', ext: 'html', lastModified: t('2026-10-01T09:00:00Z') },
    { path: '/acme/web/edited.html', name: 'edited', ext: 'html', lastModified: t('2026-10-02T09:00:00Z') },
    { path: '/acme/web/pending.html', name: 'pending', ext: 'html', lastModified: t('2026-10-02T09:00:00Z') },
    { path: '/acme/web/draft.html', name: 'draft', ext: 'html', lastModified: t('2026-09-30T09:00:00Z') },
    { path: '/acme/web/live-only.html', name: 'live-only', ext: 'html', lastModified: t('2026-09-30T09:00:00Z') },
    { path: '/acme/web/new.html', name: 'new', ext: 'html', lastModified: t('2026-10-04T09:00:00Z') },
    { path: '/acme/web/.da/config.json', name: 'config', ext: 'json', lastModified: 1 },
  ];
  const rows = compare(resources, sources, site);
  const byPath = Object.fromEntries(rows.map((row) => [row.webPath, row]));
  assert.deepEqual(rows.map((row) => row.webPath), ['/', '/draft', '/edited', '/gone', '/live-only', '/new', '/pending']);
  assert.equal(byPath['/'].status, 'synced');
  assert.equal(byPath['/'].daPath, '/acme/web/index.html');
  assert.equal(byPath['/edited'].status, 'edited');
  assert.equal(byPath['/pending'].status, 'pending');
  assert.equal(byPath['/draft'].status, 'preview-only');
  assert.equal(byPath['/gone'].status, 'missing');
  assert.equal(byPath['/gone'].daPath, '');
  assert.equal(byPath['/gone'].liveBy, 'sam@acme.com');
  assert.equal(byPath['/live-only'].status, 'synced');
  assert.equal(byPath['/new'].status, 'unpreviewed');

  const counts = summarize(rows);
  assert.equal(counts.eds, 6);
  assert.equal(counts.unpreviewed, 1);
  assert.equal(counts.missing, 1);
});

test('edits after the preview win over an unpublished preview', () => {
  const rows = compare(
    [{ path: '/draft', previewLastModified: '2026-10-01T10:00:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' }],
    [{ path: '/acme/web/draft.html', name: 'draft', ext: 'html', lastModified: t('2026-10-05T10:00:00Z') }],
    site,
  );
  assert.equal(rows[0].status, 'edited');
});

test('excludes EDS resources without a preview source date in lazy and full scans', () => {
  const timestamp = '2026-10-01T10:00:00Z';
  const resources = [
    { path: '/page', previewLastModified: timestamp, previewSourceLastModified: timestamp },
    { path: '/redirect', publishLastModified: timestamp },
    { path: '/en/index.md', previewLastModified: timestamp, previewSourceLastModified: '' },
    { path: '/null', previewLastModified: timestamp, previewSourceLastModified: null },
  ];
  const sources = ['page', 'redirect', 'en/index', 'null', 'draft'].map((path) => ({
    path: `/acme/web/${path}.html`, ext: 'html', lastModified: 1,
  }));

  assert.deepEqual(edsRows(resources).map((row) => row.webPath), ['/page']);
  const rows = compare(resources, sources, site);
  // DA sources of excluded EDS resources are not reported as "Not previewed".
  assert.deepEqual(rows.map((row) => row.webPath), ['/draft', '/page']);
  assert.equal(summarize(rows).eds, 1);
  assert.equal(summarize(rows).unpreviewed, 1);
});

test('a source confirmed by the source API replaces a missing classification', () => {
  const [row] = compare([{ path: '/gone', previewLastModified: '2026-10-01T10:00:00Z', publishLastModified: '2026-10-01T10:01:00Z', previewSourceLastModified: '2026-09-01T00:00:00Z' }], [], site);
  assert.equal(resolveMissing(row, undefined), row);
  const resolved = resolveMissing(row, { daPath: '/acme/web/gone.html', lastModified: 'Thu, 01 Oct 2026 09:00:00 GMT' });
  assert.equal(resolved.status, 'synced');
  assert.equal(resolved.daPath, '/acme/web/gone.html');
});

test('filters, searches and sorts rows', () => {
  const rows = [
    { webPath: '/b', daPath: '/acme/web/b.html', status: 'synced', preview: 2, live: 3, sourceModified: 1 },
    { webPath: '/a', daPath: '', status: 'missing', preview: 5, live: null, sourceModified: null },
    { webPath: '/c', daPath: '/acme/web/c.html', status: 'unpreviewed', preview: null, live: null, sourceModified: 9 },
  ];
  assert.deepEqual(filterRows(rows).map((row) => row.webPath), ['/b', '/a']);
  assert.deepEqual(filterRows(rows, { status: 'unpreviewed' }).map((row) => row.webPath), ['/c']);
  assert.deepEqual(filterRows(rows, { search: ' B ' }).map((row) => row.webPath), ['/b']);
  assert.deepEqual(sortRows(rows).map((row) => row.webPath), ['/a', '/b', '/c']);
  assert.deepEqual(sortRows(rows, { key: 'preview', direction: 'desc' }).map((row) => row.webPath), ['/a', '/b', '/c']);
  assert.deepEqual(sortRows(rows, { key: 'status' }).map((row) => row.webPath), ['/a', '/b', '/c']);
});

test('exports CSV with escaped cells', () => {
  const csv = toCsv([{
    webPath: '/a,b', kind: 'page', status: 'missing', daPath: '', sourceModified: null,
    preview: Date.UTC(2026, 9, 1), previewBy: '=cmd', live: null, liveBy: '',
  }]);
  const [header, line] = csv.split('\n');
  assert.equal(header, 'path,type,status,da_source,source_modified,previewed,previewed_by,published,published_by');
  assert.equal(line, '"/a,b",page,Source deleted,,,2026-10-01T00:00:00.000Z,\'=cmd,,');
});
