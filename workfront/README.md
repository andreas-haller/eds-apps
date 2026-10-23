# Workfront in Experience Workspace

A static Experience Workspace author plugin using HTML, CSS and native JavaScript modules. No framework, dependency installation, bundler or build step. Everything lives in this directory. The package manifest is only for running the optional Node tests.

## Register In EW

Deploy this directory to an HTTPS static host. Add a **Workfront** entry in the site's **library** configuration, pointing to the deployed `workfront/index.html` URL. EW opens that URL in its editor side panel. Use the `local` ref for local development, as described in the [EW author-plugin guide](https://www.aem.live/docs/ew/developing/micro-frontends/2-build-your-basic-plugin). This plugin requires the EW iframe handshake and current page context; opening its URL standalone is unsupported.

The plugin connects through the official [EW/DA SDK](https://da.live/nx/utils/sdk.js):

- The host's `context.org`, `context.repo` and `context.path` identify the current page. Missing context is shown explicitly; no page is inferred from names or URLs.
- Copy to chat calls `actions.setPrompt(text, { autoSend: false })`, then opens the chat panel. It never calls `sendText` or modifies the page content.
- Page context is the SDK snapshot supplied when the plugin opens. Reopen the plugin after changing documents if the host does not reload it.

## Live Connection

Configure [config.js](./config.js) with the Workfront tenant origin and an API version supported by that tenant:

```js
export default Object.freeze({
  workfrontOrigin: 'https://your-tenant.my.workfront.com',
  apiVersion: 'v21.0',
});
```

The plugin calls Workfront directly at `https://your-tenant.my.workfront.com/attask/api/v21.0`. It reads the current IMS token from the EW SDK and sends it as an `Authorization: Bearer` header. The token stays in memory and is refreshed when EW posts an updated token; it is never written to config, storage or logs. This uses the signed-in author's Workfront permissions.

If Workfront does not allow CORS from the plugin origin, deploy the Cloudflare Worker in [cors/](./cors/README.md) and set `proxyOrigin` in `config.js` to its URL. API calls then go through the proxy; record links still use `workfrontOrigin`.

Without a proxy, Workfront must accept direct browser requests from the deployed plugin origin, including CORS preflights for the `Authorization` and `Content-Type` headers and `GET`, `POST` and `PUT` methods. The host-provided token must be valid for the configured Workfront tenant and authorized for its API. If Workfront rejects it with 401, verify the token's audience and tenant access; do not put a Workfront secret in this app or fall back to a shared account.

The client calls these native Workfront API resources:

| Route | Method | Response or behavior |
| --- | --- | --- |
| `/user/current` | GET | Current signed-in Workfront user |
| `/project/search` | GET | Accessible projects |
| `/task/search` | GET | Accessible tasks |
| `/user/search` | GET | Accessible users, with `ID` and `name` |
| `/task/{id}` | GET | Fresh task, including custom fields |
| `/task/{id}` | PUT | Update only `DE:EW Page Links` |
| `/task` | POST | Create a task with `name`, `projectID`, `description` and `DE:EW Page Links` |

Searches use the native `fields`, `$$LIMIT`, `$$FIRST` and `ID_Sort` parameters and paginate through all accessible results. `POST` and `PUT` use URL-encoded Workfront API parameters. Workfront API errors and permissions are handled in the panel.

### Explicit Associations

The MVP uses two fixed Workfront text custom fields; there is no matching configuration UI:

- **EW Site** (`DE:EW Site`): an exact `org/repo` identifier on a project or task.
- **EW Page Links** (`DE:EW Page Links`): a JSON array of explicit page associations on a project or task.

```json
[
  {
    "siteId": "northstar/website",
    "path": "/collections/fall.html",
    "url": "https://da.live/edit#/northstar/website/collections/fall.html"
  }
]
```

Keep the exact document path provided by EW, including any extension. Attach the association custom form to the relevant records.

The client rereads a task before linking, suppresses repeated clicks and treats an existing association as a no-op. It preserves existing page links and never automatically retries an uncertain write. Unconfirmed task creation disables resubmission until the dialog is reopened after checking Workfront.

### Matching Rules

- **This page** (default): an exact page association. A project also matches when one of its tasks is linked to the page.
- **This site**: an explicit site association or a page association within that site. Tasks can inherit their project's explicit site association; projects can match through explicitly associated tasks.
- **Assigned to me / selected user**: exact Workfront assignee IDs, with parent projects of matching tasks.
- **All**: all accessible projects and tasks returned by Workfront.
- Search only narrows the chosen context by name; it never establishes relevance.

Every result states why it matched. Status is read-only. Issues, reassignment, status changes, approvals and fuzzy matching are not implemented.

## Verification

Node 18 or later, from the repository root:

```sh
node --test workfront/tests/*.test.js
```

Or run `npm test` inside this directory. No `npm install` is needed. The tests cover explicit matching, duplicate links, task drafts, chat payloads, host context, pagination, permissions and uncertain writes.

Browser-verified embedded workflows include the official SDK MessagePort handshake, current-page context, mocked direct Workfront API responses, in-panel task details, and chat-composer insertion at a 390-pixel panel width. Unit tests verify direct request URLs, refreshed bearer tokens, link and task-creation requests. Real tenant authentication and writes have not been exercised against a live account.

## Assets

- The locally hosted **Instrument Sans** font uses the [SIL Open Font License](./assets/font-OFL.txt).
- The pinned **Lucide 0.468.0** browser icon library uses its [ISC/MIT licenses](./assets/lucide-LICENSE.txt). It is an icon utility, not a UI framework.
