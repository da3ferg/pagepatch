// The PagePatch panel. Runs in an iframe served from the panel port, a different
// origin from the page, so page scripts can't read the token, call the API, or
// click its buttons. It drives the page through postMessage to overlay.ts.
// All dynamic text is rendered with textContent, never innerHTML.

import type { PreviewOp } from "@pagepatch/shared";
import type { PageEvent } from "./page.ts";

type Turn = { role: "user" | "assistant"; content: string };
const meta = document.querySelector<HTMLMetaElement>('meta[name="pagepatch"]')!;
const token = meta.dataset.token!;
const parentOrigin = meta.dataset.parent!;   // checked by the server against the proxy's own origins


function main() {
  // ---------- DOM ----------

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  document.adoptedStyleSheets = [sheet];

  function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
    const el = document.createElement(tag);
    const { class: cls, ...rest } = props;
    if (cls) el.className = cls;
    Object.assign(el, rest);
    el.append(...kids);
    return el;
  }

  const status = h("p", { class: "status" });
  status.setAttribute("role", "status");
  const selLabel = h("code");
  const reselect = h("button", { class: "quiet small", textContent: "Select again" });
  const parent = h("button", { class: "quiet small", textContent: "Select parent" });
  const selection = h("div", { class: "selection-line" }, selLabel, h("span", { class: "row tight" }, reselect, parent));
  const conversation = h("ol", { class: "conversation" });
  conversation.setAttribute("aria-live", "polite");
  const proposal = h("p", { class: "proposal" });
  const applyBtn = h("button", { textContent: "Apply preview" });
  const undoBtn = h("button", { class: "quiet", textContent: "Undo" });
  const resetBtn = h("button", { class: "quiet", textContent: "Reset" });
  const previewControls = h("div", { class: "row" }, applyBtn, undoBtn, resetBtn);
  const prompt = h("textarea", { rows: 3, placeholder: "Describe a change, e.g. “make this a 3-column grid and tighten the copy”" });
  prompt.setAttribute("aria-label", "Describe a change");
  const sendBtn = h("button", { type: "submit", textContent: "Send" });
  const composer = h("form", {}, prompt, h("div", { class: "row" }, sendBtn));

  const generateBtn = h("button", { textContent: "Generate source patch" });
  const candidateList = h("ul", { class: "candidates" });
  const manualPath = h("input", { placeholder: "src/components/Hero.tsx", spellcheck: false });
  const usePath = h("button", { class: "quiet", textContent: "Use path" });
  const candidateHint = h("p", { class: "hint" });
  const candidates = h("div", {}, candidateHint, candidateList, h("div", { class: "row" }, manualPath, usePath));
  const diffSummary = h("p");
  const diffFiles = h("span");
  const diff = h("pre", { tabIndex: 0 });
  const writeBtn = h("button", { textContent: "Write to files" });
  const diffView = h("div", {},
    diffSummary, h("p", { class: "hint" }, "Files: ", diffFiles), diff,
    h("p", { class: "hint", textContent: "Nothing is written until you click Write. Use git to review or revert." }),
    h("div", { class: "row" }, writeBtn));
  const changedList = h("p", { class: "hint" });
  const source = h("section", {}, h("h2", { textContent: "Save to source" }), changedList, h("div", { class: "row" }, generateBtn), candidates, diffView);

  // Configure: which model to use. Your Claude Code or Codex login first; an API key is the minor option.
  const choice = (value: string, title: string, note: string) => {
    const input = h("input", { type: "radio", name: "provider", value });
    const noteEl = h("small", { textContent: note });
    return { input, noteEl, row: h("label", { class: "choice" }, input, h("span", {}, title, " ", noteEl)) };
  };
  const choices = {
    "claude-code": choice("claude-code", "Claude Code", "uses your Claude login"),
    codex: choice("codex", "Codex", "uses your ChatGPT login"),
    anthropic: choice("anthropic", "Anthropic", "API key"),
    openai: choice("openai", "OpenAI", "API key"),
  };
  const modelInput = h("input", { spellcheck: false, autocomplete: "off" });
  modelInput.setAttribute("aria-label", "Model");
  const keyInput = h("input", { type: "password", spellcheck: false, autocomplete: "off", placeholder: "Paste your key" });
  keyInput.setAttribute("aria-label", "API key");
  const keyRow = h("div", {}, keyInput, h("p", { class: "hint", textContent: "Kept in memory by pagepatch on this computer until it stops. Never saved to disk or shown again." }));
  const keysToggle = h("button", { class: "link", textContent: "Use an API key instead" });
  const keyChoices = h("div", { class: "key-choices" }, choices.anthropic.row, choices.openai.row, keyRow);
  const saveConfig = h("button", { textContent: "Save" });
  const configure = h("section", { class: "configure" },
    h("h2", { textContent: "Model" }),
    choices["claude-code"].row, choices.codex.row,
    h("p", { class: "hint" }, keysToggle), keyChoices,
    h("label", { class: "field" }, "Model ", modelInput),
    h("div", { class: "row" }, saveConfig));
  const configureBtn = h("button", { class: "link", textContent: "Configure" });
  configureBtn.setAttribute("aria-expanded", "false");

  const closeBtn = h("button", { class: "link", textContent: "Close", title: "Close PagePatch and restore the page" });
  const panel = h("main", { class: "panel" },
    h("header", {}, h("h1", { textContent: "PagePatch" }), h("span", { class: "header-links" }, configureBtn, closeBtn)),
    configure, status, selection, conversation, proposal, previewControls, composer, source);
  document.body.append(panel);

  // ---------- state ----------

  // One entry per section the page is tracking (page.ts keeps the previews; this keeps the conversations).
  interface Sec { label: string; conversation: Turn[]; applied: PreviewOp[][]; paths?: string[] }
  const sections = new Map<number, Sec>();
  const state = {
    curId: null as number | null,     // section being edited
    lost: true,                        // nothing selected; offer "Select again"
    pending: null as PreviewOp[] | null,
    pendingVersion: -1,                // page state the pending proposal was made for
    proposalId: null as string | null,
    choosingFor: null as number | null, // section whose source file the user is picking
    busy: false,
  };
  const cs = () => (state.curId === null ? null : sections.get(state.curId) ?? null);
  const changed = () => [...sections].filter(([, s]) => s.applied.length > 0);

  // ---------- page bridge ----------

  const parent_ = window.parent;
  let nextCall = 0;
  const waiting = new Map<number, (r: any) => void>();
  /** Run a page.ts function in the page and get its result. */
  const call = (cmd: string, ...args: unknown[]): Promise<any> => new Promise((resolve) => {
    const id = ++nextCall;
    waiting.set(id, resolve);
    parent_.postMessage({ pp: 1, id, cmd, args }, parentOrigin);
  });
  addEventListener("message", (e) => {
    if (e.source !== parent_ || e.origin !== parentOrigin || e.data?.pp !== 1) return;
    if (e.data.event) onPageEvent(e.data.event as PageEvent);
    else if (waiting.has(e.data.id)) { waiting.get(e.data.id)!(e.data.result); waiting.delete(e.data.id); }
  });

  const PICK_HINT = "Click a section on the page. Press ↑ to grow the selection, Esc to cancel.";
  const STALE = "The page replaced the selected section. Select it again.";

  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function render() {
    const sec = cs();
    selection.hidden = !sec && !state.lost;
    parent.disabled = !sec;
    composer.hidden = previewControls.hidden = !sec;
    proposal.hidden = !state.pending;
    applyBtn.disabled = !state.pending || state.busy;
    undoBtn.disabled = resetBtn.disabled = !sec?.applied.length || state.busy;
    sendBtn.disabled = generateBtn.disabled = state.busy;
    const done = changed();
    source.hidden = done.length === 0;
    changedList.textContent = done.length ? `Changed: ${done.map(([, s]) => s.label).join(", ")}` : "";
    candidates.hidden = state.choosingFor === null;
    diffView.hidden = !state.proposalId;
    writeBtn.disabled = state.busy || !state.proposalId;
    panel.toggleAttribute("aria-busy", state.busy);
    conversation.replaceChildren(...(sec?.conversation ?? []).map((t) => h("li", { class: t.role, textContent: t.content })));
  }

  async function busy<T>(fn: () => Promise<T>) {
    if (state.busy) return;
    state.busy = true;
    render();
    try { await fn(); }
    catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
      if ((e as { code?: string }).code === "configure") openConfigure(true);
    }
    finally { state.busy = false; render(); }
  }

  async function api(route: string, body: object) {
    let res: Response;
    try {
      res = await fetch(`/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pagepatch-token": token },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Couldn't reach PagePatch. Is `pagepatch` still running?");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message ?? `Request failed (${res.status}).`), { code: data.error as string | undefined });
    return data;
  }

  /** Any change to any section's previews makes a generated diff out of date. */
  function clearProposal() {
    state.proposalId = null;
    state.choosingFor = null;
  }

  /** Stop editing the current section. Like page.ts, keep it only if it has changes. */
  function deselect(message: string, error = false) {
    const sec = cs();
    if (sec && !sec.applied.length) sections.delete(state.curId!);
    state.curId = null;
    state.pending = null;
    setStatus(message, error);
    render();
  }

  /** Forget every section (the page has already dropped its previews). */
  function forgetAll(message: string) {
    sections.clear();
    state.curId = null;
    state.pending = null;
    clearProposal();
    setStatus(message);
    render();
  }

  closeBtn.addEventListener("click", () => { call("close"); forgetAll(""); });

  // ---------- page events ----------

  // Focus often stays in this iframe after "Select again", so forward the picker's keys to the page.
  let picking = false;
  addEventListener("keydown", (e) => {
    if (picking && (e.key === "Escape" || e.key === "ArrowUp")) { e.preventDefault(); call("key", e.key); }
  });

  function onPageEvent(e: PageEvent) {
    if (e.type !== "picking") picking = false;
    switch (e.type) {
      case "picking": deselect(PICK_HINT); picking = true; break;
      case "selected": onSelected(e); break;
      case "pickCancelled":
        state.lost = true;
        selLabel.textContent = "No selection";
        setStatus(e.reason ?? "Selection cancelled. Click Select again to choose a section.", !!e.reason);
        render();
        break;
      case "stale": {
        const label = sections.get(e.id)?.label ?? "a section";
        sections.delete(e.id);
        clearProposal();
        if (e.id === state.curId) { deselect(STALE); state.lost = true; selLabel.textContent = "Selection lost"; render(); }
        else { setStatus(`The page replaced ${label}, so its changes were dropped.`, true); render(); }
        break;
      }
      case "navigated":
        forgetAll("The page changed. Click Select again to choose a section.");
        state.lost = true; selLabel.textContent = "No selection"; render();
        break;
    }
  }

  function onSelected(e: Extract<PageEvent, { type: "selected" }>) {
    if (!(e.resumed && sections.has(e.id))) sections.set(e.id, { label: e.label, conversation: [], applied: [] });
    state.curId = e.id;
    state.lost = false;
    state.pending = null;
    selLabel.textContent = e.label;
    setStatus(e.resumed ? "Picking up where you left off on this section."
      : e.tooLarge ? "That section is very large. Select a smaller one for better results." : "Describe the change you want.", e.tooLarge);
    render();
    prompt.focus();
  }

  reselect.addEventListener("click", () => call("pick"));
  parent.addEventListener("click", async () => {
    const r = await call("parent");
    if (!r.ok) setStatus(r.error, true);
  });

  // ---------- conversation + preview ----------

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = prompt.value.trim();
    const sec = cs();
    if (!text || !sec) return;
    busy(async () => {
      const snap = await call("snapshot", false);
      if (!snap.ok) {
        if (snap.error === "stale") { deselect(STALE); return; }
        throw new Error(snap.error);
      }
      sec.conversation.push({ role: "user", content: text });
      prompt.value = "";
      render();
      setStatus("Thinking…");
      try {
        const res = await api("preview", { messages: sec.conversation, snapshot: snap.snapshot, ids: snap.ids });
        sec.conversation.push({ role: "assistant", content: res.summary || "(no summary)" });
        state.pending = res.ops.length ? res.ops : null;
        state.pendingVersion = snap.version;
        proposal.textContent = state.pending ? `Proposed: ${res.ops.length} change${res.ops.length === 1 ? "" : "s"}. Apply preview to see it.` : "";
        setStatus(state.pending ? "Review the proposal, then apply the preview." : "No change proposed. Try rephrasing.");
      } catch (err) {
        sec.conversation.pop();   // let them retry the same message
        prompt.value = text;
        throw err;
      }
    });
  });

  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) composer.requestSubmit();
  });

  applyBtn.addEventListener("click", () => busy(async () => {
    const sec = cs();
    if (!state.pending || !sec) return;
    const r = await call("apply", state.pending, state.pendingVersion);
    if (!r.ok) {
      if (r.error === "stale") { deselect(STALE); return; }
      throw new Error(r.error);
    }
    sec.applied.push(state.pending);
    state.pending = null;
    clearProposal();
    setStatus("Preview applied. Ask for a follow-up, select another section, or save to source.");
  }));

  undoBtn.addEventListener("click", () => busy(async () => {
    const r = await call("undo");
    if (!r.ok) throw new Error(r.error);
    cs()?.applied.pop();
    state.pending = null;
    clearProposal();
    setStatus("Undid the last preview.");
  }));

  resetBtn.addEventListener("click", () => busy(async () => {
    await call("reset");
    const sec = cs();
    if (sec) sec.applied = [];
    state.pending = null;
    clearProposal();
    setStatus("Reset this section to the original page. Other sections keep their changes.");
  }));

  // ---------- source ----------

  /** One diff for every changed section. */
  async function generate() {
    const list = changed();
    const payload = [];
    for (const [id, sec] of list) {
      const before = await call("snapshot", true, id);
      const after = await call("snapshot", false, id);
      if (!before.ok || !after.ok) throw new Error(before.error === "stale" || after.error === "stale" ? `The page replaced ${sec.label}. Select it again.` : before.error ?? after.error);
      payload.push({ label: sec.label, messages: sec.conversation, ops: sec.applied.flat(), snapshot: before.snapshot, after: after.snapshot, signals: before.signals, paths: sec.paths });
    }
    setStatus("Searching your project…");
    const res = await api("propose", { sections: payload });
    if (res.status === "choose") {
      const [id, sec] = list[res.section];
      state.choosingFor = id;
      candidateHint.textContent = `PagePatch couldn't tell which file renders ${sec.label}. Pick one, or enter a path.`;
      candidateList.replaceChildren(...res.candidates.map((c: { path: string; reasons: string[] }) => {
        const b = h("button", { class: "link", textContent: c.path });
        b.addEventListener("click", () => busy(() => choosePath(c.path)));
        return h("li", {}, b, h("span", { class: "reasons", textContent: c.reasons.join(" · ") }));
      }));
      setStatus(`Choose the file that renders ${sec.label}.`);
      return;
    }
    state.proposalId = res.proposalId;
    state.choosingFor = null;
    diffSummary.textContent = res.summary;
    diffFiles.textContent = res.files.join(", ");
    diff.replaceChildren(...String(res.diff).split("\n").map((line) => h("span", {
      class: /^(\+\+\+|---|@@|====)/.test(line) ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "",
      textContent: line + "\n",
    })));
    setStatus("Review the diff, then write it to your files.");
  }

  async function choosePath(path: string) {
    const sec = state.choosingFor === null ? null : sections.get(state.choosingFor);
    if (sec) sec.paths = [path];
    await generate();
  }

  generateBtn.addEventListener("click", () => busy(async () => { clearProposal(); await generate(); }));
  usePath.addEventListener("click", () => {
    const p = manualPath.value.trim().replace(/^\/+/, "");
    if (p) busy(() => choosePath(p));
  });

  writeBtn.addEventListener("click", () => busy(async () => {
    if (!state.proposalId) return;
    setStatus("Writing…");
    try {
      const { files } = await api("apply", { proposalId: state.proposalId });
      // Drop the previews first so the dev server's reload doesn't read as lost selections.
      await call("clear");
      forgetAll(`Wrote ${files.join(", ")}. Your dev server should reload; refresh if it doesn't.`);
      state.lost = true;
      selLabel.textContent = "Saved";
    } catch (e: any) {
      if (e?.code === "file_changed" || e?.code === "no_proposal") {
        setStatus(`${e.message} Regenerating…`);
        clearProposal();
        await generate();
        setStatus("The file changed, so PagePatch made a new diff. Review it before writing.");
        return;
      }
      throw e;
    }
  }));

  // ---------- configure ----------

  type Config = { provider: keyof typeof choices; model: string; defaults: Record<string, string>; available: Record<string, boolean>; hasKey: Record<string, boolean>; problem: string | null };
  let cfg: Config | null = null;
  const NAMES = { "claude-code": "Claude Code", codex: "Codex", anthropic: "Anthropic API", openai: "OpenAI API" };

  function openConfigure(open: boolean) {
    configure.hidden = !open;
    configureBtn.setAttribute("aria-expanded", String(open));
  }
  const selectedProvider = () => (Object.keys(choices) as (keyof typeof choices)[]).find((k) => choices[k].input.checked) ?? "claude-code";

  /** Show the fields that fit the chosen provider. */
  function syncConfigure() {
    const p = selectedProvider();
    const usesKey = p === "anthropic" || p === "openai";
    keyChoices.hidden = !usesKey && keysToggle.getAttribute("aria-expanded") !== "true";
    keyRow.hidden = !usesKey;
    keyInput.placeholder = usesKey && cfg?.hasKey[p] ? "Key saved for this run" : "Paste your key";
    const def = cfg?.defaults[p] ?? "";
    modelInput.placeholder = def ? `Default: ${def}` : p === "openai" ? "Enter an OpenAI model id" : "Default model";
  }

  function showConfig(c: Config) {
    cfg = c;
    for (const [k, ch] of Object.entries(choices)) {
      ch.input.checked = k === c.provider;
      const installed = c.available[k] !== false;
      ch.input.disabled = !installed;
      if (!installed) ch.noteEl.textContent = "not installed";
    }
    if (c.provider === "anthropic" || c.provider === "openai") keysToggle.setAttribute("aria-expanded", "true");
    modelInput.value = c.model === c.defaults[c.provider] ? "" : c.model;
    keyInput.value = "";
    syncConfigure();
  }

  keysToggle.addEventListener("click", () => {
    keysToggle.setAttribute("aria-expanded", String(keysToggle.getAttribute("aria-expanded") !== "true"));
    syncConfigure();
  });
  for (const ch of Object.values(choices)) ch.input.addEventListener("change", () => { modelInput.value = ""; syncConfigure(); });
  configureBtn.addEventListener("click", () => openConfigure(configure.hidden));

  saveConfig.addEventListener("click", () => busy(async () => {
    const provider = selectedProvider();
    const body: Record<string, string> = { provider };
    // Send the provider first so a model name is checked against the right default.
    await api("config", body);
    const update: Record<string, string> = { model: modelInput.value.trim() || (cfg?.defaults[provider] ?? "") };
    if ((provider === "anthropic" || provider === "openai") && keyInput.value.trim()) update.apiKey = keyInput.value.trim();
    const c: Config = await api("config", update);
    showConfig(c);
    if (c.problem) { setStatus(c.problem, true); return; }
    openConfigure(false);
    setStatus(`Using ${NAMES[c.provider]}${c.model ? ` (${c.model})` : ""}.`);
  }));

  async function loadConfig() {
    try {
      const c: Config = await api("config", {});
      showConfig(c);
      if (c.problem) { openConfigure(true); setStatus(`${c.problem} Choose a model to start.`, true); }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ---------- boot ----------

  selLabel.textContent = "No selection";
  setStatus("Click Select again to choose a section.");
  openConfigure(false);
  render();
  loadConfig();
  parent_.postMessage({ pp: 1, ready: true }, parentOrigin);
}

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
[hidden] { display: none !important; }
.panel {
  --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; --accent: #2f6feb; --accent-fg: #ffffff;
  --danger: #c4332b; --add: #1a7f37; --del: #c4332b; --code-bg: #f6f6f8;
  color-scheme: light dark;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #1c1c1e; --fg: #f2f2f7; --muted: #98989f; --line: #2c2c2e; --accent: #5b8def;
    --code-bg: #242426; --add: #4ac26b; --del: #ff6b62;
  }
}
.panel { min-height: 100%; padding: 0 16px 32px; background: var(--bg); border-left: 1px solid var(--line); }
header { display: flex; align-items: baseline; justify-content: space-between; padding: 14px 0 10px; border-bottom: 1px solid var(--line); }
h1 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 20px 0 8px; }
section { padding: 4px 0 12px; border-top: 1px solid var(--line); margin-top: 16px; }
p { margin: 8px 0 0; }
input, textarea {
  display: block; width: 100%; margin-top: 10px; padding: 7px 8px;
  font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 6px;
}
textarea { resize: vertical; }
input:focus-visible, textarea:focus-visible, button:focus-visible, pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button {
  font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer;
  background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent);
}
button.quiet { background: transparent; color: var(--fg); border-color: var(--line); }
button.small { padding: 3px 8px; font-size: 12px; }
button.link { background: none; border: 0; padding: 0; color: var(--accent); text-align: left; }
button:disabled { opacity: .45; cursor: default; }
input[type="radio"] { display: inline; width: auto; margin: 0; }
.choice { display: flex; gap: 8px; align-items: baseline; margin-top: 8px; color: var(--fg); cursor: pointer; }
.choice small { color: var(--muted); }
.choice:has(input:disabled) { opacity: .5; cursor: default; }
.field { display: block; margin-top: 12px; color: var(--muted); font-size: 12px; }
.key-choices { padding-left: 2px; }
.configure { margin-top: 0; border-top: 0; border-bottom: 1px solid var(--line); }
.row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.header-links { display: flex; gap: 16px; }
.row.tight { margin: 0; gap: 4px; }
.row input { flex: 1; margin: 0; }
.hint { color: var(--muted); font-size: 12px; }
.status { color: var(--muted); margin: 14px 0; }
.status.error { color: var(--danger); }
.selection-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); }
code { font: 12px ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
.conversation { list-style: none; padding: 0; margin: 12px 0 0; }
.conversation li { padding: 8px 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.conversation li.user::before { content: "You"; display: block; font-size: 11px; color: var(--muted); }
.conversation li.assistant::before { content: "PagePatch"; display: block; font-size: 11px; color: var(--accent); }
.candidates { list-style: none; padding: 0; margin: 8px 0 0; }
.candidates li { padding: 6px 0; border-bottom: 1px solid var(--line); }
.candidates .reasons { display: block; color: var(--muted); font-size: 11px; }
pre {
  margin: 10px 0 0; padding: 10px; max-height: 360px; overflow: auto; white-space: pre;
  background: var(--code-bg); border-radius: 6px; font: 11.5px/1.45 ui-monospace, Menlo, monospace;
}
pre .add { color: var(--add); }
pre .del { color: var(--del); }
pre .meta { color: var(--muted); }
`;

main();
