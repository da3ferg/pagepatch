// Page side of the overlay: the picker, the selection snapshot, and preview application.
//
// Preview model: the page's original element is never moved or mutated beyond
// being hidden. Each applied change builds a new clone of the current state,
// mutates it while detached (so a failing op leaves the page untouched), and
// shows it right after the hidden original. Keeping the original in place
// means frameworks like React can still update or replace it without
// crashing; if they replace it, the preview is dropped and the user reselects.
//
// Several sections can carry previews at once. Picking a new section keeps the
// others; selecting inside a changed section resumes it. Sections never nest:
// a selection that would contain a changed section is refused.
// ponytail: the extra sibling can shift :nth-child / sibling selectors while
// previewing; acceptable for a preview, revisit if users hit it.

import { ALLOWED_TAGS, validatePreview, type NewNode, type PreviewOp } from "@pagepatch/shared";

export type PageEvent =
  | { type: "picking" }
  | { type: "selected"; id: number; label: string; count: number; tooLarge: boolean; resumed: boolean }
  | { type: "pickCancelled"; reason?: string }
  | { type: "stale"; id: number }
  | { type: "navigated" };

interface Section {
  id: number;
  orig: Element;                     // the page's real element
  pristine: Element;                 // detached clone with ids, never mutated
  live: Element | null;              // preview clone shown after the hidden original (null = no preview)
  stack: (Element | null)[];         // previous `live` values for undo
  origDisplay: [string, string] | null; // orig's inline display value/priority before hiding
  nextId: number;
  // Image sources already in the selection. Model-set src must be one of these or a same-origin path,
  // so applying a preview can't make the browser request an attacker-chosen URL.
  allowedSrc: Set<string>;
}

/**
 * `host` is the overlay's own element: events that land on it (the panel) are
 * never treated as page clicks while picking.
 */
