// Server checks without a browser: access control, HTML injection, proxy edge
// cases, HMR websocket passthrough, and the propose -> apply write path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServers } from "./server.ts";
import type { Call, Settings } from "./llm.ts";

const TOKEN = "t".repeat(48);
const PORT = 48731, PANEL = 48732;
const base = `http://127.0.0.1:${PORT}`, panel = `http://127.0.0.1:${PANEL}`;
let upstream: http.Server, servers: ReturnType<typeof createServers>, root: string;
let seen: http.IncomingHttpHeaders = {};
let nextModel: (c: Call) => Promise<unknown> = async () => ({ summary: "", ops: [] });
const settings: Settings = { provider: "claude-code", model: "sonnet", keys: {} };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pp-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/Hero.tsx"), `export const Hero = () => (\n  <section className="hero"><h1>Ship faster</h1></section>\n);\n`);
  await writeFile(join(tmpdir(), "pp-outside.css"), "h1{}");
  await symlink(join(tmpdir(), "pp-outside.css"), join(root, "src/linked.css"));

  upstream = http.createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("1"); return; }
    if (req.url === "/go") { res.writeHead(302, { location: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/` }); res.end(); return; }
    if (req.url === "/die") { res.writeHead(200, { "content-type": "text/javascript", "content-length": "1000" }); res.write("partial"); setTimeout(() => res.socket?.destroy(), 20); return; }
    res.writeHead(200, { "content-type": "text/html", etag: "x", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "cache-control": "max-age=600" });
    res.end(`<html><body><h1>hi ${req.headers.host}</h1></body></html>`);
  });
  upstream.on("upgrade", (req, socket, head) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Origin: ${req.headers.origin}\r\n\r\n`);
    socket.write(head);
    socket.on("data", (d) => socket.write(d));   // echo
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as net.AddressInfo).port;

  servers = createServers({
    target: `http://127.0.0.1:${upPort}`, root, port: PORT, panelPort: PANEL, token: TOKEN,
    overlayJs: "/*overlay*/", panelJs: "/*panel*/",
    settings, available: { "claude-code": true, codex: true, anthropic: true, openai: true }, model: (_s, c) => nextModel(c),
  });
  await new Promise<void>((r) => servers.proxy.listen(PORT, "127.0.0.1", r));
  await new Promise<void>((r) => servers.panel.listen(PANEL, "127.0.0.1", r));
});

after(async () => {
  for (const s of [servers.proxy, servers.panel, upstream]) { s?.closeAllConnections(); s?.close(); }
  await rm(root, { recursive: true, force: true });
});

const post = (route: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${panel}/api/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-pagepatch-token": TOKEN, origin: panel, ...headers }, body: JSON.stringify(body) });

test("injects a token-free loader into HTML and passes other assets through", async () => {
  const res = await fetch(base, { headers: { accept: "text/html", "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" } });
  const html = await res.text();
  assert.match(html, /<h1>hi 127\.0\.0\.1:\d+<\/h1><script src="\/__pagepatch\/overlay\.js" data-pagepatch-panel="48732" defer><\/script><\/body>/);
  assert.doesNotMatch(html, new RegExp(TOKEN), "the page never sees the token");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("last-modified"), null);
  assert.equal(res.headers.get("etag"), null);
  assert.equal(seen["if-modified-since"], undefined, "conditional requests for pages aren't forwarded");
  assert.equal(seen["accept-encoding"], "identity");
  assert.equal(await (await fetch(`${base}/app.js`)).text(), "1");
  assert.equal(await (await fetch(`${base}/__pagepatch/overlay.js`)).text(), "/*overlay*/");
  const redirect = await fetch(`${base}/go`, { redirect: "manual" });
  assert.equal(redirect.headers.get("location"), `${base}/`);
});

test("the panel serves the token only to framing by the proxy origin", async () => {
  const res = await fetch(`${panel}/?parent=${encodeURIComponent(base)}`);
  assert.match(await res.text(), new RegExp(`data-token="${TOKEN}"`));
  assert.match(res.headers.get("content-security-policy")!, /frame-ancestors http:\/\/127\.0\.0\.1:48731 http:\/\/localhost:48731/);
  assert.equal((await fetch(`${panel}/?parent=${encodeURIComponent("https://evil.example")}`)).status, 400);
  assert.equal(await (await fetch(`${panel}/panel.js`)).text(), "/*panel*/");
});

