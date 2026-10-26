import { createClient } from './api.js';
import { connectToHost, parseTargetHash } from './host.js';
import {
  STATUSES, EDS_STATUSES, applySource, compare, daEditUrl, edsRows, filterRows, previewUrls,
  resolveMissing, siteUrls, sortRows, summarize, toCsv, webPathToDaPath,
} from './model.js';
import { createSourceLookup } from './source-lookup.js';

const PAGE_SIZE = 200;
const DA_CONCURRENCY = 4;
const NAME = /^[a-z0-9][a-z0-9-_.]*$/i;
const find = (selector) => document.querySelector(selector);
const state = {
  getToken: null,
  setHash: null,
  client: null,
  context: null,
  // 'lazy': EDS status first, DA details on demand. 'full': everything up front.
  mode: 'lazy',
  rows: [],
  rowIndex: new Map(),
  // Rows of the current view (filtered, searched, sorted), including rows not rendered yet.
  view: [],
  rowElements: new Map(),
  selected: new Set(),
  lazy: null,
  loading: false,
  exporting: false,
  loadedAt: null,
  filter: 'eds',
  search: '',
  sort: { key: 'path', direction: 'asc' },
  limit: PAGE_SIZE,
};

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const SPINNER = '<span class="spinner" aria-hidden="true"></span>';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function formatAgo(time) {
  const seconds = Math.round((time - Date.now()) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) || ['second', 1];
  return relative.format(Math.round(seconds / size), unit);
}

function renderDate(time, by, empty) {
  if (time === null) return `<span class="muted">${escape(empty)}</span>`;
  const title = `${absolute.format(time)}${by ? ` by ${by}` : ''}`;
  return `<time datetime="${new Date(time).toISOString()}" title="${escape(title)}">${escape(formatAgo(time))}</time>`;
}

function setProgress(text) {
  find('#progress').textContent = text;
}

function setError(message) {
  const el = find('#error');
  el.textContent = message || '';
  el.hidden = !message;
}

const daPending = (row) => row.da === 'pending' || row.da === 'loading';
const countPending = (rows) => rows.reduce((total, row) => total + (daPending(row) ? 1 : 0), 0);

/* Summary and progress */

function renderSummary() {
  const counts = summarize(state.rows);
  const pending = state.mode === 'lazy' && state.rows.some((row) => row.da !== 'loaded');
  const cards = [
    ['eds', 'On EDS', 'All previewed or published resources', counts.eds],
    ...EDS_STATUSES.map((key) => [key, STATUSES[key].label, STATUSES[key].description, counts[key]]),
  ];
  // Pages that exist only in DA are only known after a full DA scan.
  if (state.mode === 'full') cards.push(['unpreviewed', STATUSES.unpreviewed.label, STATUSES.unpreviewed.description, counts.unpreviewed]);
  find('#summary').innerHTML = cards.map(([key, label, description, count]) => {
    const partial = pending && key !== 'eds';
    const title = partial ? `${description}. Count is incomplete. Click to open this view and load remaining DA details.` : description;
    const indicator = partial && !state.loading
      ? (state.lazy?.summaryLoading ? SPINNER : '<span aria-label="Incomplete count"> ?</span>')
      : '';
    return `
    <button type="button" class="card status-${key}" data-filter="${key}" aria-pressed="${state.filter === key}" title="${escape(title)}" ${state.loading ? 'disabled' : ''}>
      <span class="card-count">${state.loading ? '–' : count}${indicator}</span>
      <span class="card-label">${escape(label)}</span>
    </button>`;
  }).join('');
}

function renderStatusLine() {
  if (state.loading || state.exporting || !state.loadedAt) return;
  const checked = `Last checked ${absolute.format(state.loadedAt)}`;
  if (state.mode === 'full') { setProgress(checked); return; }
  const pending = countPending(state.rows);
  const loaded = state.rows.length - pending;
  setProgress(pending
    ? `${checked} · DA details for ${loaded} of ${state.rows.length} pages, more load as you scroll`
    : `${checked} · DA details for all ${state.rows.length} pages`);
}

