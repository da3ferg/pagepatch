// Capture 1280x800 Web Store screenshots: page (left) + side panel (right),
// composited. Uses a scripted API so shots are reproducible.
// Run: pnpm --filter @pagepatch/fixture-react build && node extension/scripts/screenshots.mjs
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ext = join(root, "extension", "dist");
const out = join(root, "docs", "screenshots");
await mkdir(out, { recursive: true });
execFileSync("node", [join(root, "extension/scripts/build.mjs")], { env: { ...process.env, PAGEPATCH_TEST: "1", PAGEPATCH_API: "http://127.0.0.1:8799", GH_CLIENT_ID: "demo" } });

const send = (res, s, b) => { res.writeHead(s, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); res.end(JSON.stringify(b)); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

const files = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname.replace(/^\/react\/?/, "") || "index.html";
  try { const b = await readFile(join(root, "fixtures/react/dist", p)); res.writeHead(200, { "content-type": { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(p)] }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(8798, "127.0.0.1");

const api = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const path = new URL(req.url, "http://x").pathname;
  const b = req.method === "POST" ? await body(req) : {};
  if (path === "/v1/preview") return send(res, 200, {
    summary: "Highlighted the Team plan, renamed the heading, and added an annual billing note.",
    ops: [
      { op: "setText", target: "pp1", text: "Pricing that grows with you" },
      { op: "setStyle", target: "pp7", styles: { "background-color": "#eef3fe", padding: "16px", "border-radius": "10px" } },
      { op: "insert", parent: "pp0", index: 2, node: { tag: "p", text: "Save 20% with annual billing.", styles: { color: "#6e6e73", "margin-top": "16px" } } },
    ],
  });
  if (path === "/v1/repos") return send(res, 200, { repos: [{ owner: "acme", name: "lumen", defaultBranch: "main" }] });
  if (path.endsWith("/branches")) return send(res, 200, { branches: ["main"] });
  if (path === "/v1/source/propose") return send(res, 200, { status: "ready", proposalId: "00000000-0000-0000-0000-000000000001", summary: "Rename the pricing heading, highlight the Team plan, and add an annual billing note.", files: ["src/components/Pricing.tsx", "src/styles.css"],
    diff: `--- a/src/components/Pricing.tsx\n+++ b/src/components/Pricing.tsx\n@@ -9,10 +9,11 @@\n   return (\n     <section className="pricing">\n-      <h2 className="pricing-title">Simple pricing</h2>\n+      <h2 className="pricing-title">Pricing that grows with you</h2>\n       <div className="plan-grid">\n         {plans.map((p) => (\n-          <div className="plan" key={p.name}>\n+          <div className={p.name === "Team" ? "plan plan-featured" : "plan"} key={p.name}>\n             <h3>{p.name}</h3>\n@@ -21,4 +22,5 @@\n       </div>\n+      <p className="billing-note">Save 20% with annual billing.</p>\n     </section>\n--- a/src/styles.css\n+++ b/src/styles.css\n@@ -8,3 +8,5 @@\n .plan { border-top: 2px solid #1d1d1f; padding-top: 12px; }\n+.plan-featured { background: #eef3fe; padding: 16px; border-radius: 10px; }\n+.billing-note { color: #6e6e73; margin-top: 16px; }\n` });
  send(res, 404, {});
}).listen(8799, "127.0.0.1");

const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.setViewportSize({ width: 880, height: 800 });
await page.goto("http://127.0.0.1:8798/react/");
const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 800 });
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.evaluate(() => chrome.storage.session.set({ key: "demo", ghToken: "demo", ghLogin: "octo" }));
await panel.evaluate(() => chrome.storage.local.set({ disclosureAccepted: true, provider: "anthropic", model: "claude-opus-5-5" }));
await panel.reload();
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:8798/*" });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  await chrome.storage.session.set({ target: { tabId: tab.id, supported: true, at: Date.now() } });
});
await panel.getByText("Click a section").waitFor();

const composite = ctx.pages()[0];
async function shot(name) {
  const [left, right] = [await page.screenshot(), await panel.screenshot()];
  await composite.setViewportSize({ width: 1280, height: 800 });
  await composite.setContent(`<body style="margin:0;display:flex;background:#fff"><img src="data:image/png;base64,${left.toString("base64")}" style="width:880px;height:800px;border-right:1px solid #e5e5ea"><img src="data:image/png;base64,${right.toString("base64")}" style="width:399px;height:800px"></body>`);
  await composite.screenshot({ path: join(out, `${name}.png`) });
  console.log("wrote", name);
}

// 1. Picker hovering a section
const box = await page.locator(".pricing").boundingBox();
await page.bringToFront();
await page.mouse.move(box.x + 6, box.y + 6);
await shot("1-picker");

// 2. Proposal
await page.mouse.click(box.x + 6, box.y + 6);
await panel.locator("#selection-label").filter({ hasText: "pricing" }).waitFor();
await panel.locator("#prompt").fill("Make the Team plan stand out, punch up the heading, and mention annual billing.");
await panel.locator("#send").click();
await panel.locator("#apply:not([disabled])").waitFor();
await shot("2-proposal");

// 3. Applied preview
await panel.locator("#apply").click();
await panel.getByText("Preview applied").waitFor();
await shot("3-preview");

// 4. Diff review
await panel.locator("#generate:not([disabled])").click();
await panel.locator("#diff-view").waitFor({ state: "visible" });
await panel.locator("#diff-view").scrollIntoViewIfNeeded();
await shot("4-diff");

await ctx.close();
files.close();
api.close();
