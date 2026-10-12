export function pageKey(page) {
  if (!page?.siteId || !page?.path) return null;
  const path = page.path.startsWith('/') ? page.path : `/${page.path}`;
  return `${page.siteId}:${path}`;
}

export function isLinkedToPage(item, page) {
  const key = pageKey(page);
  return Boolean(key && item.pageLinks?.some((link) => pageKey(link) === key));
}

function isLinkedToSite(item, siteId) {
  return Boolean(siteId && (
    item.siteIds?.includes(siteId)
    || item.pageLinks?.some((link) => link.siteId === siteId)
  ));
}

export function matchReason(item, scope, context, catalog, selectedUserId) {
  const children = item.type === 'project'
    ? catalog.tasks.filter((task) => task.projectId === item.id)
    : [];

  if (scope === 'all') return 'All Workfront items';

  if (scope === 'page') {
    if (isLinkedToPage(item, context)) return 'Linked to this page';
    const related = children.filter((task) => isLinkedToPage(task, context));
    if (related.length) {
      return `${related.length} task${related.length === 1 ? '' : 's'} linked to this page`;
    }
  }

  if (scope === 'site') {
    if (isLinkedToSite(item, context.siteId)) return 'Linked to this site';
    if (children.some((task) => isLinkedToSite(task, context.siteId))) {
      return 'Contains tasks linked to this site';
    }
    const project = catalog.projects.find((entry) => entry.id === item.projectId);
    if (project && isLinkedToSite(project, context.siteId)) return 'Project linked to this site';
  }

  if (scope === 'me' || scope === 'user') {
    const userId = scope === 'me' ? context.userId : selectedUserId;
    if (!userId) return null;
    const person = scope === 'me'
      ? 'you'
      : catalog.users.find((user) => user.id === userId)?.name || 'selected user';
    if (item.assigneeIds?.includes(userId)) return `Assigned to ${person}`;
    const related = children.filter((task) => task.assigneeIds?.includes(userId));
    if (related.length) {
      return `${related.length} task${related.length === 1 ? '' : 's'} assigned to ${person}`;
    }
    if (item.memberIds?.includes(userId)) return `Project team includes ${person}`;
  }

  return null;
}

export function filterCatalog(catalog, context, scope = 'page', selectedUserId = '', search = '') {
  const query = search.trim().toLowerCase();
  const filter = (items) => items.flatMap((item) => {
    const reason = matchReason(item, scope, context, catalog, selectedUserId);
    if (!reason || (query && !item.name.toLowerCase().includes(query))) return [];
    return [{ ...item, matchReason: reason }];
  });
  return { projects: filter(catalog.projects), tasks: filter(catalog.tasks) };
}

export function addPageLink(item, page) {
  if (!pageKey(page) || !page.url) throw new Error('A current page is required to link a task.');
  if (isLinkedToPage(item, page)) return { item, added: false };
  const pageLinks = [...(item.pageLinks || []), {
    siteId: page.siteId,
    path: page.path.startsWith('/') ? page.path : `/${page.path}`,
    url: page.url,
  }];
  return { item: { ...item, pageLinks }, added: true };
}

export function taskDraft({ name, projectId, description = '' }, page) {
  if (!name?.trim()) throw new Error('Enter a task name.');
  if (!projectId) throw new Error('Select a project.');
  if (!pageKey(page) || !page.url) throw new Error('A current page is required to create a task.');
  const notes = description.trim();
  const task = {
    type: 'task',
    name: name.trim(),
    projectId,
    description: `${notes}${notes ? '\n\n' : ''}Page: ${page.url}`,
    assigneeIds: [],
    notes: [],
    pageLinks: [],
  };
  return addPageLink(task, page).item;
}

export function formatBrief(item, project) {
  const parts = [item.name, item.url];
  if (project && item.type === 'task') parts.push(`Project: ${project.name}`);
  if (item.description?.trim()) parts.push(item.description.trim());
  const notes = (item.notes || []).filter((note) => note.text?.trim());
  if (notes.length) {
    parts.push('Notes');
    notes.forEach((note) => parts.push(`${note.author ? `${note.author}: ` : ''}${note.text.trim()}`));
  }
  return parts.filter(Boolean).join('\n\n');
}