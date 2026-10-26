import { indexSource, webPathToDaPath } from './model.js';

// Resolves the DA source of a single EDS web path on demand.
// Each DA folder is listed once and cached, so the rows of one folder cost a single request.
// Paths that do not match the folder listing are confirmed with a source API HEAD request.
export function createSourceLookup({ client, org, repo }) {
  const folders = new Map();

  function folderIndex(folder) {
    if (!folders.has(folder)) {
      const index = client.listFolder(folder).then((items) => indexSource(items, org, repo));
      // Drop failed listings so a later lookup can retry them.
      index.catch(() => folders.delete(folder));
      folders.set(folder, index);
    }
    return folders.get(folder);
  }

  return async function lookup(webPath) {
    const daPath = webPathToDaPath(webPath, org, repo);
    const index = await folderIndex(daPath.slice(0, daPath.lastIndexOf('/')));
    const listed = index.get(webPath);
    if (listed) return { daPath: listed.daPath, lastModified: listed.lastModified };
    const confirmed = await client.confirmSources([daPath]);
    return confirmed.get(daPath) || null;
  };
}
