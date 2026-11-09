// Injected into the active tab on toolbar click (activeTab + scripting).
// Owns the picker, the selection snapshot, and preview application.
//
// Preview model: the page's original element is never moved or mutated beyond
// being hidden. Each applied change builds a new clone of the current state,
// mutates it while detached (so a failing op leaves the page untouched), and
// shows it right after the hidden original. Keeping the original in place
// means frameworks like React can still update or replace it without
// crashing; if they replace it, the preview is dropped and the user reselects.
// ponytail: the extra sibling can shift :nth-child / sibling selectors while
// previewing; acceptable for a preview, revisit if users hit it.

import { ALLOWED_TAGS, validatePreview, type NewNode, type PreviewOp } from "@pagepatch/shared";

declare global { interface Window { __pagepatch?: { pick(): void } } }

if (window.__pagepatch) {
  window.__pagepatch.pick();
} else {
  main();
}

function main() {
  const ID = "data-pp-id";
  let port: chrome.runtime.Port | null = null;
  let orig: Element | null = null;        // the page's real element
  let pristine: Element | null = null;    // detached clone with ids, never mutated
  let live: Element | null = null;        // preview clone shown after the hidden original (null = no preview)
  let stack: (Element | null)[] = [];     // previous `live` values for undo
  let origDisplay: [string, string] | null = null; // orig's inline display value/priority before hiding
  let nextId = 0;
  // Bumped on every selection/preview state change; a proposal only applies to the state it was made for.
  let version = 0;
  // Image sources already in the selection. Model-set src must be one of these or a same-origin path,
  // so applying a preview can't make the browser request an attacker-chosen URL.
  let allowedSrc = new Set<string>();

  // ---- messaging ----

  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: "pagepatch-content" });
      port.onDisconnect.addListener(() => { port = null; });
    } catch { port = null; }
  }
  const send = (msg: object) => { connect(); try { port?.postMessage(msg); } catch { /* panel closed */ } };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    try {
      reply(handle(msg));
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  function handle(msg: any): object {
    switch (msg?.type) {
      case "hello": connect(); return { ok: true, selected: !!orig, label: orig ? label(orig) : null };
      case "pick": pick(); return { ok: true };
      case "parent": return selectParent();
      case "snapshot": return snapshot(msg.which === "pristine");
      case "apply": return apply(msg.ops, msg.version);
      case "undo": return undo();
      case "reset": reset(); version++; return { ok: true };
      case "clear": reset(); clearSelection(); stopPicking(); return { ok: true };
      default: return { ok: false, error: "unknown message" };
    }
  }

  // ---- picker (overlay lives in a closed shadow root so page CSS can't touch it) ----

  const host = document.createElement("pagepatch-overlay");
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  const tag = document.createElement("div");
  shadow.append(box, tag);
  const baseBox = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;";
  box.style.cssText = baseBox + "border:2px solid #2f6feb;background:rgba(47,111,235,.08);border-radius:2px;display:none";
  tag.style.cssText = baseBox + "font:12px/1.4 ui-monospace,Menlo,monospace;background:#2f6feb;color:#fff;padding:2px 6px;border-radius:3px;display:none";
  let picking = false;
  let hovered: Element | null = null;

  function place(el: Element | null) {
    if (!el) { box.style.display = tag.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = label(el);
    Object.assign(tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top - 22)}px` });
  }

  const onMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host && el !== document.documentElement && el !== document.body) { hovered = el; place(el); }
  };
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e: MouseEvent) => {
    swallow(e);
    if (hovered) select(hovered);
    stopPicking();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { swallow(e); stopPicking(); send({ type: "pickCancelled" }); }
    if (e.key === "ArrowUp" && hovered?.parentElement && hovered.parentElement !== document.body) {
      swallow(e); hovered = hovered.parentElement; place(hovered);
    }
  };

  function pick() {
    reset();
    clearSelection();
    if (!host.isConnected) document.documentElement.append(host);
    picking = true;
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("mousedown", swallow, true);
    addEventListener("pointerdown", swallow, true);
    addEventListener("keydown", onKey, true);
    send({ type: "picking" });
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousedown", swallow, true);
    removeEventListener("pointerdown", swallow, true);
    removeEventListener("keydown", onKey, true);
    place(null);
  }

  // ---- selection ----

  function label(el: Element) {
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
  }

  // Elements whose clones could load, run, or restyle the page if a model edited them. Stripped from the clone.
  const DANGEROUS = "script,style,link,iframe,frame,object,embed,base,meta,template,noscript,portal";
  // Emitted as leaves in snapshots; their descendants get no ids and can't be targeted.
  const LEAF = new Set(["svg", "math", "canvas", "select", "textarea", "video", "audio", "picture"]);

  function assignIds(root: Element) {
    const walk = (el: Element) => {
      if (el instanceof HTMLInputElement && el.type === "hidden") return;
      el.setAttribute(ID, `pp${nextId++}`);
      if (!LEAF.has(el.localName)) for (const c of el.children) walk(c);
    };
    walk(root);
  }

  function select(el: Element) {
    if (el.matches(DANGEROUS)) return;
    orig = el;
    nextId = 0;
    version++;
    pristine = el.cloneNode(true) as Element;
    pristine.querySelectorAll(DANGEROUS).forEach((d) => d.remove());
    assignIds(pristine);
    allowedSrc = new Set([...pristine.querySelectorAll("[src]")].map((e) => e.getAttribute("src")!));
    live = null;
    stack = [];
    const count = pristine.querySelectorAll("*").length + 1;
    send({ type: "selected", label: label(el), count, tooLarge: count > 1500 });
  }

  function selectParent() {
    const p = orig?.parentElement;
    if (!orig || !p || p === document.body || p === document.documentElement) return { ok: false, error: "No parent section to select." };
    // Parent selection resets any preview so the parent's clone reflects the real page.
    reset();
    select(p);
    return { ok: true };
  }

  function clearSelection() { orig = pristine = live = null; stack = []; }

  /** The visible node for this selection. */
  const current = () => live ?? orig;

  function hideOrig() {
    if (!orig || origDisplay) return;
    const s = (orig as HTMLElement).style;
    origDisplay = [s.getPropertyValue("display"), s.getPropertyPriority("display")];
    s.setProperty("display", "none", "important");
  }

  function showOrig() {
    if (!orig || !origDisplay) return;
    const s = (orig as HTMLElement).style;
    if (origDisplay[0]) s.setProperty("display", origDisplay[0], origDisplay[1]);
    else s.removeProperty("display");
    if (!s.length) orig.removeAttribute("style");
    origDisplay = null;
  }

  // Navigation clears the session. A full navigation unloads this script (the
  // panel sees the port disconnect); SPA route changes are caught by polling.
  // ponytail: 500ms poll; isolated worlds can't hook the page's history.pushState.
  // Back/forward cache restores the page as-is; never leave a preview behind with no panel to undo it.
  addEventListener("pagehide", () => { reset(); clearSelection(); stopPicking(); });

  let href = location.href;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      reset(); clearSelection(); stopPicking();
      send({ type: "navigated" });
    }
  }, 500);

  // A framework re-render can replace the selected node (or the page can remove our preview).
  new MutationObserver(() => {
    if (!orig) return;
    if (!orig.isConnected || (live && !live.isConnected)) {
      live?.remove();
      origDisplay = null;   // orig is gone or we no longer control it
      clearSelection();
      send({ type: "stale" });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- snapshot ----

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
  const KEEP_ATTRS = ["class", "id", "alt", "aria-label", "role", "title", "type", "placeholder"];
  const MAX_CHARS = 50_000;

  function cleanUrl(v: string) {
    try { const u = new URL(v, location.href); return u.origin === location.origin ? u.pathname : u.origin + u.pathname; }
    catch { return ""; }
  }

  function layoutHint(styleSrc: Element | null) {
    if (!styleSrc || !styleSrc.isConnected) return "";
    const s = getComputedStyle(styleSrc);
    if (s.display.includes("flex")) return `flex ${s.flexDirection}${s.flexWrap === "wrap" ? " wrap" : ""}${s.gap !== "normal" ? ` gap:${s.gap}` : ""}`;
    if (s.display.includes("grid")) return `grid cols:${s.gridTemplateColumns}${s.gap !== "normal" ? ` gap:${s.gap}` : ""}`;
    return "";
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  /** Simplified HTML of `el`. `styleSrc` is the same node in the live DOM (for layout hints), if any. */
  function serialize(el: Element, styleSrc: Element | null, depth: number, out: string[], budget: { n: number }) {
    if (budget.n <= 0 || SKIP.has(el.tagName)) return;
    if (el instanceof HTMLInputElement && el.type === "hidden") return;
    const t = el.tagName.toLowerCase();
    const attrs = [`${ID}="${el.getAttribute(ID)}"`];
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}="${esc(v.slice(0, 200))}"`);
    }
    for (const a of ["href", "src"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}="${esc(cleanUrl(v))}"`);
    }
    const layout = layoutHint(styleSrc);
    if (layout) attrs.push(`layout="${esc(layout)}"`);
    const pad = "  ".repeat(depth);
    const open = `${pad}<${t} ${attrs.join(" ")}>`;
    // Form controls: structure only, never values or option contents.
    if (LEAF.has(t) || t === "input") {
      out.push(open + (t === "input" ? "" : `</${t}>`));
      budget.n -= open.length;
      return;
    }
    out.push(open);
    budget.n -= open.length;
    const srcKids = styleSrc ? [...styleSrc.children] : [];
    let i = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent!.replace(/\s+/g, " ").trim();
        if (text) { const line = `${pad}  ${esc(text.slice(0, 300))}`; out.push(line); budget.n -= line.length; }
      } else if (node instanceof Element) {
        serialize(node, srcKids[i] ?? null, depth + 1, out, budget);
        i++;
      }
    }
    out.push(`${pad}</${t}>`);
  }

  function signals(root: Element) {
    const texts = new Set<string>(), classes = new Set<string>(), ids = new Set<string>();
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (SKIP.has(el.tagName) || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.tagName === "OPTION") continue;
      el.classList.forEach((c) => classes.add(c));
      if (el.id) ids.add(el.id);
      for (const n of el.childNodes) {
        const t = n.nodeType === Node.TEXT_NODE ? n.textContent!.replace(/\s+/g, " ").trim() : "";
        if (t.length >= 4) texts.add(t.slice(0, 120));
      }
    }
    return { texts: [...texts].slice(0, 30), classes: [...classes].slice(0, 30), ids: [...ids].slice(0, 10) };
  }

  function snapshot(usePristine: boolean) {
    if (!orig || !pristine) return { ok: false, error: "Select a section first." };
    if (!orig.isConnected) { clearSelection(); return { ok: false, error: "stale" }; }
    const root = usePristine || !live ? pristine : live;
    const styleSrc = usePristine || !live ? orig : live;
    const out: string[] = [];
    const budget = { n: MAX_CHARS };
    const parent = orig.parentElement;
    if (parent) {
      const siblings = parent.children.length;
      const index = [...parent.children].indexOf(orig);
      out.push(`<!-- selection is child ${index + 1} of ${siblings} inside <${parent.tagName.toLowerCase()}${parent.className && typeof parent.className === "string" ? ` class="${esc(parent.className.slice(0, 120))}"` : ""}>${layoutHint(parent) ? ` (${layoutHint(parent)})` : ""} -->`);
    }
    serialize(root, styleSrc, 0, out, budget);
    if (budget.n <= 0) return { ok: false, error: "This section is too large. Select a smaller section." };
    const ids = [root, ...root.querySelectorAll(`[${ID}]`)].map((e) => e.getAttribute(ID)!);
    return { ok: true, snapshot: out.join("\n"), ids, signals: signals(pristine), label: label(orig), version };
  }

  // ---- apply ----

  // Tags a model may set text or attributes on. Structure-only ops (style, remove, move) work on any id'd element.
  const EDITABLE_TAGS = new Set<string>([...ALLOWED_TAGS, "label", "td", "th", "caption", "dt", "dd", "summary", "legend", "mark", "abbr", "cite", "q", "time", "u", "s", "del", "ins"]);

  /** Attribute rules that depend on the element: href only on links, src only on images (see allowedSrc). */
  function attrError(tagName: string, name: string, value: string): string | null {
    if (name === "href" && tagName !== "a") return "href is only allowed on links";
    if (name === "src") {
      if (tagName !== "img") return "src is only allowed on images";
      const samePath = value.startsWith("/") && !value.startsWith("//") && !/[?#]/.test(value);
      if (!samePath && !allowedSrc.has(value)) return "new image sources must be a same-site path or an image already in the section";
    }
    return null;
  }

  function build(n: NewNode): Element {
    const el = document.createElement(n.tag);
    el.setAttribute(ID, `pp${nextId++}`);
    if (n.text) el.textContent = n.text;
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      const err = attrError(n.tag, k, v);
      if (err) throw new Error(err);
      el.setAttribute(k, v);
    }
    for (const [k, v] of Object.entries(n.styles ?? {})) el.style.setProperty(k, v);
    for (const c of n.children ?? []) el.append(build(c));
    return el;
  }

  function apply(rawOps: unknown, forVersion: unknown) {
    if (!orig || !pristine) return { ok: false, error: "Select a section first." };
    if (forVersion !== version) return { ok: false, error: "This proposal was made for an earlier state of the section. Send your message again." };
    const base = live ?? pristine;
    if (!orig.isConnected) { clearSelection(); return { ok: false, error: "stale" }; }
    const next = base.cloneNode(true) as Element;
    const byId = new Map<string, Element>();
    for (const el of [next, ...next.querySelectorAll(`[${ID}]`)]) byId.set(el.getAttribute(ID)!, el);

    // Independent validation: never trust the API.
    const v = validatePreview({ summary: "", ops: rawOps }, new Set(byId.keys()));
    if (!v.ok) return { ok: false, error: `Rejected unsafe change: ${v.error}` };

    for (const op of v.value.ops as PreviewOp[]) {
      let err: string | null;
      try { err = applyOp(next, byId, op); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      if (err) return { ok: false, error: `Rejected unsafe change: ${err}` };  // `next` is discarded; page untouched
    }
    if (live) live.replaceWith(next);
    else { hideOrig(); orig.after(next); }
    stack.push(live);
    live = next;
    version++;
    return { ok: true, canUndo: true };
  }

  function applyOp(root: Element, byId: Map<string, Element>, op: PreviewOp): string | null {
    if (op.op === "insert") {
      const parent = byId.get(op.parent)!;
      if (!(ALLOWED_TAGS as readonly string[]).includes(op.node.tag)) return "tag not allowed";
      if (parent.matches(DANGEROUS) || LEAF.has(parent.localName)) return `can't insert into <${parent.localName}>`;
      const node = build(op.node);
      parent.insertBefore(node, parent.children[op.index] ?? null);
      for (const el of [node, ...node.querySelectorAll(`[${ID}]`)]) byId.set(el.getAttribute(ID)!, el);
      return null;
    }
    const el = byId.get(op.target);
    if (!el || !root.contains(el)) return `element ${op.target} is no longer in the selection`;
    if (el.matches(DANGEROUS)) return `element ${op.target} can't be edited`;
    switch (op.op) {
      case "setText":
        if (!EDITABLE_TAGS.has(el.localName)) return `text of <${el.localName}> can't be edited`;
        if (el.children.length) return `${op.target} contains other elements; edit its children instead`;
        el.textContent = op.text;
        return null;
      case "setStyle":
        if (!(el instanceof HTMLElement)) return `element ${op.target} can't be styled`;
        for (const [k, val] of Object.entries(op.styles)) el.style.setProperty(k, val);
        return null;
      case "setAttr": {
        if (!EDITABLE_TAGS.has(el.localName)) return `attributes of <${el.localName}> can't be edited`;
        const err = attrError(el.localName, op.name, op.value);
        if (err) return err;
        el.setAttribute(op.name, op.value);
        return null;
      }
      case "remove":
        if (el === root) return "can't remove the selected section itself";
        el.remove();
        return null;
      case "move": {
        if (el === root) return "can't move the selected section itself";
        const parent = el.parentElement!;
        const siblings = [...parent.children].filter((c) => c !== el);
        parent.insertBefore(el, siblings[op.index] ?? null);
        return null;
      }
    }
  }

  function undo() {
    if (!live || !orig) return { ok: false, error: "Nothing to undo." };
    const prev = stack.pop() ?? null;
    if (prev) live.replaceWith(prev);
    else { live.remove(); showOrig(); }
    live = prev;
    version++;
    return { ok: true, canUndo: live !== null };
  }

  function reset() {
    live?.remove();
    showOrig();
    live = null;
    stack = [];
  }

  window.__pagepatch = { pick };
  connect();
  pick();
}
