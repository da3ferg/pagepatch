// Route tests against a real Postgres (DATABASE_URL), with GitHub and the
// model providers mocked at the fetch layer.
//   docker run -d --rm -e POSTGRES_PASSWORD=pp -e POSTGRES_DB=pagepatch -p 54329:5432 postgres:16-alpine
//   DATABASE_URL=postgres://postgres:pp@localhost:54329/pagepatch pnpm --filter @pagepatch/api test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.ALLOWED_EXTENSION_IDS = "abcdefghijklmnopabcdefghijklmnop";
const skip = !process.env.DATABASE_URL && "set DATABASE_URL to run route tests";

const { app } = await import("./server.ts");
const db = await import("./db.ts");

// ---- fetch mock ----
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: [string, RegExp, Handler][] = [];
const seen: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const on = (method: string, re: RegExp, h: Handler) => routes.unshift([method, re, h]);

let modelJson = "";
function baseRoutes() {
  routes = [];
  on("POST", /api\.anthropic\.com\/v1\/messages/, () => reply(200, {
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: modelJson }], usage: { input_tokens: 1, output_tokens: 1 },
  }));
  on("POST", /api\.openai\.com\/v1\/responses/, () => reply(200, {
    id: "resp_1", object: "response", status: "completed", model: "gpt-test", output_text: modelJson,
    output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: modelJson, annotations: [] }] }],
  }));
  on("GET", /\/user$/, (_u, init) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    return auth === "Bearer gh-alice" ? reply(200, { id: 1, login: "alice" }) : auth === "Bearer gh-bob" ? reply(200, { id: 2, login: "bob" }) : reply(401, {});
  });
  on("GET", /\/repos\/acme\/site$/, () => reply(200, { permissions: { push: true } }));
  on("GET", /\/repos\/acme\/site\/branches\/main$/, () => reply(200, { commit: { sha: "base1", commit: { tree: { sha: "tree1" } } } }));
  on("GET", /\/git\/trees\/tree1/, () => reply(200, { truncated: false, tree: [
    { path: "src/components/Hero.tsx", type: "blob", mode: "100755", size: 200 },
    { path: "src/components/Footer.tsx", type: "blob", mode: "100644", size: 200 },
    { path: "src/styles.css", type: "blob", mode: "100644", size: 100 },
    { path: "src/Linked.tsx", type: "blob", mode: "120000", size: 20 },
    { path: "vite.config.ts", type: "blob", mode: "100644", size: 100 },
    { path: "node_modules/x/index.js", type: "blob", mode: "100644", size: 10 },
  ] }));
  on("GET", /\/contents\/src\/components\/Hero\.tsx/, () => new Response(`export function Hero() {\n  return (\n    <section className="hero">\n      <h1>Ship faster with PagePatch</h1>\n    </section>\n  );\n}\n`));
  on("GET", /\/contents\/src\/components\/Footer\.tsx/, () => new Response(`export const Footer = () => <footer className="footer">© Acme</footer>;\n`));
  on("GET", /\/contents\/src\/styles\.css/, () => new Response(`.hero { padding: 64px; }\n`));
  on("GET", /\/contents\/vite\.config\.ts/, () => new Response(`export default { server: { port: 3000 } };\n`));
}

before(async () => {
  if (skip) return;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init.body ?? (req ? await req.clone().text() : undefined);
    seen.push({ method, url: url.toString(), body: typeof raw === "string" && raw ? JSON.parse(raw) : undefined, headers });
    for (const [m, re, h] of routes) if (m === method && re.test(url.toString())) return h(url, { ...init, headers: Object.fromEntries(new Headers(init.headers ?? req?.headers).entries().map(([k, v]) => [k === "authorization" ? "Authorization" : k, v])) });
    return reply(404, { message: "unmocked " + method + " " + url });
  }) as typeof fetch;
  await db.migrate();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!skip) await db.sql.end();
});

beforeEach(() => { baseRoutes(); seen.length = 0; });

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

const previewBody = (provider: string) => ({
  provider, model: provider === "anthropic" ? "claude-opus-5-5" : "gpt-test",
  messages: [{ role: "user", content: "make it bold" }],
  snapshot: `<section data-pp-id="pp0"><h1 data-pp-id="pp1">Hi</h1></section>`, ids: ["pp0", "pp1"],
});
const goodOps = JSON.stringify({ summary: "Bold heading.", ops: [
  { op: "setStyle", target: "pp1", text: "", styles: [{ name: "font-weight", value: "700" }], name: "", value: "", parent: "", index: -1, node: null },
] });

