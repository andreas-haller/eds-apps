export const DA_ADMIN = 'https://admin.da.live';
export const AEM_ADMIN = 'https://admin.hlx.page';

const LIST_CONCURRENCY = 6;
const SOURCE_CONCURRENCY = 4;

export class PageStatusError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PageStatusError';
    this.status = options.status;
  }
}

const encodePath = (path) => path.split('/').map((segment) => encodeURIComponent(segment)).join('/');

async function runPool(initial, concurrency, worker) {
  const pending = [...initial];
  let running = 0;
  let failed = false;
  await new Promise((resolve, reject) => {
    const next = () => {
      if (failed) return;
      if (!pending.length && !running) { resolve(); return; }
      while (running < concurrency && pending.length) {
        const item = pending.shift();
        running += 1;
        Promise.resolve()
          .then(() => worker(item, (more) => pending.push(more)))
          .then(() => { running -= 1; next(); }, (error) => { failed = true; reject(error); });
      }
    };
    next();
  });
}

export function createClient({
  org,
  repo,
  ref = 'main',
  getToken = () => '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  pollInterval = 1500,
  jobTimeout = 10 * 60 * 1000,
  now = () => Date.now(),
}) {
  const validName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-_.]*$/i.test(value);
  if (!validName(org) || !validName(repo) || !validName(ref)) {
    throw new PageStatusError('Open this app from DA so it receives a valid org and site.');
  }

  async function request(url, init = {}, label = 'Request') {
    const token = getToken();
    const headers = { ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(url, { ...init, headers, credentials: 'omit' });
    } catch {
      throw new PageStatusError(`${label} failed: network error.`);
    }
    return response;
  }

  async function failure(response, label) {
    const detail = response.headers?.get?.('x-error');
    const reasons = {
      401: 'you are not signed in, or your session expired. Reload DA and try again.',
      403: 'you do not have permission for this site.',
      404: 'the site was not found.',
      429: 'rate limited by the admin API. Wait a moment and refresh.',
    };
    const reason = reasons[response.status] || `HTTP ${response.status}${detail ? ` (${detail})` : ''}.`;
    return new PageStatusError(`${label} failed: ${reason}`, { status: response.status });
  }

  // Lists the direct children of a DA folder, following continuation tokens. Hidden entries are skipped.
  async function listChildren(path, { missingOk = false } = {}) {
    const children = [];
    let continuation = null;
    do {
      const headers = continuation ? { 'da-continuation-token': continuation } : {};
      // eslint-disable-next-line no-await-in-loop
      const response = await request(`${DA_ADMIN}/list${encodePath(path)}`, { headers }, 'Listing DA content');
      if (missingOk && response.status === 404) return [];
      if (!response.ok) throw await failure(response, 'Listing DA content');
      // eslint-disable-next-line no-await-in-loop
      const page = await response.json();
      if (!Array.isArray(page)) throw new PageStatusError('Listing DA content failed: unexpected response.');
      children.push(...page.filter((child) => child?.name && child.path && !child.name.startsWith('.')));
      continuation = response.headers?.get?.('da-continuation-token') || null;
    } while (continuation);
    return children;
  }

  // Files in a single DA folder (not recursive). A folder that does not exist has no files.
  async function listFolder(path) {
    return (await listChildren(path, { missingOk: true })).filter((child) => child.ext);
  }

  async function listSource(onProgress = () => {}) {
    const files = [];
    let folders = 0;
    await runPool([`/${org}/${repo}`], LIST_CONCURRENCY, async (path, enqueue) => {
      (await listChildren(path)).forEach((child) => {
        if (child.ext) files.push(child);
        else enqueue(child.path);
      });
      folders += 1;
      onProgress({ folders, files: files.length });
    });
    return files;
  }

  // Confirms each path against the DA source API. Resolves to a Map of daPath -> { daPath, lastModified } for found sources.
  async function confirmSources(daPaths, onProgress = () => {}) {
    const found = new Map();
    let checked = 0;
    await runPool(daPaths, SOURCE_CONCURRENCY, async (daPath) => {
      const response = await request(`${DA_ADMIN}/source${encodePath(daPath)}`, { method: 'HEAD' }, 'Checking DA source');
      if (response.ok) {
        found.set(daPath, { daPath, lastModified: response.headers?.get?.('last-modified') || null });
      } else if (response.status !== 404) {
        throw await failure(response, 'Checking DA source');
      }
      checked += 1;
      onProgress({ checked, total: daPaths.length });
    });
    return found;
  }

  async function fetchStatus(onProgress = () => {}) {
    const site = `${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}`;
    const start = await request(`${AEM_ADMIN}/status/${site}/*`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/*'], select: ['preview', 'live'], forceAsync: true }),
    }, 'Starting the EDS status job');
    if (!start.ok) throw await failure(start, 'Starting the EDS status job');
    const created = await start.json();
    const name = created?.job?.name;
    if (!validName(name)) throw new PageStatusError('Starting the EDS status job failed: no job was created.');

    // Build the job URL ourselves so the token is only ever sent to the admin API.
    const jobUrl = `${AEM_ADMIN}/job/${site}/status/${encodeURIComponent(name)}`;
    const startedAt = now();
    let job = created.job;
    while (job?.state !== 'stopped') {
      if (now() - startedAt > jobTimeout) throw new PageStatusError('The EDS status job did not finish in time. Try again later.');
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollInterval);
      // eslint-disable-next-line no-await-in-loop
      const response = await request(jobUrl, {}, 'Reading the EDS status job');
      if (!response.ok) throw await failure(response, 'Reading the EDS status job');
      // eslint-disable-next-line no-await-in-loop
      job = await response.json();
      onProgress({ state: job?.state, ...(job?.progress || {}) });
    }
    if (job.cancelled) throw new PageStatusError('The EDS status job was cancelled.');
    if (job.error) throw new PageStatusError(`The EDS status job failed: ${job.error}`);

    const response = await request(`${jobUrl}/details`, {}, 'Reading EDS status results');
    if (!response.ok) throw await failure(response, 'Reading EDS status results');
    const details = await response.json();
    const resources = details?.data?.resources;
    if (!Array.isArray(resources)) throw new PageStatusError('Reading EDS status results failed: unexpected response.');
    return resources;
  }

  return { listSource, listFolder, confirmSources, fetchStatus };
}