test("rejects foreign hosts, missing tokens, and any origin but the panel's", async () => {
  for (const url of [base, panel]) {
    const res = await new Promise<http.IncomingMessage>((r) => http.get(url, { headers: { host: "evil.example" } }, r));
    assert.equal(res.statusCode, 403, url);
    res.resume();
  }
  assert.equal((await post("preview", {}, { "x-pagepatch-token": "nope" })).status, 403);
  assert.equal((await post("preview", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("preview", {}, { origin: base })).status, 403, "the proxied page's origin can't call the API");
  const get = await fetch(`${panel}/api/preview`, { headers: { "x-pagepatch-token": TOKEN, origin: panel } });
  assert.equal(get.status, 405);
});

test("a foreign Origin reaches the dev server unchanged; our own is translated", async () => {
  await fetch(`${base}/app.js`, { method: "POST", headers: { origin: "https://evil.example", referer: "https://evil.example/x" } });
  assert.equal(seen.origin, "https://evil.example");
  assert.equal(seen.referer, "https://evil.example/x");
  await fetch(`${base}/app.js`, { method: "POST", headers: { origin: base, referer: `${base}/page` } });
  assert.match(String(seen.origin), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(seen.origin, base);
  assert.equal(seen.referer, `${seen.origin}/page`);
});

test("a dev server dying mid-response ends the client response instead of hanging", async () => {
  await assert.rejects(async () => { const r = await fetch(`${base}/die`); await r.text(); });
});

test("tunnels websocket upgrades to the dev server", async () => {
  const sock = net.connect(PORT, "127.0.0.1");
  sock.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nOrigin: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nping`);
  let got = "";
  await new Promise<void>((r) => sock.on("data", (d) => { got += d; if (got.includes("ping")) r(); }));
  sock.destroy();
  assert.match(got, /101 Switching Protocols/);
  assert.match(got, /X-Origin: http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(got, new RegExp(`X-Origin: ${base}`));
});

test("propose then apply writes the reviewed diff, and refuses a stale one", async () => {
  nextModel = async () => ({ summary: "Retitle.", edits: [{ path: "src/Hero.tsx", search: "<h1>Ship faster</h1>", replace: "<h1>Ship today</h1>" }] });
  const sec = { label: "section.hero", messages: [{ role: "user", content: "retitle" }], snapshot: "<section>", signals: { texts: ["Ship faster"], classes: ["hero"], ids: [] } };
  const p = await (await post("propose", { sections: [sec] })).json();
  assert.equal(p.status, "ready");
  assert.match(p.diff, /\+  <section className="hero"><h1>Ship today<\/h1>/);
  assert.match(await readFile(join(root, "src/Hero.tsx"), "utf8"), /Ship faster/, "nothing written before approval");

  const ok = await (await post("apply", { proposalId: p.proposalId })).json();
  assert.deepEqual(ok, { ok: true, files: ["src/Hero.tsx"] });
  assert.match(await readFile(join(root, "src/Hero.tsx"), "utf8"), /Ship today/);
  assert.deepEqual((await readdir(join(root, "src"))).filter((f) => f.includes("pagepatch")), [], "no temp files left");
  assert.equal((await post("apply", { proposalId: p.proposalId })).status, 404, "a proposal applies once");

  // The file changes on disk between review and write.
  nextModel = async () => ({ summary: "Back.", edits: [{ path: "src/Hero.tsx", search: "<h1>Ship today</h1>", replace: "<h1>Ship now</h1>" }] });
  const p2 = await (await post("propose", { sections: [{ ...sec, paths: ["src/Hero.tsx"] }] })).json();
  await writeFile(join(root, "src/Hero.tsx"), (await readFile(join(root, "src/Hero.tsx"), "utf8")) + "// edited\n");
  const stale = await post("apply", { proposalId: p2.proposalId });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "file_changed");
  assert.doesNotMatch(await readFile(join(root, "src/Hero.tsx"), "utf8"), /Ship now/);
});

test("never reads or writes outside the project", async () => {
  for (const path of ["../pp-outside.css", "src/linked.css", "/etc/hosts", "src/../../x.css"]) {
    const r = await post("propose", { sections: [{ label: "x", messages: [{ role: "user", content: "x" }], snapshot: "x", paths: [path] }] });
    assert.equal(r.status, 400, path);
  }
});

test("a rejected model response goes back to the model with the reason, up to 3 tries", async () => {
  const seenCalls: { messages: { role: string; content: string }[]; system: string }[] = [];
  const bad = { summary: "x", ops: [{ op: "setStyle", target: "pp0", styles: [{ name: "background", value: "red" }] }] };
  const good = { summary: "Red.", ops: [{ op: "setStyle", target: "pp0", styles: [{ name: "background-color", value: "red" }] }] };
  const body = { messages: [{ role: "user", content: "make it red" }], snapshot: '<section data-pp-id="pp0">', ids: ["pp0"] };

  let replies = [bad, good];
  nextModel = async (a) => { seenCalls.push(a as never); return replies.shift(); };
  const res = await post("preview", body);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).ops[0].styles, { "background-color": "red" });
  assert.equal(seenCalls.length, 2);
  const retry = seenCalls[1].messages;
  assert.equal(retry.at(-2)!.role, "assistant");
  assert.match(retry.at(-1)!.content, /rejected: op 0: css property not allowed: background/);
  assert.match(seenCalls[0].system, /Allowed CSS properties.*background-color/);

  seenCalls.length = 0;
  replies = [bad, bad, bad, good];
  const fail = await post("preview", body);
  assert.equal(fail.status, 502);
  assert.match((await fail.json()).message, /after 3 tries/);
  assert.equal(seenCalls.length, 3, "stops after 3 attempts");
});

test("source edits that don't match the file are sent back for correction", async () => {
  await writeFile(join(root, "src/Card.tsx"), `export const Card = () => (\n  <div className="card"><h3>Old title</h3></div>\n);\n`);
  const calls: unknown[] = [];
  const replies = [
    { summary: "x", edits: [{ path: "src/Card.tsx", search: "<h3>Wrong</h3>", replace: "<h3>New</h3>" }] },
    { summary: "Retitle.", edits: [{ path: "src/Card.tsx", search: "<h3>Old title</h3>", replace: "<h3>New title</h3>" }] },
  ];
  nextModel = async (a) => { calls.push(a); return replies.shift(); };
  const r = await (await post("propose", { sections: [{ label: "div.card", messages: [{ role: "user", content: "retitle" }], snapshot: "x", paths: ["src/Card.tsx"] }] })).json();
  assert.equal(r.status, "ready");
  assert.match(r.diff, /\+  <div className="card"><h3>New title<\/h3><\/div>/);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1]), /search text not found in src\/Card.tsx/);
});

test("one source patch covers several sections, and asks which file when one section is ambiguous", async () => {
  await writeFile(join(root, "src/Footer.tsx"), `export const Footer = () => (\n  <footer className="footer"><p>Made in Kingston</p></footer>\n);\n`);
  const prompts: string[] = [];
  nextModel = async (a) => {
    prompts.push(a.messages.at(-1)!.content);
    return { summary: "Both.", edits: [
      { path: "src/Card.tsx", search: "<h3>Old title</h3>", replace: "<h3>Newer title</h3>" },
      { path: "src/Footer.tsx", search: "<p>Made in Kingston</p>", replace: "<p>Made in Jamaica</p>" },
    ] };
  };
  const card = { label: "div.card", messages: [{ role: "user", content: "retitle" }], snapshot: "x", signals: { texts: ["Old title"], classes: ["card"], ids: [] } };
  const footer = { label: "footer.footer", messages: [{ role: "user", content: "say Jamaica" }], snapshot: "y", signals: { texts: ["Made in Kingston"], classes: ["footer"], ids: [] } };
  const r = await (await post("propose", { sections: [card, footer] })).json();
  assert.equal(r.status, "ready");
  assert.deepEqual(r.files.sort(), ["src/Card.tsx", "src/Footer.tsx"]);
  assert.equal(prompts.length, 1, "one model call for all sections");
  assert.match(prompts[0], /<section index="1" label="div.card">[\s\S]*User: retitle[\s\S]*<section index="2" label="footer.footer">[\s\S]*User: say Jamaica/);

  const vague = { label: "div.x", messages: [{ role: "user", content: "x" }], snapshot: "z", signals: { texts: [], classes: [], ids: [] } };
  const c = await (await post("propose", { sections: [card, vague] })).json();
  assert.equal(c.status, "choose");
  assert.equal(c.section, 1, "names the ambiguous section");
});

test("Configure switches providers; API keys are kept but never sent back", async () => {
  const c = await (await post("config", {})).json();
  assert.equal(c.provider, "claude-code");
  assert.equal(c.problem, null);
  const k = await (await post("config", { provider: "anthropic" })).json();
  assert.equal(k.model, "claude-opus-5-5", "switching provider resets to its default model");
  assert.equal(k.problem, "Add an Anthropic API key.");
  const withKey = await post("config", { apiKey: "sk-ant-test-123" });
  const body = await withKey.text();
  assert.doesNotMatch(body, /sk-ant-test-123/, "the key is never returned");
  assert.equal(JSON.parse(body).hasKey.anthropic, true);
  assert.equal(settings.keys.anthropic, "sk-ant-test-123");
  assert.equal((await post("config", { provider: "gpt-9" })).status, 400);
  assert.equal((await post("config", { model: "bad model name!" })).status, 400);
  assert.equal((await post("config", { provider: "codex" })).status, 200);
  assert.equal((await post("config", { apiKey: "x" })).status, 400, "keys only for API providers");
  await post("config", { provider: "claude-code" });
});