let updateScheduled = false;
// Batches updates while many DA details arrive. Loaded details can change a row's status or
// DA dates, so the filtered and sorted view is recomputed and the selection pruned to match it.
function scheduleUpdate() {
  if (updateScheduled) return;
  updateScheduled = true;
  requestAnimationFrame(() => {
    updateScheduled = false;
    if (state.loading) return;
    const before = state.view;
    computeView();
    const changed = before.length !== state.view.length
      || state.view.some((row, index) => row !== before[index]);
    pruneSelection();
    renderSummary();
    if (changed) renderTable();
    else renderSelection();
    renderStatusLine();
  });
}

/* Table */

function renderCells(row) {
  const { org, repo } = state.context;
  const urls = siteUrls(org, repo);
  const status = STATUSES[row.status];
  const onEds = row.status !== 'unpreviewed';
  const daLoading = daPending(row);
  const links = [
    row.daPath ? `<a href="${escape(daEditUrl(row.daPath))}" target="_blank" rel="noopener noreferrer">Edit</a>` : '',
    onEds && row.preview !== null ? `<a href="${escape(urls.preview + row.webPath)}" target="_blank" rel="noopener noreferrer">Preview</a>` : '',
    onEds && row.live !== null ? `<a href="${escape(urls.live + row.webPath)}" target="_blank" rel="noopener noreferrer">Live</a>` : '',
  ].filter(Boolean).join('');
  let source;
  if (daLoading) source = `<span class="da-path">${SPINNER} Loading DA details…</span>`;
  else if (row.da === 'error') source = '<span class="da-path missing">DA details unavailable</span>';
  else if (row.daPath) source = `<span class="da-path">${escape(row.daPath.slice(`/${org}/${repo}`.length))}</span>`;
  else source = '<span class="da-path missing">No DA source</span>';
  let modified;
  if (daLoading) modified = `<span class="muted" title="Loading DA details">${SPINNER}</span>`;
  else if (row.da === 'error') modified = '<span class="muted">—</span>';
  else modified = renderDate(row.sourceModified, '', row.daPath ? 'Unknown' : '—');
  const provisional = row.da !== 'loaded';
  const badgeTitle = provisional ? `${status.description}. Based on EDS only; DA details are not loaded yet.` : status.description;
  return `
    <td class="select"><input type="checkbox" data-select aria-label="Select ${escape(row.webPath)}" ${state.selected.has(row.webPath) ? 'checked' : ''}></td>
    <td class="path"><span class="web-path">${escape(row.webPath)}</span>${row.kind === 'page' ? '' : `<span class="kind">${escape(row.kind)}</span>`}${source}</td>
    <td><span class="badge status-${row.status}" title="${escape(badgeTitle)}">${escape(status.label)}${daLoading ? SPINNER : ''}</span></td>
    <td>${modified}</td>
    <td>${renderDate(row.preview, row.previewBy, 'Not previewed')}</td>
    <td>${renderDate(row.live, row.liveBy, 'Not published')}</td>
    <td><span class="links">${links}</span></td>`;
}

const rowClass = (row) => (state.selected.has(row.webPath) ? 'selected' : '');

// Replaces a rendered row in place. scheduleUpdate() then moves it if its new status changes the view.
function updateRowElement(row) {
  const tr = state.rowElements.get(row.webPath);
  if (!tr) return;
  tr.innerHTML = renderCells(row);
  tr.className = rowClass(row);
}

// Loads DA details for rows as they scroll into view (lazy mode only).
const rowObserver = new IntersectionObserver((entries) => {
  const { lazy } = state;
  if (!lazy) return;
  entries.forEach(({ target, isIntersecting }) => {
    const { path } = target.dataset;
    if (isIntersecting) {
      lazy.visible.add(path);
      enqueue(lazy, path, { front: true });
    } else {
      lazy.visible.delete(path);
    }
  });
  pump(lazy);
}, { rootMargin: '200px 0px' });