export function createPage(host: HTMLElement, shadow: ShadowRoot, send: (e: PageEvent) => void) {
  const ID = "data-pp-id";
  const sections = new Map<number, Section>();
  let cur: Section | null = null;   // the section the panel is editing
  let seq = 0;
  // Bumped on every selection/preview state change; a proposal only applies to the state it was made for.
  let version = 0;

  // ---- picker (lives in the overlay's closed shadow root so page CSS can't touch it) ----

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
  // Events on the panel itself (retargeted to `host` by the shadow root) pass through.
  const swallow = (e: Event) => { if (e.target === host) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e: MouseEvent) => {
    if (e.target === host) return;
    swallow(e);
    const el = hovered;
    stopPicking();
    if (el) select(el); else send({ type: "pickCancelled" });
  };
  /** Esc cancels, ↑ grows to the parent. Returns true if the key was used. Also called for keys pressed in the panel. */
  function pickKey(key: string) {
    if (!picking) return false;
    if (key === "Escape") { stopPicking(); send({ type: "pickCancelled" }); return true; }
    if (key === "ArrowUp" && hovered?.parentElement && hovered.parentElement !== document.body) {
      hovered = hovered.parentElement; place(hovered); return true;
    }
    return false;
  }
  // Keys typed in the panel never reach this window (it's a separate iframe), so no host check here.
  const onKey = (e: KeyboardEvent) => {
    if (pickKey(e.key)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  };

  function pick() {
    leaveCurrent();
    hovered = null;
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

  function assignIds(sec: Section, root: Element) {
    const walk = (el: Element) => {
      if (el instanceof HTMLInputElement && el.type === "hidden") return;
      el.setAttribute(ID, `pp${sec.nextId++}`);
      if (!LEAF.has(el.localName)) for (const c of el.children) walk(c);
    };
    walk(root);
  }

  /** Stop editing the current section. It stays on the page only if it has a preview. */
  function leaveCurrent() {
    if (cur && !cur.live) sections.delete(cur.id);
    cur = null;
    version++;
  }

  function select(el: Element) {
    if (el.matches(DANGEROUS)) { send({ type: "pickCancelled", reason: `<${el.localName}> can't be edited. Pick the section around it.` }); return; }
    // Inside a changed section: pick up where it left off.
    for (const sec of sections.values()) {
      if (sec.live?.contains(el)) {
        cur = sec;
        version++;
        send({ type: "selected", id: sec.id, label: label(sec.orig), count: sec.pristine.querySelectorAll("*").length + 1, tooLarge: false, resumed: true });
        return;
      }
    }
    for (const sec of sections.values()) {
      if (sec.live && (el.contains(sec.orig) || el.contains(sec.live))) {
        send({ type: "pickCancelled", reason: `That area contains ${label(sec.orig)}, which you already changed. Click inside it to keep editing it, or pick a smaller section.` });
        return;
      }
    }
    const pristine = el.cloneNode(true) as Element;
    pristine.querySelectorAll(DANGEROUS).forEach((d) => d.remove());
    const sec: Section = { id: ++seq, orig: el, pristine, live: null, stack: [], origDisplay: null, nextId: 0, allowedSrc: new Set() };
    assignIds(sec, pristine);
    sec.allowedSrc = new Set([...pristine.querySelectorAll("[src]")].map((e) => e.getAttribute("src")!));
    sections.set(sec.id, sec);
    cur = sec;
    version++;
    const count = pristine.querySelectorAll("*").length + 1;
    send({ type: "selected", id: sec.id, label: label(el), count, tooLarge: count > 1500, resumed: false });
  }

  function selectParent() {
    if (!cur) return { ok: false, error: "Select a section first." };
    if (cur.live) return { ok: false, error: "This section has changes. Reset them first, or pick a different section." };
    const p = cur.orig.parentElement;
    if (!p || p === document.body || p === document.documentElement) return { ok: false, error: "No parent section to select." };
    leaveCurrent();
    select(p);
    return { ok: true };
  }

  function hideOrig(sec: Section) {
    if (sec.origDisplay) return;
    const s = (sec.orig as HTMLElement).style;
    sec.origDisplay = [s.getPropertyValue("display"), s.getPropertyPriority("display")];
    s.setProperty("display", "none", "important");
  }

  function showOrig(sec: Section) {
    if (!sec.origDisplay) return;
    const s = (sec.orig as HTMLElement).style;
    if (sec.origDisplay[0]) s.setProperty("display", sec.origDisplay[0], sec.origDisplay[1]);
    else s.removeProperty("display");
    if (!s.length) sec.orig.removeAttribute("style");
    sec.origDisplay = null;
  }

  /** Remove every preview and forget every section. */
  function clearAll() {
    for (const sec of sections.values()) resetSection(sec);
    sections.clear();
    cur = null;
    version++;
  }

  // Navigation clears the session. A full navigation reloads the overlay;
  // SPA route changes are caught by polling.
  // ponytail: 500ms poll instead of patching the app's history.pushState.
  // Back/forward cache restores the page as-is; never leave a preview behind with no panel to undo it.
  addEventListener("pagehide", () => { clearAll(); stopPicking(); });

  let href = location.href;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      clearAll(); stopPicking();
      send({ type: "navigated" });
    }
  }, 500);

  // A framework re-render can replace a section's node (or the page can remove our preview).
  new MutationObserver(() => {
    for (const sec of [...sections.values()]) {
      if (sec.orig.isConnected && (!sec.live || sec.live.isConnected)) continue;
      sec.live?.remove();
      if (sec.orig.isConnected) showOrig(sec);   // only the preview was removed: give the page its element back
      sections.delete(sec.id);   // orig is gone or we no longer control it
      if (cur === sec) { cur = null; version++; }
      send({ type: "stale", id: sec.id });
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

  /** Simplified HTML of a section (the current one unless `id` is given), before or after its preview. */
  function snapshot(usePristine: boolean, id?: number) {
    const sec = id === undefined ? cur : sections.get(id);
    if (!sec) return { ok: false, error: id === undefined ? "Select a section first." : "stale" };
    if (!sec.orig.isConnected) return { ok: false, error: "stale" };
    const { orig, pristine, live } = sec;
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
    return { ok: true, snapshot: out.join("\n"), ids, signals: signals(pristine), label: label(orig), version, id: sec.id };
  }

  // ---- apply ----

  // Tags a model may set text or attributes on. Structure-only ops (style, remove, move) work on any id'd element.
  const EDITABLE_TAGS = new Set<string>([...ALLOWED_TAGS, "label", "td", "th", "caption", "dt", "dd", "summary", "legend", "mark", "abbr", "cite", "q", "time", "u", "s", "del", "ins"]);

  /** Attribute rules that depend on the element: href only on links, src only on images (see allowedSrc). */
  function attrError(allowedSrc: Set<string>, tagName: string, name: string, value: string): string | null {
    if (name === "href" && tagName !== "a") return "href is only allowed on links";
    if (name === "src") {
      if (tagName !== "img") return "src is only allowed on images";
      // Browsers read "/\host" as "//host", so backslashes are refused along with "//".
      const samePath = value.startsWith("/") && !value.startsWith("//") && !/[?#\\]/.test(value);
      if (!samePath && !allowedSrc.has(value)) return "new image sources must be a same-site path or an image already in the section";
    }
    return null;
  }

  function build(sec: Section, n: NewNode): Element {
    const el = document.createElement(n.tag);
    el.setAttribute(ID, `pp${sec.nextId++}`);
    if (n.text) el.textContent = n.text;
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      const err = attrError(sec.allowedSrc, n.tag, k, v);
      if (err) throw new Error(err);
      el.setAttribute(k, v);
    }
    for (const [k, v] of Object.entries(n.styles ?? {})) el.style.setProperty(k, v);
    for (const c of n.children ?? []) el.append(build(sec, c));
    return el;
  }

  function apply(rawOps: unknown, forVersion: unknown) {
    const sec = cur;
    if (!sec) return { ok: false, error: "Select a section first." };
    if (forVersion !== version) return { ok: false, error: "This proposal was made for an earlier state of the section. Send your message again." };
    const base = sec.live ?? sec.pristine;
    if (!sec.orig.isConnected) return { ok: false, error: "stale" };
    const next = base.cloneNode(true) as Element;
    const byId = new Map<string, Element>();
    for (const el of [next, ...next.querySelectorAll(`[${ID}]`)]) byId.set(el.getAttribute(ID)!, el);

    // Independent validation: never trust the API.
    const v = validatePreview({ summary: "", ops: rawOps }, new Set(byId.keys()));
    if (!v.ok) return { ok: false, error: `Rejected unsafe change: ${v.error}` };

    for (const op of v.value.ops as PreviewOp[]) {
      let err: string | null;
      try { err = applyOp(sec, next, byId, op); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      if (err) return { ok: false, error: `Rejected unsafe change: ${err}` };  // `next` is discarded; page untouched
    }
    if (sec.live) sec.live.replaceWith(next);
    else { hideOrig(sec); sec.orig.after(next); }
    sec.stack.push(sec.live);
    sec.live = next;
    version++;
    return { ok: true, canUndo: true };
  }

  function applyOp(sec: Section, root: Element, byId: Map<string, Element>, op: PreviewOp): string | null {
    if (op.op === "insert") {
      const parent = byId.get(op.parent)!;
      if (!(ALLOWED_TAGS as readonly string[]).includes(op.node.tag)) return "tag not allowed";
      if (parent.matches(DANGEROUS) || LEAF.has(parent.localName)) return `can't insert into <${parent.localName}>`;
      const node = build(sec, op.node);
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
        const err = attrError(sec.allowedSrc, el.localName, op.name, op.value);
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
    const sec = cur;
    if (!sec?.live) return { ok: false, error: "Nothing to undo." };
    const prev = sec.stack.pop() ?? null;
    if (prev) sec.live.replaceWith(prev);
    else { sec.live.remove(); showOrig(sec); }
    sec.live = prev;
    version++;
    return { ok: true, canUndo: sec.live !== null };
  }

  function resetSection(sec: Section) {
    sec.live?.remove();
    showOrig(sec);
    sec.live = null;
    sec.stack = [];
  }

  return { pick, pickKey, stopPicking, selectParent, snapshot, apply, undo,
    /** Reset the current section's preview; other sections keep theirs. */
    reset() { if (cur) resetSection(cur); version++; },
    clear() { clearAll(); stopPicking(); } };
}
