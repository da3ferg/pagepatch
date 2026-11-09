# Chrome Web Store submission

## Listing

**Name:** PagePatch

**Summary (132 chars max):** Select a section of any page, describe a change, preview it live, and turn it into a draft GitHub pull request.

**Category:** Developer Tools

**Description:**

PagePatch is conversational editing for web developers.

1. Click the PagePatch button and select a section of the page.
2. Describe the change you want, such as "make this a three-column grid and tighten the copy."
3. Apply the preview in the current tab, then follow up to refine it. Undo or reset at any time.
4. When it looks right, connect GitHub. PagePatch finds the matching source file in your React or static HTML/CSS project and shows you a diff.
5. Approve the diff and PagePatch opens a draft pull request on a new branch. It never writes to your base branch and never merges.

Bring your own OpenAI or Anthropic API key. Preview works on any page, including localhost, with no GitHub connection. PagePatch only sends the section you select, never form values, cookies, page storage, or URL query strings.

Open source (MIT): https://github.com/da3ferg/pagepatch

**Privacy policy URL:** https://github.com/da3ferg/pagepatch/blob/main/docs/privacy.md

## Single purpose

Preview visual and content edits to a selected section of a web page, and turn approved edits into draft pull requests in the user's GitHub repository.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Gives PagePatch access to the current tab only after the user clicks the toolbar button, so it can show the element picker and apply previews to that tab. PagePatch requests no host permissions and doesn't run on any page until the user clicks. |
| `scripting` | Injects PagePatch's bundled picker and preview script into the tab the user activated. No remote code is executed. Model output is treated as data and validated against an allowlist before any DOM change. |
| `sidePanel` | Hosts the PagePatch conversation, preview controls, and diff review next to the page. |
| `storage` | Keeps the user's API key and GitHub sign-in in session storage (cleared when Chrome closes) and remembers non-sensitive settings such as provider, model, and last repository. |
| `identity` | Runs the GitHub sign-in flow (`launchWebAuthFlow`) so the user can authorize the PagePatch GitHub App. |

**Remote code:** No. All executable code is bundled in the package. The extension sends data to and receives JSON from the PagePatch API. That JSON is validated as data and never executed.

## Data usage disclosures

- Collects **website content** (the section the user selects) and **authentication information** (the user's AI provider key and GitHub token, held in session storage and sent with requests). These are used only to provide the extension's single purpose.
- Not sold to third parties. Not used or transferred for purposes unrelated to the single purpose. Not used to determine creditworthiness or for lending.

## Reviewer instructions and test flow

PagePatch needs an AI provider key to generate edits. A temporary Anthropic test key for review is provided in the "Test instructions" field (rotated after review).

1. Install the extension and open https://da3ferg.github.io/pagepatch/fixtures/static/ (a demo page).
2. Click the PagePatch toolbar button. The side panel opens and the page shows a blue hover outline.
3. Click the row of three feature cards ("Fast capture", "Linked decisions", "Instant search"). The panel shows `section.features`.
4. In Settings, choose **Anthropic**, keep the default model, paste the test key, and click **Save**.
5. Type "make this a two-column grid and add a card called Offline mode", then click **Send**. Read the data disclosure and click **I understand**.
6. Click **Apply preview**. The cards change layout and a fourth card appears.
7. Click **Undo**, then **Reset**. The page returns to its original state.
8. (Optional, GitHub) Click **Sign in with GitHub**, install the PagePatch app on a test repository you own, choose that repository and its base branch, and click **Generate source patch**. Review the diff and click **Create draft PR**.

Preview (steps 1–7) doesn't require a GitHub account.

## Screenshots (1280×800)

1. Picker outlining a section, with the side panel open
2. Conversation with a proposed change and **Apply preview**
3. The applied preview on the page next to the conversation
4. Source diff review with **Create draft PR**
5. The draft pull request on GitHub

Capture them with `node extension/scripts/screenshots.mjs` after building the extension and fixtures.
