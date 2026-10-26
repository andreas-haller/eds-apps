const embedded = typeof window !== 'undefined' && window.self !== window.top;
const connection = embedded ? import('https://da.live/nx/utils/sdk.js').then((module) => module.default) : null;
if (connection) connection.catch(() => {});
let currentToken = '';
let watchingForRefresh = false;

export function normalizeContext(context = {}) {
  const { org, repo } = context || {};
  if (typeof org !== 'string' || typeof repo !== 'string' || !org || !repo) return null;
  return { org, repo };
}

const NAME = /^[a-z0-9][a-z0-9-_.]*$/i;

// Parses a DA-style fragment (`#/org/site`, optionally with more segments) into the audit target.
export function parseTargetHash(hash) {
  if (typeof hash !== 'string') return null;
  const [org, repo] = hash.replace(/^#/, '').split('/').filter(Boolean);
  if (!NAME.test(org || '') || !NAME.test(repo || '')) return null;
  return { org, repo };
}

const TRUSTED_HOST = /^(?:[a-z0-9-]+\.)*da\.live$|^localhost$/i;

// Rebuilds the DA shell URL (https://da.live/app/{org}/{site}/{path}{search}) with a new fragment.
export function shellUrl(origin, context, hash) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (!TRUSTED_HOST.test(url.hostname)) return null;
  const { org, repo, path, search = '' } = context || {};
  if (![org, repo, path].every((value) => typeof value === 'string' && value)) return null;
  return `${url.origin}/app/${org}/${repo}/${path}${search}${hash}`;
}

function parentOrigin() {
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  try { return new URL(document.referrer).origin; } catch { return ''; }
}

export async function connectToHost() {
  if (!embedded) return { embedded: false, context: null };
  let timer;
  try {
    const sdk = await Promise.race([
      connection,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DA did not connect to the app. Reload the app and retry.')), 8000);
      }),
    ]);
    currentToken = typeof sdk.token === 'string' ? sdk.token : '';
    if (!watchingForRefresh) {
      window.addEventListener('message', (event) => {
        if (event.source === window.parent && typeof event.data?.token === 'string') {
          currentToken = event.data.token;
        }
      });
      watchingForRefresh = true;
    }
    return {
      embedded: true,
      context: normalizeContext(sdk.context),
      // The DA shell passes the outer URL fragment in context.hash and also appends it to the iframe URL.
      hash: sdk.context?.hash || window.location.hash,
      // The DA app shell ignores the SDK's setHash, so navigate the top window to the same URL with
      // only the fragment changed. That is a same-document navigation; replace() keeps history clean.
      // Browsers only allow it during a user gesture, so call it from an event handler.
      setHash: (hash) => {
        const url = shellUrl(parentOrigin(), sdk.context, hash);
        if (!url) return false;
        try { window.top.location.replace(url); return true; } catch { return false; }
      },
      getToken: () => currentToken,
    };
  } finally {
    clearTimeout(timer);
  }
}