// Renders the next page when the sentinel below the table scrolls into view.
const moreObserver = new IntersectionObserver((entries) => {
  if (!entries.some((entry) => entry.isIntersecting) || state.loading) return;
  state.limit += PAGE_SIZE;
  renderTable();
}, { rootMargin: '400px 0px' });

// Re-observing re-runs the intersection check, so pages keep loading while the sentinel stays in view.
function watchMore() {
  const sentinel = find('#more');
  moreObserver.unobserve(sentinel);
  if (!sentinel.hidden) moreObserver.observe(sentinel);
}

function computeView() {
  state.view = sortRows(filterRows(state.rows, { status: state.filter, search: state.search }), state.sort);
}

// Keeps the selection limited to the current view, so copying only includes rows you can see.
function pruneSelection() {
  const inView = new Set(state.view.map((row) => row.webPath));
  state.selected = new Set([...state.selected].filter((path) => inView.has(path)));
}

function renderSelection() {
  const total = state.view.length;
  const selected = state.view.reduce((count, row) => count + (state.selected.has(row.webPath) ? 1 : 0), 0);
  const all = find('#select-all');
  all.checked = total > 0 && selected === total;
  all.indeterminate = selected > 0 && selected < total;
  all.disabled = state.loading || !total;
  const copy = find('#copy');
  if (copy.dataset.feedback) return;
  copy.disabled = state.loading || !selected;
  copy.textContent = selected ? `Copy ${plural(selected, 'URL')}` : 'Copy URLs';
}

function renderTable() {
  computeView();
  const shown = state.view.slice(0, state.limit);
  find('#table').hidden = state.loading || !state.context;
  rowObserver.disconnect();
  state.lazy?.visible.clear();
  state.rowElements = new Map();
  const body = find('#rows');
  if (shown.length) {
    body.innerHTML = shown.map((row) => `<tr data-path="${escape(row.webPath)}" class="${rowClass(row)}">${renderCells(row)}</tr>`).join('');
    body.querySelectorAll('tr').forEach((tr) => {
      state.rowElements.set(tr.dataset.path, tr);
      if (state.lazy && state.rowIndex.get(tr.dataset.path)?.da === 'pending') rowObserver.observe(tr);
    });
  } else {
    body.innerHTML = '<tr><td colspan="7" class="empty">No matching resources.</td></tr>';
  }
  find('#more').hidden = state.view.length <= shown.length;
  find('#more').textContent = `Loading more… (${state.view.length - shown.length} remaining)`;
  watchMore();
  find('#result-count').textContent = state.loading ? '' : `${state.view.length} of ${state.rows.length} resources`;
  document.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sort.key;
    const sort = state.sort.direction === 'asc' ? 'ascending' : 'descending';
    button.closest('th').setAttribute('aria-sort', active ? sort : 'none');
  });
  renderSelection();
}

function render() {
  const busy = state.loading || state.exporting;
  find('#export').disabled = busy || !state.rows.length;
  find('#search').disabled = state.loading || !state.client;
  find('#target').querySelectorAll('input, button').forEach((el) => { el.disabled = busy || !state.getToken; });
  renderSummary();
  renderTable();
}

/* Lazy DA details */

function createLazy(lookup) {
  return {
    lookup,
    // LIFO, so the rows that most recently scrolled into view load first.
    queue: [],
    queued: new Set(),
    visible: new Set(),
    // Rows that must load even when off screen (e.g. before an export).
    forced: new Set(),
    running: 0,
    summaryLoading: false,
    failed: false,
    waiters: new Set(),
  };
}

function enqueue(lazy, path, { front = false } = {}) {
  if (lazy.queued.has(path) || state.rowIndex.get(path)?.da !== 'pending') return;
  lazy.queued.add(path);
  if (front) lazy.queue.push(path);
  else lazy.queue.unshift(path);
}

function settleWaiters(lazy) {
  lazy.waiters.forEach((waiter) => waiter());
}

