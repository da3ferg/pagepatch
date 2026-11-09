import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreview, validatePreview, validateSourceProposal } from "./index.ts";

const ids = new Set(["pp1", "pp2", "pp3"]);
const ok = (ops: unknown[]) => validatePreview({ summary: "s", ops }, ids);

test("accepts allowed ops", () => {
  const r = ok([
    { op: "setText", target: "pp2", text: "Hi" },
    { op: "setStyle", target: "pp1", styles: { display: "grid", gap: "8px" } },
    { op: "insert", parent: "pp1", index: 0, node: { tag: "p", text: "new", attrs: { class: "x" } } },
    { op: "move", target: "pp3", index: 0 },
    { op: "remove", target: "pp2" },
  ]);
  assert.equal(r.ok, true);
});

test("rejects targets outside the selection", () => {
  assert.equal(ok([{ op: "remove", target: "pp99" }]).ok, false);
  assert.equal(ok([{ op: "remove", target: "body" }]).ok, false);
});

test("rejects script-capable output", () => {
  assert.equal(ok([{ op: "insert", parent: "pp1", index: 0, node: { tag: "script", text: "x" } }]).ok, false);
  assert.equal(ok([{ op: "insert", parent: "pp1", index: 0, node: { tag: "iframe" } }]).ok, false);
  assert.equal(ok([{ op: "setAttr", target: "pp1", name: "onclick", value: "x" }]).ok, false);
  assert.equal(ok([{ op: "setAttr", target: "pp1", name: "href", value: "javascript:alert(1)" }]).ok, false);
  assert.equal(ok([{ op: "setAttr", target: "pp1", name: "src", value: "//evil.com/x" }]).ok, false);
  assert.equal(ok([{ op: "setStyle", target: "pp1", styles: { "background-image": "url(x)" } }]).ok, false);
  assert.equal(ok([{ op: "setStyle", target: "pp1", styles: { color: "red; position: fixed" } }]).ok, false);
  assert.equal(ok([{ op: "setStyle", target: "pp1", styles: { position: "fixed" } }]).ok, false);
});

test("rejects malformed responses", () => {
  assert.equal(validatePreview(null, ids).ok, false);
  assert.equal(validatePreview({ summary: "s" }, ids).ok, false);
  assert.equal(ok([{ op: "eval", target: "pp1" }]).ok, false);
  assert.equal(ok([{ op: "move", target: "pp1", index: -1 }]).ok, false);
});

test("normalizes strict-schema shape", () => {
  const raw = {
    summary: "s",
    ops: [
      { op: "setStyle", target: "pp1", text: "", styles: [{ name: "color", value: "red" }], name: "", value: "", parent: "", index: -1, node: null },
      { op: "insert", target: "", text: "", styles: [], name: "", value: "", parent: "pp1", index: 1,
        node: { tag: "li", text: "x", attrs: [], styles: [], children: [] } },
    ],
  };
  const r = validatePreview(normalizePreview(raw), ids);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("source proposals limited to candidate files", () => {
  const paths = new Set(["src/Hero.tsx", "README.md"]);
  assert.equal(validateSourceProposal({ summary: "s", edits: [{ path: "src/Hero.tsx", search: "a", replace: "b" }] }, paths).ok, true);
  assert.equal(validateSourceProposal({ summary: "s", edits: [{ path: "README.md", search: "a", replace: "b" }] }, paths).ok, false);
  assert.equal(validateSourceProposal({ summary: "s", edits: [{ path: ".github/workflows/x.yml", search: "a", replace: "b" }] }, paths).ok, false);
});