test("preview via Anthropic uses structured outputs and validates", { skip }, async () => {
  modelJson = goodOps;
  const res = await post("/v1/preview", previewBody("anthropic"), { "x-provider-key": "sk-ant-secret" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.ops, [{ op: "setStyle", target: "pp1", styles: { "font-weight": "700" } }]);
  const call = seen.find((s) => s.url.includes("anthropic"))!;
  assert.equal(call.body.output_config.format.type, "json_schema");
  assert.equal(call.headers["x-api-key"], "sk-ant-secret");
});

test("preview via OpenAI uses strict json_schema", { skip }, async () => {
  modelJson = goodOps;
  const res = await post("/v1/preview", previewBody("openai"), { "x-provider-key": "sk-openai-secret" });
  assert.equal(res.status, 200);
  const call = seen.find((s) => s.url.includes("openai"))!;
  assert.equal(call.body.text.format.type, "json_schema");
  assert.equal(call.body.text.format.strict, true);
});

test("malformed and unsafe model output are rejected", { skip }, async () => {
  modelJson = "{not json";
  let res = await post("/v1/preview", previewBody("anthropic"), { "x-provider-key": "k" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "model_bad_json");

  modelJson = JSON.stringify({ summary: "x", ops: [{ op: "insert", target: "", text: "", styles: [], name: "", value: "", parent: "pp0", index: 0, node: { tag: "script", text: "alert(1)", attrs: [], styles: [], children: [] } }] });
  res = await post("/v1/preview", previewBody("anthropic"), { "x-provider-key": "k" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "model_invalid_ops");

  res = await post("/v1/preview", previewBody("anthropic"));
  assert.equal(res.status, 400);
});

const proposeBody = (extra: object = {}) => ({
  ...previewBody("anthropic"), owner: "acme", repo: "site", branch: "main",
  ops: [{ op: "setText", target: "pp1", text: "Ship today" }],
  signals: { texts: ["Ship faster with PagePatch"], classes: ["hero"], ids: [] },
  ...extra,
});
const heroEdit = JSON.stringify({ summary: "Update hero heading.", edits: [{ path: "src/components/Hero.tsx", search: "<h1>Ship faster with PagePatch</h1>", replace: "<h1>Ship today</h1>" }] });
const auth = (who = "alice") => ({ "x-provider-key": "k", authorization: `Bearer gh-${who}` });

test("propose: denied repo access", { skip }, async () => {
  on("GET", /\/repos\/acme\/site$/, () => reply(200, { permissions: { push: false } }));
  const res = await post("/v1/source/propose", proposeBody(), auth());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "no_write");
});

test("propose: ambiguous match returns candidates", { skip }, async () => {
  const res = await post("/v1/source/propose", proposeBody({ signals: { texts: ["Text that is nowhere"], classes: [], ids: [] } }), auth());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "choose");
  assert.ok(!seen.some((s) => s.url.includes("anthropic")), "no model call when ambiguous");
});

async function propose() {
  modelJson = heroEdit;
  const res = await post("/v1/source/propose", proposeBody(), auth());
  assert.equal(res.status, 200);
  return res.json();
}

test("propose: ranked match produces a reviewed diff", { skip }, async () => {
  const body = await propose();
  assert.equal(body.status, "ready");
  assert.deepEqual(body.files, ["src/components/Hero.tsx"]);
  assert.match(body.diff, /-      <h1>Ship faster with PagePatch<\/h1>/);
  assert.match(body.diff, /\+      <h1>Ship today<\/h1>/);
  const modelCall = seen.find((s) => s.url.includes("anthropic"))!;
  assert.match(JSON.stringify(modelCall.body), /Hero\.tsx/);
  assert.doesNotMatch(JSON.stringify(modelCall.body), /node_modules/);
});

test("propose: user-chosen paths must be editable HTML, CSS, or components", { skip }, async () => {
  for (const path of ["node_modules/x/index.js", "vite.config.ts", "src/Linked.tsx", "../../etc/passwd"]) {
    const res = await post("/v1/source/propose", proposeBody({ paths: [path] }), auth());
    assert.equal(res.status, 400, path);
  }
});

test("propose: non-UTF-8 files are refused instead of mangled", { skip }, async () => {
  on("GET", /\/contents\/src\/components\/Hero\.tsx/, () => new Response(new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe])));
  const res = await post("/v1/source/propose", proposeBody({ paths: ["src/components/Hero.tsx"] }), auth());
  assert.notEqual(res.status, 200);
});