async function resolveRow(lazy, row) {
  lazy.running += 1;
  Object.assign(row, { da: 'loading' });
  updateRowElement(row);
  try {
    const found = await lazy.lookup(row.webPath);
    if (lazy !== state.lazy) return;
    Object.assign(row, applySource(row, found));
  } catch (error) {
    if (lazy !== state.lazy) return;
    Object.assign(row, { da: 'error' });
    if (!lazy.failed) {
      lazy.failed = true;
      setError(`${error.message || 'Loading DA details failed.'} Some pages show no DA details. Press Load to try again.`);
    }
  } finally {
    lazy.running -= 1;
    lazy.forced.delete(row.webPath);
    if (lazy === state.lazy) {
      updateRowElement(row);
      scheduleUpdate();
      pump(lazy);
      settleWaiters(lazy);
    }
  }
}

function pump(lazy) {
  if (lazy !== state.lazy) return;
  while (lazy.running < DA_CONCURRENCY && lazy.queue.length) {
    const path = lazy.queue.pop();
    lazy.queued.delete(path);
    const row = state.rowIndex.get(path);
    // Skip rows that scrolled out of view before their turn; they are queued again when visible.
    if (row?.da === 'pending' && (lazy.visible.has(path) || lazy.forced.has(path))) resolveRow(lazy, row);
  }
}

// Loads DA details for the given rows, whether they are rendered or not.
function loadDaDetails(rows, onProgress) {
  const { lazy } = state;
  const targets = rows.filter(daPending);
  if (!lazy || !targets.length) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (lazy !== state.lazy) { lazy.waiters.delete(check); resolve(); return; }
      const pending = countPending(targets);
      onProgress(targets.length - pending, targets.length);
      if (!pending) { lazy.waiters.delete(check); resolve(); }
    };
    lazy.waiters.add(check);
    targets.forEach((row) => {
      if (row.da !== 'pending') return;
      lazy.forced.add(row.webPath);
      // Behind visible rows, so scrolling stays responsive during an export.
      enqueue(lazy, row.webPath);
    });
    pump(lazy);
    check();
  });
}

async function loadSummaryDetails() {
  const { lazy } = state;
  if (!lazy || lazy.summaryLoading || !countPending(state.rows)) return;
  lazy.summaryLoading = true;
  renderSummary();
  try {
    // Any unchecked EDS row can move into this status, so all rows must be classified.
    await loadDaDetails(state.rows, () => {});
  } finally {
    lazy.summaryLoading = false;
    if (lazy === state.lazy) scheduleUpdate();
  }
}

/* Loading */

function setRows(rows) {
  state.rows = rows;
  state.rowIndex = new Map(rows.map((row) => [row.webPath, row]));
}

async function loadFull() {
  const progress = { da: 'starting', eds: 'starting' };
  const showProgress = () => setProgress(`DA source: ${progress.da} · EDS status: ${progress.eds}`);
  showProgress();
  const [sourceItems, resources] = await Promise.all([
    state.client.listSource(({ folders, files }) => {
      progress.da = `${files} files in ${folders} folders`;
      showProgress();
    }).then((files) => {
      progress.da = `${files.length} files listed`;
      showProgress();
      return files;
    }),
    state.client.fetchStatus(({ state: jobState, processed, total }) => {
      progress.eds = total ? `${jobState || 'running'} ${processed || 0}/${total}` : (jobState || 'running');
      showProgress();
    }),
  ]);
  const { org, repo } = state.context;
  let rows = compare(resources, sourceItems, { org, repo });
  const missing = rows.filter((row) => row.status === 'missing');
  if (missing.length) {
    setProgress(`Confirming ${missing.length} missing sources with the DA source API…`);
    const candidates = missing.map((row) => webPathToDaPath(row.webPath, org, repo));
    const found = await state.client.confirmSources(candidates, ({ checked, total }) => {
      setProgress(`Confirming missing sources with the DA source API… ${checked}/${total}`);
    });
    rows = rows.map((row) => (row.status === 'missing'
      ? resolveMissing(row, found.get(webPathToDaPath(row.webPath, org, repo)))
      : row));
  }
  return rows;
}

