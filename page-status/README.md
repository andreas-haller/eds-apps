# Page Status DA App

A DA app ([audit app guide](https://www.aem.live/docs/ew/developing/micro-frontends/4-build-your-audit-app)) that lists every resource that is previewed or published on Edge Delivery Services (EDS) and compares it to its source document in DA. Like the Workfront plugin, it uses plain HTML, CSS and native JavaScript modules, with no framework, dependencies or build step.

## Install

Copy `page-status.html`, `page-status.js`, `page-status.css`, `api.js`, `model.js`, `source-lookup.js` and `host.js` into your site's code repository at `/tools/page-status/`. Then open:

```text
https://da.live/app/{org}/{site}/tools/page-status/page-status
```

Add `?ref=local` to load the app from `aem up` during development. To list it under `https://da.live/apps#/{org}/{site}`, add a row to the **apps** tab of the site config:

| title | description | path | ref |
| --- | --- | --- | --- |
| Page Status | Compare EDS preview and publish status with DA | `/app/{org}/{site}/tools/page-status/page-status` | |

The app only runs inside DA, but the org and site it audits are independent of where it is hosted. Pass the target in the fragment, the same way other DA views do:

```text
https://da.live/app/{app-org}/{app-site}/tools/page-status/page-status#/{org}/{site}
```

The DA shell passes the fragment to the app (as `context.hash` in the [DA SDK](https://da.live/nx/utils/sdk.js), and on the iframe URL). The target is shown in the **Org** and **Site** inputs in the header, where you can change it and press **Load**. The app always audits the `main` branch. The fragment is the only source of the target; nothing is stored in the browser. Without a fragment, the app waits for you to enter an org and site. The hosting org/site is only used to load the app.

Pressing **Load** writes `#/{org}/{site}` into the `da.live` address bar, so reloading, bookmarking or sharing the URL reopens the same site. The DA app shell ignores the SDK's `setHash`, so the app navigates the top window to the same shell URL with only the fragment changed (`location.replace`, no reload, no extra history entry). It only does this for `*.da.live` (or `localhost`) parents, during the submit gesture. If the browser blocks it, the app shows a notice with the fragment to add manually.

The app reads the IMS token from the DA SDK and sends it only to `admin.hlx.page` and `admin.da.live`. Results reflect the signed-in user's permissions on the target org/site.

## How It Works

Pressing **Load** always starts with the EDS status. How DA details are loaded depends on the **Full DA scan** checkbox in the header.

1. **EDS status**: starts a [bulk status job](https://www.aem.live/docs/admin.html#tag/status/operation/bulkStatus) with `POST /status/{org}/{site}/main/*` and `{ "paths": ["/*"], "select": ["preview", "live"], "forceAsync": true }`. It polls `/job/{org}/{site}/main/status/{job}` until the job state is `stopped`, then reads `data.resources` from `/details`.
2. **DA details, lazy (default)**: every row is shown as soon as the EDS job finishes. Until a row's DA details arrive, it shows a spinner and a provisional status based on EDS data only. DA details load only for rows that scroll into view, with up to 4 lookups at a time. Each DA folder is listed once (`GET https://admin.da.live/list/{org}/{site}/{folder}`, non-recursive) and cached, so the rows of one folder cost a single request. The "Not previewed" status is not available in this mode, because it requires the full DA tree.
3. **DA details, Full DA scan**: in parallel with the EDS job, recursively crawls `https://admin.da.live/list/{org}/{site}`. The table appears once both are done, including DA-only pages ("Not previewed").
4. **Matching**: DA paths are mapped to EDS web paths. Names are lowercased and sanitized, `.html` is dropped, `index.html` becomes the folder path (`/en/index.html` → `/en/`), and other files keep their extension (`/data/products.json`). DA listings follow `da-continuation-token` pagination and skip hidden entries such as `.da` and `.trash`.
5. **Confirmation**: any EDS resource without a listed DA source is checked with a [source API](https://docs.da.live/developers/api/source) `HEAD` request before it is reported as deleted.

EDS resources without a `previewSourceLastModified` value (for example redirects) did not come from a DA document, so they are excluded in both modes, including from counts, selection and exports. A DA document at the same path is not reported as "Not previewed" either, because EDS already knows the path.

Lazy mode assumes that DA folder names map directly to the web folder (for example, `/en/blog/` is listed from `/{org}/{site}/en/blog`). If your DA folder names need sanitizing (uppercase letters, spaces), the `HEAD` fallback can miss the source. Use **Full DA scan** for those sites.

## Statuses

| Status | Rule |
| --- | --- |
| Source deleted | Previewed or published, but no DA source exists |
| Edited since preview | DA `lastModified` is later than the last preview (or publish, if there is no preview) |
| Preview only | Previewed, never published, DA unchanged since the preview |
| Changes not published | Preview is newer than the published version |
| Up to date | Published, preview not newer than live, DA unchanged since the preview |
| Not previewed | Exists in DA only (shown via its own filter, excluded from "On EDS") |

When more than one status applies, the first matching row in the table wins. You can filter by status, search by path and sort by any column. Rows render in pages of 200, and the next page loads automatically as you scroll to the end of the table. In lazy mode, status filters and sorting by DA modification date are only complete for rows whose DA details have loaded. To reload the data, press **Load** again.

Incomplete status counts show a **?**, not a continuously spinning loading icon. Clicking a status card opens that view and loads the remaining DA details in the background, since any unchecked page could belong to that status. The cards show a spinner only while this explicitly requested scan is running; the table remains interactive. If some DA requests fail, counts remain marked **?** and the error is shown.

**Select and copy**: use the row checkboxes, or the checkbox in the table header to select every row in the current view, including rows that are not rendered yet. **Copy URLs** copies the selected pages as a newline-separated list of `https://main--{site}--{org}.aem.page{path}` URLs. Changing the filter or search, or a row's status changing once its DA details load, removes selected rows that are no longer in the view.

**Export CSV** opens a dialog with these options:

- Export the **current view** (filter and search) or **all data**.
- In lazy mode, **load missing DA details first**, so every exported row has its DA source and a final status. Otherwise, rows without DA details are exported with their provisional status and an empty DA source.

## Verification

Node 18 or later. Run this from the repository root:

```sh
node --test page-status/tests/*.test.js
```

The tests cover path mapping, classification, filtering, sorting, CSV escaping, the DA list crawl, single-folder listing, the lazy source lookup and its cache, source confirmation, preview URL generation, and the bulk status job lifecycle. The UI was checked in a browser against mocked SDK and admin API responses. It has not been run against a live site.