test("rate limit keys on the proxy-appended client IP, not spoofable hops", { skip }, async () => {
  modelJson = goodOps;
  let last = 0;
  for (let i = 0; i < 61; i++) {
    const res = await post("/v1/preview", previewBody("anthropic"), { "x-provider-key": "k", "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` });
    last = res.status;
  }
  assert.equal(last, 429);
});

function prWrites() {
  const counts = { commit: 0, ref: 0, pr: 0 };
  on("POST", /\/git\/trees$/, () => reply(201, { sha: "tree2" }));
  on("POST", /\/git\/commits$/, () => { counts.commit++; return reply(201, { sha: "commit2" }); });
  on("POST", /\/git\/refs$/, () => { counts.ref++; return counts.ref > 1 ? reply(422, { message: "Reference already exists" }) : reply(201, {}); });
  on("GET", /\/git\/ref\/heads\/pagepatch/, () => reply(200, { object: { sha: "commit2" } }));
  on("GET", /\/pulls\?/, () => reply(200, []));
  on("POST", /\/pulls$/, () => { counts.pr++; return reply(201, { html_url: "https://github.com/acme/site/pull/1" }); });
  return counts;
}

test("pr: base branch advanced requires regeneration", { skip }, async () => {
  const { proposalId } = await propose();
  on("GET", /\/repos\/acme\/site\/branches\/main$/, () => reply(200, { commit: { sha: "base2", commit: { tree: { sha: "tree9" } } } }));
  const counts = prWrites();
  const res = await post("/v1/source/pr", { proposalId }, auth());
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "base_advanced");
  assert.deepEqual(counts, { commit: 0, ref: 0, pr: 0 });
});

test("pr: other users can't use a proposal; access is rechecked", { skip }, async () => {
  const { proposalId } = await propose();
  let res = await post("/v1/source/pr", { proposalId }, auth("bob"));
  assert.equal(res.status, 404);
  on("GET", /\/repos\/acme\/site$/, () => reply(404, {}));
  res = await post("/v1/source/pr", { proposalId }, auth());
  assert.equal(res.status, 403);
});

test("pr: creates a draft PR on a pagepatch branch; retry reuses the branch", { skip }, async () => {
  const { proposalId } = await propose();
  const counts = prWrites();
  // First attempt fails at the PR step.
  on("POST", /\/pulls$/, () => reply(502, {}));
  let res = await post("/v1/source/pr", { proposalId }, auth());
  assert.equal(res.status, 502);
  assert.equal(counts.commit, 1);

  // Retry: same commit, existing branch accepted, PR created.
  on("POST", /\/pulls$/, () => { counts.pr++; return reply(201, { html_url: "https://github.com/acme/site/pull/1" }); });
  res = await post("/v1/source/pr", { proposalId }, auth());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://github.com/acme/site/pull/1");
  assert.equal(counts.commit, 1, "commit reused on retry");
  const refCall = seen.find((s) => s.url.endsWith("/git/refs"))!;
  assert.match(refCall.body.ref, /^refs\/heads\/pagepatch\/[0-9a-f]{8}$/);
  assert.equal(refCall.body.sha, "commit2");
  const prCall = seen.filter((s) => s.url.endsWith("/pulls") && s.method === "POST").at(-1)!;
  assert.equal(prCall.body.draft, true);
  assert.equal(prCall.body.base, "main");
  const commitCall = seen.find((s) => s.url.endsWith("/git/commits"))!;
  assert.deepEqual(commitCall.body.parents, ["base1"]);
  const treeCall = seen.find((s) => s.url.endsWith("/git/trees") && s.method === "POST")!;
  assert.equal(treeCall.body.tree[0].mode, "100755", "file mode preserved");
  assert.ok(!seen.some((s) => s.method !== "GET" && /refs\/heads\/main|\/merge/.test(s.url + JSON.stringify(s.body ?? ""))), "never writes the base branch or merges");

  // Done proposals return the same link without writing again.
  res = await post("/v1/source/pr", { proposalId }, auth());
  assert.equal((await res.json()).url, "https://github.com/acme/site/pull/1");
  assert.equal(counts.pr, 1);
});

test("pr: concurrent requests can't create two commits", { skip }, async () => {
  const { proposalId } = await propose();
  const counts = prWrites();
  on("POST", /\/git\/commits$/, async () => { counts.commit++; await new Promise((r) => setTimeout(r, 50)); return reply(201, { sha: "commit2" }); });
  const [a, b] = await Promise.all([post("/v1/source/pr", { proposalId }, auth()), post("/v1/source/pr", { proposalId }, auth())]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(counts.commit, 1);
});

test("operational logs never contain keys, tokens, or content", { skip }, async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    modelJson = goodOps;
    await post("/v1/preview", previewBody("anthropic"), { "x-provider-key": "sk-ant-LEAKCHECK" });
    await propose();
  } finally { console.log = orig; }
  const all = lines.join("\n");
  assert.ok(lines.length >= 2);
  assert.doesNotMatch(all, /LEAKCHECK|gh-alice|Ship faster|make it bold|pp1/);
  for (const l of lines) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ["category", "method", "ms", "route", "status"]);
});