async function loadLazy() {
  setProgress('EDS status: starting');
  const resources = await state.client.fetchStatus(({ state: jobState, processed, total }) => {
    setProgress(`EDS status: ${total ? `${jobState || 'running'} ${processed || 0}/${total}` : (jobState || 'running')}`);
  });
  return edsRows(resources);
}

async function load() {
  if (!state.client || state.loading) return;
  state.loading = true;
  state.mode = find('#target').elements.fullScan.checked ? 'full' : 'lazy';
  state.lazy = null;
  state.loadedAt = null;
  state.selected = new Set();
  setRows([]);
  setError('');
  render();
  try {
    const rows = state.mode === 'full' ? await loadFull() : await loadLazy();
    setRows(rows);
    if (state.mode === 'lazy') {
      const { org, repo } = state.context;
      state.lazy = createLazy(createSourceLookup({ client: state.client, org, repo }));
    }
    state.loadedAt = Date.now();
  } catch (error) {
    setProgress('');
    setError(error.message || 'Loading page status failed.');
  } finally {
    state.loading = false;
    state.limit = PAGE_SIZE;
    render();
    renderStatusLine();
  }
}

/* Copy and export */

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for frames without the clipboard-write permission.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

async function copySelected() {
  // A DA result may have arrived since the last frame, so bring the view up to date first.
  computeView();
  pruneSelection();
  const rows = state.view.filter((row) => state.selected.has(row.webPath));
  if (!rows.length) return;
  const { org, repo } = state.context;
  const copied = await writeClipboard(previewUrls(rows, org, repo));
  const button = find('#copy');
  button.dataset.feedback = 'true';
  button.textContent = copied ? `Copied ${plural(rows.length, 'URL')}` : 'Copy failed';
  setTimeout(() => {
    delete button.dataset.feedback;
    renderSelection();
  }, 2000);
}

function download(rows, scope) {
  const { org, repo } = state.context;
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `page-status-${org}-${repo}-${scope === 'all' ? 'all' : state.filter}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Rows whose DA details can change membership of the current view: a status filter only
// becomes complete once every row that matches the search has its DA details.
function exportCandidates(scope) {
  return scope === 'all' ? state.rows : filterRows(state.rows, { status: 'eds', search: state.search });
}

function updateExportDialog() {
  const form = find('#export-dialog form');
  const scope = form.elements.scope.value;
  form.querySelector('[data-count="view"]').textContent = `(${plural(state.view.length, 'row')})`;
  form.querySelector('[data-count="all"]').textContent = `(${plural(state.rows.length, 'row')})`;
  const pending = state.mode === 'lazy' ? countPending(exportCandidates(scope)) : 0;
  find('#export-da').hidden = !pending;
  form.querySelector('[data-count="pending"]').textContent = `(${plural(pending, 'page')} without DA details)`;
}

function openExportDialog() {
  updateExportDialog();
  const dialog = find('#export-dialog');
  // Escape keeps the previous returnValue, so reset it to avoid repeating the last export.
  dialog.returnValue = '';
  dialog.showModal();
}

async function runExport(scope, loadDa) {
  if (loadDa && state.mode === 'lazy') {
    state.exporting = true;
    render();
    await loadDaDetails(exportCandidates(scope), (done, total) => {
      setProgress(`Loading DA details for the export… ${done}/${total}`);
    });
    state.exporting = false;
    render();
    renderStatusLine();
  }
  // Statuses may have changed since the view was last computed, so re-apply the filter first.
  computeView();
  pruneSelection();
  download(scope === 'all' ? sortRows(state.rows, state.sort) : state.view, scope);
}

/* Target */

function readTarget(hash) {
  const { org = '', repo = '' } = parseTargetHash(hash) || {};
  return { org, repo };
}

// Must run synchronously in the submit handler: browsers only allow navigating the top window during a user gesture.
function writeHash({ org, repo }) {
  const hash = `#/${org}/${repo}`;
  if (window.location.hash !== hash) history.replaceState(null, '', hash);
  return state.setHash?.(hash) !== false;
}

