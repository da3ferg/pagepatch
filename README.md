# PagePatch

Conversational editing for your local dev site. Click a section of the page, describe a change, and preview it right there. Follow up to refine it. When it looks right, PagePatch finds the source file in your project, shows you a diff, and writes it to disk after you approve it. Your dev server reloads with the real change.

Everything runs on your machine. There's no extension, hosted API, database, or GitHub connection. The only thing that leaves your computer is the request to the model you pick.

- **Works with any dev server**: Vite, Next, CRA, a static server, anything on `http://localhost`.
- **Source edits** for React (JSX/TSX) and static HTML/CSS projects.
- **Bring your own model**: Claude Code or Codex, using the login you already have (your Claude or ChatGPT plan). An Anthropic or OpenAI API key works too.

## Quick start

Requirements: Node 22 and pnpm 10.

```bash
pnpm install
pnpm --filter pagepatch build
```

Start your app's dev server as usual, then point PagePatch at it from your project folder:

```bash
node /path/to/pagepatch/cli/dist/cli.js http://localhost:5173
```

PagePatch uses Claude Code if it's installed, then Codex (including the copy inside the ChatGPT desktop app). Switch any time under **Configure** in the panel, where you can also paste an API key instead.

Open **http://localhost:4400**. Your site loads there with a **PagePatch** button in the corner.

To run it as `pagepatch` from anywhere, link it once: `cd cli && npm link`.

```
pagepatch <dev-server-url> [options]

  pagepatch http://localhost:5173
  pagepatch 3000 --root ./web

  --port <n>         Port for PagePatch (default 4400; the panel uses the next port)
  --root <dir>       Project folder to edit (default: current folder)
  --provider <name>  claude-code, codex, anthropic, or openai (default: Claude Code, then Codex)
  --model <id>       Model for that provider (default: sonnet for Claude Code)
```

## How it works

```
page   ──▶ proxy  127.0.0.1:4400 ──▶ your dev server (pages, assets, hot reload)
  │ postMessage
panel  ──▶ panel  127.0.0.1:4401 ──▶ Claude Code / Codex (your login) or an API
(iframe)                         └─▶ your project files (only after you approve a diff)
```

1. `pagepatch` is a reverse proxy in front of your dev server. It passes through every request, including the hot-reload websocket, and adds one `<script>` tag to HTML pages: a small loader with no secrets.
2. The loader shows a **PagePatch** button and, when you click it, docks the panel on the right. The panel is an iframe served from the next port, a different origin, so your page's own scripts can't read it, call its API, or click its buttons. The panel drives the picker in the page over `postMessage`, and both sides check each other's origin.
3. Click a section. Press <kbd>↑</kbd> to grow the selection to a parent and <kbd>Esc</kbd> to cancel.
4. Your message and a simplified copy of the selection (tags, classes, visible text, link paths) go to the model. It replies with **preview operations**: set text, set styles, set attributes, insert, remove, or move.
5. The server and the page each validate every operation. Operations can only target elements inside the selection, use an allowlist of HTML tags, attributes, and CSS properties, and never carry scripts, event handlers, `url()`, or `javascript:` links. Changes are built on a detached copy and only shown if every operation succeeds. If the model's response breaks a rule, PagePatch sends it back with the reason so the model can correct it (up to 3 tries in all). Source edits that don't match the file get the same treatment.
6. The original element stays in the page (hidden) while a preview is shown, so React and other frameworks keep working. Undo and Reset work on the selected section; Close and navigation restore everything. If the page replaces the element, PagePatch asks you to select it again.
7. You can change several sections. Previews stay when you select another section, and clicking inside a section you already changed picks its conversation back up. A selection that would contain a changed section is refused.
8. **Generate source patch** covers every changed section in one diff. It searches your project folder (skipping `node_modules`, build output, and dot folders) for each section's visible text and class names, sends the matching files (at most 5 per section) to the model in one request, and asks for exact search-and-replace edits. Edits that don't match the file exactly once are rejected. If a section's match is ambiguous, you choose its file.
9. **Write to files** checks that each file hasn't changed since the diff was made, then writes it. If something changed, PagePatch regenerates the diff and asks you to review it again. Use git to review or revert.

### Local safety

- Both ports listen on 127.0.0.1 only and reject any other Host header, which blocks DNS rebinding.
- The API only answers the panel's own origin, with a random token created on each run. The token lives only in the panel document; neither your page nor other sites can read it. The panel can only be framed by the proxy origin.
- The proxy translates only its own Origin/Referer to the dev server's. Requests from other sites keep their Origin, so your dev server's own CSRF and websocket checks still work.
- Known limit: a script in your page can't call the API or read the panel, but it could restyle or cover the panel's iframe. Only approve diffs you've read.
- Writes only go to regular files inside `--root`. Symlinks and paths that leave the folder are refused.
- Claude Code runs with all its tools turned off, in an empty temporary folder, so it can only answer. Codex runs in its read-only sandbox in an empty temporary folder and is told not to run commands.
- An API key you paste under Configure stays in the `pagepatch` process's memory until it stops. It's never written to disk or sent back to the browser. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your environment also work.

See [docs/privacy.md](docs/privacy.md).

## Repository layout

| Path | What |
| --- | --- |
| `cli/src/cli.ts` | Command-line entry: arguments, provider key, startup |
| `cli/src/server.ts` | Proxy (HTML injection, websocket passthrough) and panel server (`preview` / `propose` / `apply`) |
| `cli/src/overlay.ts` | Loader injected into pages: launcher, panel iframe, `postMessage` bridge |
| `cli/src/panel.ts` | Panel UI, running in the cross-origin iframe |
| `cli/src/page.ts` | Picker, selection snapshot, and preview application |
| `cli/src/llm.ts` | Model backends: Claude Code and Codex CLIs, Anthropic and OpenAI APIs |
| `cli/src/search.ts`, `patch.ts` | File ranking, search/replace edits and diffs |
| `shared/` | Preview operation allowlists, validators, and JSON schemas |
| `fixtures/` | Demo pages: `static/` (HTML/CSS) and `react/` (React 18) |

## Tests

```bash
pnpm typecheck
pnpm --filter @pagepatch/shared test   # validator: allowlists, unsafe output
pnpm --filter pagepatch test           # server + browser end-to-end
```

The server tests cover HTML injection and caching, redirects, Host/token/Origin checks, Origin passthrough for foreign sites, upstream aborts, websocket passthrough, writing a reviewed diff, refusing a stale one, and refusing paths outside the project. The end-to-end suite runs the real server in front of both fixtures (copied to a temp folder) with a scripted model and drives the overlay in headless Chrome. It covers selecting, follow-ups, undo and reset, unsafe model output, snapshot privacy, page scripts being unable to reach the panel or API, a React re-render replacing the selection, and writing the source change to disk. Locally it uses your installed Chrome with a fresh profile; CI uses Playwright's Chromium.
