# PagePatch privacy policy

_Last updated: November 9, 2026_

PagePatch is a Chrome extension for web developers that previews edits to a page section and turns them into draft GitHub pull requests. This policy explains what data PagePatch handles and why.

## What PagePatch accesses

- **The page you activate it on.** PagePatch only runs on a tab after you click its toolbar button, and only on that tab until it navigates (Chrome's `activeTab` permission). It doesn't read your browsing history or other tabs.
- **The section you select.** When you send a message, PagePatch sends a simplified copy of the selected section to the AI provider you chose: element tags, class names, visible text, image alt text, and link paths. It also sends the parent element's layout (for example, "flex row"). It never sends form field values, hidden inputs, cookies, page storage (localStorage, sessionStorage, IndexedDB), URL query strings or fragments, or anything outside your selection.
- **Your messages** in the PagePatch conversation.
- **Your AI provider API key.** It is stored in Chrome's session storage, which is cleared when Chrome closes or when you click **Clear key**. It is sent with each request to the PagePatch API, which passes it to OpenAI or Anthropic for that single request. The PagePatch API does not store or log your key.
- **GitHub, if you connect it.** PagePatch uses a GitHub App that you install on the repositories you choose. When you generate a source patch, the PagePatch API reads the file list of the branch you picked and the contents of a few matching files. It sends up to five of those files to your AI provider. Your GitHub sign-in token is stored in Chrome's session storage and sent to the PagePatch API with GitHub requests. The API does not store it.

## What the PagePatch API stores

- **Patch proposals**: the repository, base branch and commit, the proposed diff, and the changed file contents, tied to your GitHub user id. A proposal is created when you generate a source patch so that the exact diff you reviewed is the one committed. Proposals expire after 60 minutes and are deleted within a day after that.
- **Operational logs**: request route, status, timing, and an error category. Logs never include request bodies, API keys, tokens, page content, or repository content.

PagePatch has no accounts, analytics, advertising, or tracking. It does not sell or share data. Data goes only to the AI provider you choose (under that provider's terms) and to GitHub, as described above.

## Third parties

- OpenAI ([privacy policy](https://openai.com/policies/privacy-policy)) or Anthropic ([privacy policy](https://www.anthropic.com/legal/privacy)), whichever you select
- GitHub ([privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement))
- Render, which hosts the PagePatch API and database ([privacy policy](https://render.com/privacy))

## Your controls

- Clear your API key at any time from Settings, or close Chrome.
- Sign out of GitHub from the side panel. Uninstalling the GitHub App revokes PagePatch's access to your repositories.
- PagePatch never writes to your base branch and never merges. It only opens draft pull requests after you review the diff.

## Contact

Questions: open an issue at https://github.com/da3ferg/pagepatch/issues.

## Limited Use

PagePatch's use of information received from users complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.