function writeTarget({ org, repo }) {
  const form = find('#target');
  form.elements.org.value = org;
  form.elements.site.value = repo;
}

async function selectTarget(target, { updateUrl = false } = {}) {
  const urlUpdated = updateUrl ? writeHash(target) : true;
  state.context = target;
  state.client = createClient({ ...target, getToken: state.getToken });
  state.filter = 'eds';
  find('#site').textContent = `${target.org} / ${target.repo}`;
  await load();
  if (!urlUpdated && !find('#error').textContent) {
    setError(`Could not update the DA address bar. To reopen this site, add #/${target.org}/${target.repo} to the app URL.`);
  }
}

function changeView(update) {
  update();
  state.limit = PAGE_SIZE;
  computeView();
  pruneSelection();
}

function bindEvents() {
  find('#target').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.loading || state.exporting) return;
    const { elements } = event.target;
    const target = { org: elements.org.value.trim(), repo: elements.site.value.trim() };
    if (![target.org, target.repo].every((value) => NAME.test(value))) {
      setError('Enter a valid org and site.');
      return;
    }
    selectTarget(target, { updateUrl: true });
  });
  find('#export').addEventListener('click', openExportDialog);
  find('#export-dialog form').addEventListener('change', updateExportDialog);
  find('#export-dialog').addEventListener('close', () => {
    const dialog = find('#export-dialog');
    if (dialog.returnValue !== 'export') return;
    const { elements } = dialog.querySelector('form');
    runExport(elements.scope.value, !find('#export-da').hidden && elements.loadDa.checked);
  });
  find('#copy').addEventListener('click', copySelected);
  find('#search').addEventListener('input', (event) => {
    changeView(() => { state.search = event.target.value; });
    renderTable();
  });
  find('#summary').addEventListener('click', (event) => {
    const card = event.target.closest('[data-filter]');
    if (!card) return;
    changeView(() => { state.filter = card.dataset.filter; });
    render();
    if (state.filter !== 'eds') loadSummaryDetails();
  });
  find('#table thead').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    const { key } = button.dataset;
    const direction = state.sort.key === key && state.sort.direction === 'asc' ? 'desc' : 'asc';
    state.sort = { key, direction };
    renderTable();
  });
  // Selects or clears every row of the current view, including rows that are not rendered yet.
  find('#select-all').addEventListener('change', (event) => {
    const { checked } = event.target;
    computeView();
    state.view.forEach((row) => {
      if (checked) state.selected.add(row.webPath);
      else state.selected.delete(row.webPath);
    });
    state.rowElements.forEach((tr, path) => {
      tr.querySelector('[data-select]').checked = checked;
      tr.className = rowClass(state.rowIndex.get(path));
    });
    renderSelection();
  });
  find('#rows').addEventListener('change', (event) => {
    if (!event.target.matches('[data-select]')) return;
    const tr = event.target.closest('tr');
    const { path } = tr.dataset;
    if (event.target.checked) state.selected.add(path);
    else state.selected.delete(path);
    tr.className = rowClass(state.rowIndex.get(path));
    renderSelection();
  });
}

(async function init() {
  let hostHash = '';
  bindEvents();
  render();
  try {
    const host = await connectToHost();
    if (!host.embedded) {
      throw new Error('Open this app from DA: https://da.live/app/{org}/{site}/tools/page-status/page-status');
    }
    state.getToken = host.getToken;
    state.setHash = host.setHash;
    hostHash = host.hash;
  } catch (error) {
    find('#site').textContent = 'Not connected';
    setError(error.message);
    render();
    return;
  }
  const target = readTarget(hostHash);
  writeTarget(target);
  if (target.org && target.repo) {
    await selectTarget(target);
  } else {
    find('#site').textContent = 'Enter the org and site to audit';
    render();
    find('#target').elements.org.focus();
  }
}());
