// Preview operations: the only things a model response can do to a page.
// Every op targets a node by its picker-assigned id (`data-pp-id`) inside the
// selection. Both the API and the extension validate with this module; the
// extension never trusts the API's validation.

export const ALLOWED_TAGS = [
  "a", "article", "aside", "b", "blockquote", "br", "button", "code", "div", "em",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "i", "img", "li", "main", "nav", "ol", "p", "pre", "section", "small",
  "span", "strong", "sub", "sup", "ul",
] as const;

export const ALLOWED_CSS = [
  "align-items", "align-self", "background-color", "border", "border-color",
  "border-radius", "border-style", "border-width", "box-shadow", "color",
  "column-gap", "display", "flex", "flex-basis", "flex-direction", "flex-grow",
  "flex-shrink", "flex-wrap", "font-family", "font-size", "font-style",
  "font-weight", "gap", "grid-column", "grid-row", "grid-template-columns",
  "grid-template-rows", "height", "justify-content", "justify-items",
  "letter-spacing", "line-height", "margin", "margin-bottom", "margin-left",
  "margin-right", "margin-top", "max-height", "max-width", "min-height",
  "min-width", "opacity", "order", "padding", "padding-bottom", "padding-left",
  "padding-right", "padding-top", "row-gap", "text-align", "text-decoration",
  "text-transform", "width",
] as const;

// Attributes a model may set on created/edited elements. No event handlers,
// no style (styles go through setStyle), no src/href schemes beyond http(s)/relative.
export const ALLOWED_ATTRS = ["alt", "aria-label", "class", "href", "src", "title"] as const;

export type Tag = (typeof ALLOWED_TAGS)[number];
export type CssProp = (typeof ALLOWED_CSS)[number];

export interface NewNode {
  tag: Tag;
  text?: string;
  attrs?: Record<string, string>;
  styles?: Record<string, string>;
  children?: NewNode[];
}

export type PreviewOp =
  | { op: "setText"; target: string; text: string }
  | { op: "setStyle"; target: string; styles: Record<string, string> }
  | { op: "setAttr"; target: string; name: string; value: string }
  | { op: "insert"; parent: string; index: number; node: NewNode }
  | { op: "remove"; target: string }
  | { op: "move"; target: string; index: number };

export interface PreviewResponse {
  summary: string;
  ops: PreviewOp[];
}

const MAX_OPS = 50;
const MAX_TEXT = 2000;
const MAX_DEPTH = 4;
const MAX_NEW_NODES = 40;
const ID_RE = /^pp\d{1,5}$/;
// CSS values: no url(), expression(), escapes, or anything that closes a declaration.
const BAD_CSS_VALUE = /url\s*\(|expression|javascript:|[\\;{}<>@]|\/\*/i;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkStyles(v: unknown): string | null {
  if (!isObj(v)) return "styles must be an object";
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > 30) return "styles must have 1-30 properties";
  for (const [k, val] of entries) {
    if (!(ALLOWED_CSS as readonly string[]).includes(k)) return `css property not allowed: ${k}`;
    if (typeof val !== "string" || val.length > 200 || BAD_CSS_VALUE.test(val))
      return `css value not allowed for ${k}`;
  }
  return null;
}

export function safeUrl(value: string): boolean {
  const v = value.trim();
  if (v.startsWith("/") || v.startsWith("#") || v.startsWith("./")) return !v.startsWith("//");
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function checkAttr(name: unknown, value: unknown): string | null {
  if (typeof name !== "string" || !(ALLOWED_ATTRS as readonly string[]).includes(name))
    return `attribute not allowed: ${String(name)}`;
  if (typeof value !== "string" || value.length > 500) return `bad value for ${name}`;
  if ((name === "href" || name === "src") && !safeUrl(value)) return `unsafe url in ${name}`;
  return null;
}

function checkNode(n: unknown, depth: number, count: { n: number }): string | null {
  if (!isObj(n)) return "node must be an object";
  if (++count.n > MAX_NEW_NODES) return "too many new nodes";
  if (depth > MAX_DEPTH) return "node nesting too deep";
  if (!(ALLOWED_TAGS as readonly string[]).includes(n.tag as string)) return `tag not allowed: ${String(n.tag)}`;
  if (n.text !== undefined && (typeof n.text !== "string" || n.text.length > MAX_TEXT)) return "bad node text";
  if (n.attrs !== undefined) {
    if (!isObj(n.attrs)) return "attrs must be an object";
    for (const [k, v] of Object.entries(n.attrs)) {
      const e = checkAttr(k, v);
      if (e) return e;
    }
  }
  if (n.styles !== undefined) {
    const e = checkStyles(n.styles);
    if (e) return e;
  }
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) return "children must be an array";
    for (const c of n.children) {
      const e = checkNode(c, depth + 1, count);
      if (e) return e;
    }
  }
  return null;
}

const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1000;

