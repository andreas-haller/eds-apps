export const STATUSES = Object.freeze({
  missing: { label: 'Source deleted', description: 'On EDS, but the DA source document no longer exists' },
  edited: { label: 'Edited since preview', description: 'The DA source changed after the last preview' },
  'preview-only': { label: 'Preview only', description: 'Previewed, but never published' },
  pending: { label: 'Changes not published', description: 'Preview is newer than the published version' },
  synced: { label: 'Up to date', description: 'Preview matches the DA source and is published' },
  unpreviewed: { label: 'Not previewed', description: 'Exists in DA, but was never previewed or published' },
});

export const EDS_STATUSES = ['missing', 'edited', 'preview-only', 'pending', 'synced'];

function sanitizeSegment(segment) {
  return segment
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHidden(path) {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

export function toTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function kindOf(webPath) {
  const name = webPath.split('/').pop();
  if (!/\.[a-z0-9]+$/i.test(name)) return 'page';
  return name.endsWith('.json') ? 'sheet' : 'file';
}

// Maps a DA list item path (/org/repo/folder/Doc Name.html) to its EDS web path (/folder/doc-name).
export function daPathToWebPath(daPath, org, repo) {
  const prefix = `/${org}/${repo}`;
  if (typeof daPath !== 'string' || !daPath.startsWith(`${prefix}/`)) return null;
  const segments = daPath.slice(prefix.length).split('/').filter(Boolean);
  if (!segments.length) return null;
  const file = segments.pop();
  const dot = file.lastIndexOf('.');
  const name = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
  const folder = segments.map(sanitizeSegment);
  const base = folder.length ? `/${folder.join('/')}` : '';
  const slug = sanitizeSegment(name);
  if (ext === 'html') return slug === 'index' ? `${base}/` : `${base}/${slug}`;
  return `${base}/${slug}${ext ? `.${ext}` : ''}`;
}

export function normalizeWebPath(path) {
  if (typeof path !== 'string' || !path) return null;
  let web = `/${path.replace(/^\/+/, '')}`.toLowerCase().replace(/\.md$/, '');
  if (web.endsWith('/index')) web = web.slice(0, -'index'.length);
  return web;
}

// Best-effort DA source path for an EDS web path, used to confirm a missing source.
export function webPathToDaPath(webPath, org, repo) {
  const prefix = `/${org}/${repo}`;
  if (webPath.endsWith('/')) return `${prefix}${webPath}index.html`;
  return kindOf(webPath) === 'page' ? `${prefix}${webPath}.html` : `${prefix}${webPath}`;
}

export function daEditUrl(daPath) {
  if (!daPath) return '';
  const encoded = daPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  if (/\.html$/i.test(daPath)) return `https://da.live/canvas#${encoded.replace(/\.html$/i, '')}`;
  if (/\.json$/i.test(daPath)) return `https://da.live/sheet#${encoded.replace(/\.json$/i, '')}`;
  return `https://da.live/#${encoded.split('/').slice(0, -1).join('/')}`;
}

export function siteUrls(org, repo, ref = 'main') {
  return {
    preview: `https://${ref}--${repo}--${org}.aem.page`,
    live: `https://${ref}--${repo}--${org}.aem.live`,
  };
}

export function indexSource(items, org, repo) {
  const byWebPath = new Map();
  items.forEach((item) => {
    if (!item?.path || !item.ext || isHidden(item.path)) return;
    const webPath = daPathToWebPath(item.path, org, repo);
    if (!webPath) return;
    const existing = byWebPath.get(webPath);
    // Prefer the HTML document if a name collides with another file type.
    if (existing && existing.ext === 'html' && item.ext !== 'html') return;
    byWebPath.set(webPath, { daPath: item.path, ext: item.ext, lastModified: toTime(item.lastModified) });
  });
  return byWebPath;
}

export function classify({ source, preview, live }) {
  if (!source) return 'missing';
  const reference = preview ?? live;
  if (source.lastModified !== null && reference !== null && source.lastModified > reference) return 'edited';
  if (live === null) return 'preview-only';
  if (preview !== null && preview > live) return 'pending';
  return 'synced';
}

// Resources without a preview source date (e.g. redirects) do not come from a DA document.
const hasPreviewSource = (resource) => toTime(resource?.previewSourceLastModified) !== null;

export function compare(resources, sourceItems, { org, repo }) {
  const sources = indexSource(sourceItems, org, repo);
  // Every path EDS knows about, so excluded resources do not reappear as DA-only rows.
  const edsPaths = new Set(resources.map((resource) => normalizeWebPath(resource?.path)));
  const matched = new Set();
  const rows = [];
  resources.forEach((resource) => {
    const webPath = normalizeWebPath(resource?.path);
    if (!webPath || isHidden(webPath) || !hasPreviewSource(resource)) return;
    const preview = toTime(resource.previewLastModified);
    const live = toTime(resource.publishLastModified);
    if (preview === null && live === null) return;
    const source = sources.get(webPath) || null;
    if (source) matched.add(webPath);
    rows.push({
      webPath,
      kind: kindOf(webPath),
      daPath: source?.daPath || '',
      sourceModified: source?.lastModified ?? null,
      preview,
      live,
      previewBy: resource.previewLastModifiedBy || '',
      liveBy: resource.publishLastModifiedBy || '',
      status: classify({ source, preview, live }),
      da: 'loaded',
    });
  });
  sources.forEach((source, webPath) => {
    if (matched.has(webPath) || edsPaths.has(webPath)) return;
    rows.push({
      webPath,
      kind: kindOf(webPath),
      daPath: source.daPath,
      sourceModified: source.lastModified,
      preview: null,
      live: null,
      previewBy: '',
      liveBy: '',
      status: 'unpreviewed',
      da: 'loaded',
    });
  });
  return rows.sort((a, b) => a.webPath.localeCompare(b.webPath));
}

// Builds rows from the EDS status alone. The DA source is filled in later with applySource().
// Until then, the status reflects EDS only (preview-only, pending or synced).
export function edsRows(resources) {
  const rows = [];
  const seen = new Set();
  resources.forEach((resource) => {
    const webPath = normalizeWebPath(resource?.path);
    if (!webPath || isHidden(webPath) || seen.has(webPath) || !hasPreviewSource(resource)) return;
    const preview = toTime(resource.previewLastModified);
    const live = toTime(resource.publishLastModified);
    if (preview === null && live === null) return;
    seen.add(webPath);
    rows.push({
      webPath,
      kind: kindOf(webPath),
      daPath: '',
      sourceModified: null,
      preview,
      live,
      previewBy: resource.previewLastModifiedBy || '',
      liveBy: resource.publishLastModifiedBy || '',
      status: classify({ source: { lastModified: null }, preview, live }),
      da: 'pending',
    });
  });
  return rows.sort((a, b) => a.webPath.localeCompare(b.webPath));
}

// Applies a DA source ({ daPath, lastModified }, or null if it does not exist) to an EDS row.
export function applySource(row, found) {
  const source = found ? { daPath: found.daPath, lastModified: toTime(found.lastModified) } : null;
  return {
    ...row,
    daPath: source?.daPath || '',
    sourceModified: source?.lastModified ?? null,
    status: classify({ source, preview: row.preview, live: row.live }),
    da: 'loaded',
  };
}

// Applies a source API confirmation to a row previously classified as missing.
export function resolveMissing(row, found) {
  return found ? applySource(row, found) : row;
}

export function previewUrls(rows, org, repo) {
  const { preview } = siteUrls(org, repo);
  return rows.map((row) => `${preview}${row.webPath}`).join('\n');
}

export function summarize(rows) {
  const counts = Object.fromEntries(Object.keys(STATUSES).map((key) => [key, 0]));
  rows.forEach((row) => { counts[row.status] += 1; });
  counts.eds = EDS_STATUSES.reduce((total, key) => total + counts[key], 0);
  return counts;
}

export function filterRows(rows, { status = 'eds', search = '' } = {}) {
  const term = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (status === 'eds' ? row.status === 'unpreviewed' : row.status !== status) return false;
    return !term || row.webPath.includes(term) || row.daPath.toLowerCase().includes(term);
  });
}

const STATUS_ORDER = Object.keys(STATUSES);
const SORTERS = {
  path: (a, b) => a.webPath.localeCompare(b.webPath),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  source: (a, b) => (a.sourceModified ?? -Infinity) - (b.sourceModified ?? -Infinity),
  preview: (a, b) => (a.preview ?? -Infinity) - (b.preview ?? -Infinity),
  live: (a, b) => (a.live ?? -Infinity) - (b.live ?? -Infinity),
};

export function sortRows(rows, { key = 'path', direction = 'asc' } = {}) {
  const sorter = SORTERS[key] || SORTERS.path;
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => (sign * sorter(a, b)) || SORTERS.path(a, b));
}

function csvCell(value) {
  const text = String(value ?? '');
  // Neutralize spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows) {
  const iso = (time) => (time === null ? '' : new Date(time).toISOString());
  const header = ['path', 'type', 'status', 'da_source', 'source_modified', 'previewed', 'previewed_by', 'published', 'published_by'];
  const lines = rows.map((row) => [
    row.webPath, row.kind, STATUSES[row.status].label, row.daPath,
    iso(row.sourceModified), iso(row.preview), row.previewBy, iso(row.live), row.liveBy,
  ].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n');
}
