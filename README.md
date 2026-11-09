# PagePatch

Conversational editing for Chrome. Click a section of a page, describe a change, and preview it in the current tab. Follow up to refine it. When it looks right, PagePatch finds the source in your GitHub repo, shows you a diff, and opens a draft pull request after you approve it.

- **Preview** works on any `http(s)` page, including `localhost`, with no GitHub connection.
- **Source patches** support React and static HTML/CSS projects.
- **Bring your own key** for OpenAI or Anthropic.

## How it works

```
extension (side panel + picker)  ──HTTPS──▶  PagePatch API (Render)  ──▶  OpenAI / Anthropic
                                                    │
                                                    ├──▶ GitHub (GitHub App, user token)
                                                    └──▶ Postgres (short-lived patch proposals)
```

1. Clicking the toolbar button grants access to the current tab only (`activeTab`) and opens the picker. Press <kbd>↑</kbd> to grow the selection to a parent section and <kbd>Esc</kbd> to cancel.
2. The side panel sends a simplified copy of the selection (tags, classes, visible text, link paths) plus your message. The model replies with **preview operations**: set text, set styles, set attributes, insert, remove, or move.
3. Both the API and the extension validate every operation independently. Operations can only target elements inside the selection, use an allowlist of HTML tags, attributes, and CSS properties, and never carry scripts, event handlers, `url()`, or `javascript:` links. Changes are built on a detached copy and only shown if every operation succeeds.
4. The original element stays in the page (hidden) while a preview is shown, so React and other frameworks keep working. Undo, Reset, and navigation restore it. If the page replaces the element, PagePatch asks you to select it again.
5. **Generate source patch** searches a bounded snapshot of the chosen branch (up to 3,000 eligible files, skipping build output) for the visible text and class names, sends at most 5 matching files to the model, and asks it for exact search-and-replace edits. Edits that don't match the file exactly once are rejected. If the match is ambiguous, you choose the file.
6. **Create draft PR** rechecks your access and the base commit, then commits the reviewed diff to a new `pagepatch/…` branch and opens a draft PR. If the base branch moved, PagePatch regenerates the diff and asks you to review it again. It never writes to the base branch and never merges.

The diff is a proposed translation of the preview. PagePatch doesn't build or run your repository, so verify the PR locally.

## Repository layout

| Path | What |
| --- | --- |
| `extension/` | Manifest V3 extension: `background.ts` (toolbar), `content.ts` (picker + preview), `sidepanel.ts` (UI) |
| `api/` | Hono API: provider proxy, GitHub search/diff/PR, Postgres proposals |
| `shared/` | Preview operation allowlists, validators, and JSON schemas used by both sides |
| `fixtures/` | Demo pages: `static/` (HTML/CSS) and `react/` (React 18) |
| `docs/` | Privacy policy and Chrome Web Store materials |

## Local development

Requirements: Node 22, pnpm 10, Docker (for Postgres).

```bash
pnpm install
docker run -d --rm --name pagepatch-pg -e POSTGRES_PASSWORD=pp -e POSTGRES_DB=pagepatch -p 54329:5432 postgres:16-alpine
```

Run the API:

```bash
cd api
DATABASE_URL=postgres://postgres:pp@localhost:54329/pagepatch \
ALLOWED_EXTENSION_IDS=<your unpacked extension id> \
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
pnpm dev
```

Build and load the extension:

```bash
PAGEPATCH_API=http://localhost:8787 GH_CLIENT_ID=... GH_APP_SLUG=... pnpm --filter @pagepatch/extension build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `extension/dist`. Copy the extension id into `ALLOWED_EXTENSION_IDS`.

Try it on the fixtures:

```bash
pnpm --filter @pagepatch/fixture-react build
npx serve fixtures/react/dist   # or fixtures/static
```

### Tests

```bash
pnpm typecheck
pnpm --filter @pagepatch/shared test        # validator: allowlists, unsafe output
DATABASE_URL=postgres://postgres:pp@localhost:54329/pagepatch pnpm --filter @pagepatch/api test
pnpm --filter @pagepatch/fixture-react build && pnpm --filter @pagepatch/extension test   # Chromium E2E
```

The E2E suite loads the real extension in Chromium against both fixtures with a scripted API mock. It covers selecting a section, changing copy and layout, adding, removing, and reordering children, follow-ups, undo and reset, unsafe model output, snapshot privacy, navigation, stale selections after a React re-render, ambiguous file matches, an advanced base branch, and draft PR creation. The API suite runs against real Postgres with GitHub and both providers mocked. It covers structured output requests for each provider, malformed responses, denied access, proposal ownership, retries that reuse the branch, and log hygiene.

## GitHub App setup

Create the app at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Callback URL**: `https://<extension-id>.chromiumapp.org/`
- **Request user authorization (OAuth) during installation**: off (users sign in from the side panel)
- **Webhook**: inactive
- **Repository permissions**: Contents: *Read and write*, Pull requests: *Read and write*, Metadata: *Read-only*
- **Where can this GitHub App be installed?**: Any account

Use the app's **Client ID** and a generated **client secret** for `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (API) and `GH_CLIENT_ID` (extension build), and the app's URL slug for `GH_APP_SLUG`. Users install the app on the repositories they choose; the user token PagePatch gets can only reach repositories where the app is installed **and** the user has access.

## Deploying the API (Render)

`render.yaml` defines a Node web service and a Postgres database. Create a Blueprint from this repo in Render, then set these secrets in the dashboard: `ALLOWED_EXTENSION_IDS` (the Web Store id, plus your unpacked id if you need it), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Approximate cost: $7/month for the web service (Starter) plus $6/month for Postgres (Basic 256 MB).

Logs record only route, method, status, timing, and an error category. Request bodies, headers, API keys, GitHub tokens, page content, and repository content are never logged. Patch proposals expire after 60 minutes and are deleted a day later.

## Releasing

1. Bump `version` in `extension/manifest.json`.
2. Tag `v<version>` and push. CI runs the tests, builds the extension against the hosted API (repository variables `PAGEPATCH_API`, `GH_CLIENT_ID`, `GH_APP_SLUG`), and attaches `pagepatch-extension-v<version>.zip` to a GitHub release.
3. Upload the same ZIP in the Chrome Web Store developer dashboard. See `docs/store-listing.md`.

## V1 boundaries

PagePatch focuses on visual and content edits to existing pages. Custom JavaScript behavior, cross-frame editing, automatic deployment, and merging are out of scope.

## License

MIT
