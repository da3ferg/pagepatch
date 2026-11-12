import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, unifiedDiff } from "./patch.ts";
import { eligible, isAmbiguous, isEditableSource, rankPaths, scoreContents } from "./search.ts";

test("applyEdits requires a unique exact match", () => {
  const files = new Map([["src/Hero.tsx", "<h1>Hello</h1>\n<p>Hello</p>\n"]]);
  assert.equal(applyEdits(files, [{ path: "src/Hero.tsx", search: "Hello", replace: "Hi" }]).ok, false);
  assert.equal(applyEdits(files, [{ path: "src/Hero.tsx", search: "Nope", replace: "Hi" }]).ok, false);
  const r = applyEdits(files, [{ path: "src/Hero.tsx", search: "<h1>Hello</h1>", replace: "<h1>Hi</h1>" }]);
  assert.ok(r.ok);
  const d = unifiedDiff(r.changes);
  assert.match(d, /-<h1>Hello<\/h1>/);
  assert.match(d, /\+<h1>Hi<\/h1>/);
});

test("eligible skips build output and non-source files", () => {
  const got = eligible([
    { path: "src/Hero.tsx", size: 10 },
    { path: "node_modules/x/index.js", size: 10 },
    { path: "dist/app.css", size: 10 },
    { path: "README.md", size: 10 },
    { path: "src/Hero.test.tsx", size: 10 },
  ]).map((e) => e.path);
  assert.deepEqual(got, ["src/Hero.tsx"]);
});

test("ranking prefers files with the visible text", () => {
  const sig = { texts: ["Ship faster with PagePatch"], classes: ["hero"], ids: [], tags: ["section"] };
  const ranked = rankPaths([{ path: "src/Footer.tsx", size: 1 }, { path: "src/Hero.tsx", size: 1 }], sig);
  assert.equal(ranked[0].path, "src/Hero.tsx");
  const a = scoreContents("src/Hero.tsx", `export const Hero = () => (<section className="hero"><h1>Ship faster with PagePatch</h1></section>);`, sig);
  const b = scoreContents("src/Footer.tsx", `export function Footer() { return <footer className="footer">x</footer>; }`, sig);
  assert.ok(a.score > b.score);
  assert.equal(isAmbiguous([a, b]), false);
  assert.equal(isAmbiguous([b]), true);
});

test("only HTML, CSS, and JSX-rendering modules are editable", () => {
  assert.equal(isEditableSource("src/a.css", ""), true);
  assert.equal(isEditableSource("src/Card.jsx", "export default function Card() { return (<div/>); }"), true);
  assert.equal(isEditableSource("vite.config.ts", "export default { server: { port: 3000 } };"), false);
  assert.equal(isEditableSource("server/auth.ts", "if (a < b) return token;"), false);
});