/** Validate untrusted model output. `ids` is the set of node ids inside the selection. */
export function validatePreview(raw: unknown, ids: ReadonlySet<string>): Result<PreviewResponse> {
  if (!isObj(raw)) return fail("response must be an object");
  const { summary, ops } = raw;
  if (typeof summary !== "string" || summary.length > 1000) return fail("bad summary");
  if (!Array.isArray(ops) || ops.length > MAX_OPS) return fail(`ops must be an array of at most ${MAX_OPS}`);
  const count = { n: 0 };
  const known = (id: unknown) => isId(id) && ids.has(id);
  for (const [i, op] of ops.entries()) {
    if (!isObj(op)) return fail(`op ${i}: not an object`);
    let e: string | null = null;
    switch (op.op) {
      case "setText":
        if (!known(op.target)) e = "unknown target";
        else if (typeof op.text !== "string" || op.text.length > MAX_TEXT) e = "bad text";
        break;
      case "setStyle":
        e = known(op.target) ? checkStyles(op.styles) : "unknown target";
        break;
      case "setAttr":
        e = known(op.target) ? checkAttr(op.name, op.value) : "unknown target";
        break;
      case "insert":
        if (!known(op.parent)) e = "unknown parent";
        else if (!isIndex(op.index)) e = "bad index";
        else e = checkNode(op.node, 1, count);
        break;
      case "remove":
        if (!known(op.target)) e = "unknown target";
        break;
      case "move":
        if (!known(op.target)) e = "unknown target";
        else if (!isIndex(op.index)) e = "bad index";
        break;
      default:
        e = `unknown op: ${String(op.op)}`;
    }
    if (e) return fail(`op ${i}: ${e}`);
  }
  return { ok: true, value: { summary, ops: ops as PreviewOp[] } };
}

// ---- Source edit proposals ----

export const EDITABLE_EXT = /\.(html?|css|scss|jsx|tsx|js|ts)$/i;

export interface SourceEdit {
  path: string;
  // Exact-match search/replace keeps the model from rewriting whole files.
  search: string;
  replace: string;
}

export interface SourceProposal {
  summary: string;
  edits: SourceEdit[];
}

export function validateSourceProposal(raw: unknown, allowedPaths: ReadonlySet<string>): Result<SourceProposal> {
  if (!isObj(raw)) return fail("response must be an object");
  const { summary, edits } = raw;
  if (typeof summary !== "string" || summary.length > 1000) return fail("bad summary");
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 20) return fail("edits must have 1-20 items");
  for (const [i, ed] of edits.entries()) {
    if (!isObj(ed)) return fail(`edit ${i}: not an object`);
    if (typeof ed.path !== "string" || !allowedPaths.has(ed.path)) return fail(`edit ${i}: path not in candidate files`);
    if (!EDITABLE_EXT.test(ed.path)) return fail(`edit ${i}: file type not editable`);
    if (typeof ed.search !== "string" || ed.search.length === 0 || ed.search.length > 20000) return fail(`edit ${i}: bad search`);
    if (typeof ed.replace !== "string" || ed.replace.length > 20000) return fail(`edit ${i}: bad replace`);
  }
  return { ok: true, value: { summary, edits: edits as SourceEdit[] } };
}

// JSON Schemas handed to the providers' structured-output modes. Kept loose
// (string maps as arrays of pairs) because both providers' strict modes reject
// open-ended objects; the extension converts pairs back before validating.
const pairs = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" }, value: { type: "string" } },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

// Expanded rather than recursive ($ref recursion is poorly supported); leaf nodes have no children.
const nodeSchema = (depth: number): object => {
  const props: Record<string, object> = {
    tag: { type: "string", enum: [...ALLOWED_TAGS] },
    text: { type: "string" },
    attrs: pairs,
    styles: pairs,
  };
  if (depth > 1) props.children = { type: "array", items: nodeSchema(depth - 1) };
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
};

// One flat op shape with all fields required (strict-mode friendly); unused fields are "" / [] / -1.
export const PREVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["setText", "setStyle", "setAttr", "insert", "remove", "move"] },
          target: { type: "string" },
          text: { type: "string" },
          styles: pairs,
          name: { type: "string" },
          value: { type: "string" },
          parent: { type: "string" },
          index: { type: "integer" },
          node: { anyOf: [nodeSchema(3), { type: "null" }] },
        },
        required: ["op", "target", "text", "styles", "name", "value", "parent", "index", "node"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "ops"],
  additionalProperties: false,
} as const;

export const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } },
        required: ["path", "search", "replace"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "edits"],
  additionalProperties: false,
} as const;

type Pair = { name: string; value: string };
const toMap = (p: unknown) =>
  Array.isArray(p) ? Object.fromEntries((p as Pair[]).map((x) => [x?.name, x?.value])) : p;

function normNode(n: any): any {
  if (!isObj(n)) return n;
  const out: any = { tag: n.tag };
  if (n.text) out.text = n.text;
  if (Array.isArray(n.attrs) && n.attrs.length) out.attrs = toMap(n.attrs);
  if (Array.isArray(n.styles) && n.styles.length) out.styles = toMap(n.styles);
  if (Array.isArray(n.children) && n.children.length) out.children = n.children.map(normNode);
  return out;
}

/** Convert the flat strict-schema op shape back into a PreviewOp before validation. */
export function normalizePreview(raw: any): unknown {
  if (!isObj(raw) || !Array.isArray(raw.ops)) return raw;
  return {
    summary: raw.summary,
    ops: raw.ops.map((o: any) => {
      if (!isObj(o)) return o;
      switch (o.op) {
        case "setText": return { op: o.op, target: o.target, text: o.text };
        case "setStyle": return { op: o.op, target: o.target, styles: toMap(o.styles) };
        case "setAttr": return { op: o.op, target: o.target, name: o.name, value: o.value };
        case "insert": return { op: o.op, parent: o.parent, index: o.index, node: normNode(o.node) };
        case "remove": return { op: o.op, target: o.target };
        case "move": return { op: o.op, target: o.target, index: o.index };
        default: return o;
      }
    }),
  };
}
