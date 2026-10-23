import { addPageLink, pageKey, taskDraft } from './model.js';

const PAGE_FIELD = 'DE:EW Page Links';
const SITE_FIELD = 'DE:EW Site';
const PROJECT_FIELDS = 'ID,referenceNumber,name,description,status,plannedCompletionDate,parameterValues,notes:noteText,notes:owner:name,notes:entryDate';
const TASK_FIELDS = `${PROJECT_FIELDS},projectID,assignedToID,assignments:assignedToID`;
const PAGE_SIZE = 100;

export class WorkfrontError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WorkfrontError';
    this.status = options.status;
    this.uncertain = options.uncertain || false;
  }
}

function readLinks(raw) {
  const value = raw.parameterValues?.[PAGE_FIELD] ?? raw.parameterValues?.['EW Page Links'];
  if (!value) return [];
  try {
    const links = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(links) || links.some((link) => (
      !pageKey(link) || typeof link.url !== 'string' || !/^https:\/\//.test(link.url)
    ))) throw new Error('Invalid links');
    return [...new Map(links.map((link) => [pageKey(link), link])).values()];
  } catch {
    throw new WorkfrontError(`The page associations on "${raw.name || raw.ID}" are invalid.`);
  }
}

function normalize(raw, type, origin) {
  if (!raw?.ID || typeof raw.name !== 'string') {
    throw new WorkfrontError('Workfront returned an incomplete item.');
  }
  const site = raw.parameterValues?.[SITE_FIELD] ?? raw.parameterValues?.['EW Site'];
  const statuses = { CUR: 'In progress', INP: 'In progress', NEW: 'Not started', PLN: 'Planning', CPL: 'Complete', ONH: 'On hold' };
  return {
    id: raw.ID,
    type,
    reference: raw.referenceNumber ? `${type === 'project' ? 'PRJ' : 'TSK'}-${raw.referenceNumber}` : raw.ID,
    name: raw.name,
    description: raw.description || '',
    url: `${origin}/${type}/${encodeURIComponent(raw.ID)}/overview`,
    status: statuses[raw.status] || raw.status || '',
    dueDate: raw.plannedCompletionDate || null,
    projectId: raw.projectID,
    assigneeIds: [...new Set([raw.assignedToID, ...(raw.assignments || []).map((entry) => entry.assignedToID)].filter(Boolean))],
    siteIds: site ? [site] : [],
    pageLinks: readLinks(raw),
    notes: (raw.notes || []).map((note) => ({
      text: note.noteText || '',
      author: note.owner?.name || '',
      date: note.entryDate || null,
    })),
  };
}

export function createWorkfrontClient({ workfrontOrigin, proxyOrigin, apiVersion = 'v21.0', getToken = () => '', fetchImpl = globalThis.fetch }) {
  let origin;
  try {
    const url = new URL(workfrontOrigin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workfront.com') || url.username || url.password) {
      throw new Error('Invalid origin');
    }
    origin = url.origin;
  } catch {
    throw new WorkfrontError('Configure a valid HTTPS Workfront origin.');
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new WorkfrontError('Configure a supported Workfront API version, such as v21.0.');
  }
  let apiOrigin = origin;
  if (proxyOrigin) {
    try {
      const url = new URL(proxyOrigin);
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error('Invalid proxy');
      apiOrigin = url.origin;
    } catch {
      throw new WorkfrontError('Configure a valid HTTPS Workfront proxy origin.');
    }
  }
  const base = `${apiOrigin}/attask/api/${apiVersion}`;
  const pendingLinks = new Map();

  async function request(resource, parameters = {}, method = 'GET') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const params = new URLSearchParams(parameters);
    const writing = method !== 'GET';
    try {
      const token = getToken();
      if (!token) throw new WorkfrontError('The Experience Workspace Workfront token is unavailable. Reopen the plugin and retry.');
      const response = await fetchImpl(`${base}/${resource}${writing ? '' : `?${params}`}`, {
        method,
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(writing ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
        },
        body: writing ? params : undefined,
      });
      if (response.status === 401) throw new WorkfrontError('Workfront rejected the Experience Workspace token. Check that this token has access to the configured Workfront tenant.', { status: 401 });
      if (response.status === 403) throw new WorkfrontError('You do not have permission to perform this Workfront action.', { status: 403 });
      if (!response.ok) throw new WorkfrontError(`Workfront could not complete the request (${response.status}).`, { status: response.status, uncertain: writing && response.status >= 500 });
      const payload = await response.json();
      if (payload.error) throw new WorkfrontError(payload.error.message || 'Workfront rejected the request.');
      return Object.hasOwn(payload, 'data') ? payload.data : payload;
    } catch (error) {
      if (error instanceof WorkfrontError) throw error;
      throw new WorkfrontError(writing
        ? 'The write could not be confirmed. Check Workfront before trying again.'
        : 'Workfront could not be reached. Check your connection and retry.', { uncertain: writing });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readAll(resource, fields) {
    const records = [];
    const seen = new Set();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const batch = await request(`${resource}/search`, { fields, '$$LIMIT': PAGE_SIZE, '$$FIRST': offset, ID_Sort: 'asc' });
      if (!Array.isArray(batch)) throw new WorkfrontError('Workfront returned an invalid result list.');
      if (batch.length && batch.every((entry) => seen.has(entry.ID))) {
        throw new WorkfrontError('Workfront is not advancing through result pages.');
      }
      batch.forEach((entry) => {
        if (!seen.has(entry.ID)) records.push(entry);
        seen.add(entry.ID);
      });
      if (batch.length < PAGE_SIZE) return records;
    }
  }

  return {
    mode: 'live',
    origin,
    async load() {
      const [currentUser, projects, tasks, users] = await Promise.all([
        request('user/current', { fields: 'ID,name' }),
        readAll('project', PROJECT_FIELDS),
        readAll('task', TASK_FIELDS),
        readAll('user', 'ID,name'),
      ]);
      if (!currentUser?.ID) throw new WorkfrontError('Workfront did not identify the current user.');
      return {
        userId: currentUser.ID,
        projects: projects.map((raw) => normalize(raw, 'project', origin)),
        tasks: tasks.map((raw) => normalize(raw, 'task', origin)),
        users: users.map((user) => ({ id: user.ID, name: user.name })).sort((first, second) => first.name.localeCompare(second.name)),
      };
    },
    linkPage(taskId, page) {
      const key = `${taskId}:${pageKey(page)}`;
      if (pendingLinks.has(key)) return pendingLinks.get(key);
      const operation = (async () => {
        const raw = await request(`task/${encodeURIComponent(taskId)}`, { fields: TASK_FIELDS });
        const latest = normalize(raw, 'task', origin);
        const result = addPageLink(latest, page);
        if (!result.added) return result;
        await request(`task/${encodeURIComponent(taskId)}`, { [PAGE_FIELD]: JSON.stringify(result.item.pageLinks) }, 'PUT');
        return result;
      })().finally(() => pendingLinks.delete(key));
      pendingLinks.set(key, operation);
      return operation;
    },
    async createTask(values, page) {
      const draft = taskDraft(values, page);
      const raw = await request('task', {
        name: draft.name,
        projectID: draft.projectId,
        description: draft.description,
        [PAGE_FIELD]: JSON.stringify(draft.pageLinks),
        fields: TASK_FIELDS,
      }, 'POST');
      try {
        return normalize(raw, 'task', origin);
      } catch {
        throw new WorkfrontError('The task may have been created, but its response was incomplete. Check Workfront before trying again.', { uncertain: true });
      }
    },
  };
}