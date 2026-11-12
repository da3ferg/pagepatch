# PagePatch privacy

_Last updated: November 9, 2026_

PagePatch runs on your computer. There is no PagePatch server, account, database, analytics, or tracking.

## What leaves your machine

Only requests to the model you pick under Configure, made from the `pagepatch` process: through Claude Code or Codex with the login you already have, or to Anthropic or OpenAI with your own API key:

- **The section you select**: a simplified copy with element tags, class names, visible text, image alt text, link paths, and the parent's layout (for example "flex row"). Never form field values, hidden inputs, cookies, page storage, URL query strings or fragments, or anything outside the selection.
- **Your messages** in the conversation.
- **When you generate a source patch**: up to five matching files from the project folder you pointed PagePatch at.

These requests fall under that provider's terms: [Anthropic](https://www.anthropic.com/legal/privacy) for Claude Code and Anthropic API keys, [OpenAI](https://openai.com/policies/privacy-policy) for Codex and OpenAI API keys. Claude Code adds its own small context to each request, such as your account email and the date.

## What stays local

- **Claude Code and Codex** run in an empty temporary folder, deleted after each request. Claude Code has every tool turned off; Codex runs read-only.
- **API keys**, if you use one, come from your environment or the Configure section and stay in the `pagepatch` process's memory. They're never written to disk or sent back to the browser.
- **The proxy and panel** listen on 127.0.0.1 only and refuse requests with any other Host header. The API answers only the panel's own origin, with a random token created on each run. The panel is a separate-origin iframe, so neither your page's scripts nor other sites can read the token.
- **Writes** happen only after you review a diff and click **Write to files**, only to regular files inside the project folder, and only if the file hasn't changed since the diff was made.
- **Logs** in your terminal show the route, status, and timing. They never include page content, source, or keys.
