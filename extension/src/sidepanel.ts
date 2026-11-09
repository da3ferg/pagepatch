// Side panel UI. All dynamic text is rendered with textContent, never innerHTML.

import type { PreviewOp } from "@pagepatch/shared";

declare const PAGEPATCH_API: string;
declare const GH_CLIENT_ID: string;
declare const GH_APP_SLUG: string;

type Turn = { role: "user" | "assistant"; content: string };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DEFAULT_MODEL: Record<string, string> = { anthropic: "claude-opus-5-5", openai: "" };

const state = {
  tabId: null as number | null,
  selected: false,
  conversation: [] as Turn[],
  pending: null as PreviewOp[] | null,
  pendingVersion: -1,                // content-script state the pending proposal was made for
  applied: [] as PreviewOp[][],      // mirrors the content script's undo stack
  ghToken: null as string | null,
  proposalId: null as string | null,
  chosenPaths: null as string[] | null,
  busy: false,
  lost: false,                       // selection was replaced by the page; offer "Select again"
};

// ---------- utilities ----------

function setStatus(text: string, error = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", error);
}

async function toContent<T = any>(msg: object): Promise<T> {
  if (state.tabId === null) throw new Error("No page connected.");
  return chrome.tabs.sendMessage(state.tabId, msg);
}

async function api(path: string, init: { method?: string; body?: object; provider?: boolean; github?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.provider) {
    const { key } = await chrome.storage.session.get("key");
    if (!key) throw new Error("Add your API key in Settings.");
    headers["X-Provider-Key"] = key;
  }
  if (init.github && state.ghToken) headers.Authorization = `Bearer ${state.ghToken}`;
  let res: Response;
  try {
    res = await fetch(PAGEPATCH_API + path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach the PagePatch API.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message ?? `Request failed (${res.status}).`) as Error & { code?: string; status?: number };
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function busy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) return;
  state.busy = true;
  document.body.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    state.busy = false;
    document.body.removeAttribute("aria-busy");
    render();
  }
}

// ---------- rendering ----------

function render() {
  $("selection").hidden = !state.selected && !state.lost;
  $<HTMLButtonElement>("parent").disabled = !state.selected;
  $("composer").hidden = !state.selected;
  $("preview-controls").hidden = !state.selected;
  $<HTMLButtonElement>("apply").disabled = !state.pending || state.busy;
  $<HTMLButtonElement>("undo").disabled = state.applied.length === 0 || state.busy;
  $<HTMLButtonElement>("reset").disabled = state.applied.length === 0 || state.busy;
  $<HTMLButtonElement>("send").disabled = state.busy;
  $("source").hidden = state.applied.length === 0;
  $("gh-signed-out").hidden = !!state.ghToken;
  $("gh-signed-in").hidden = !state.ghToken;
  $<HTMLButtonElement>("generate").disabled = state.busy || !$<HTMLSelectElement>("branch").value;
  $<HTMLButtonElement>("create-pr").disabled = state.busy || !state.proposalId;

  const list = $("conversation");
  list.replaceChildren(...state.conversation.map((t) => {
    const li = document.createElement("li");
    li.className = t.role;
    li.textContent = t.content;
    return li;
  }));
}

function clearSession(message: string) {
  state.selected = false;
  state.lost = false;
  state.conversation = [];
  state.pending = null;
  state.applied = [];
  clearProposal();
  $("proposal").hidden = true;
  setStatus(message);
  render();
}

function clearProposal() {
  state.proposalId = null;
  state.chosenPaths = null;
  $("diff-view").hidden = true;
  $("candidates").hidden = true;
  $("pr-result").hidden = true;
}

// ---------- tab binding ----------

async function bindTarget(target: { tabId?: number; supported: boolean; reason?: string } | undefined) {
  if (!target?.tabId) return;
  if (state.tabId !== null && state.tabId !== target.tabId) {
    toContent({ type: "clear" }).catch(() => {});
  }
  state.tabId = target.tabId;
  clearSession(target.supported ? "Click a section on the page. Press ↑ to grow the selection, Esc to cancel." : target.reason ?? "This page isn't supported.");
  if (!target.supported) return;
  // Ask the content script to connect its port (it may have loaded before this panel).
  try {
    const r = await toContent<{ selected: boolean; label: string | null }>({ type: "hello" });
    if (r?.selected && r.label) {
      // The panel was reopened: its conversation is gone, so drop any preview to keep both in sync.
      await toContent({ type: "reset" });
      onSelected(r.label);
    }
  } catch { /* content not ready yet; it connects on its own */ }
}

function onSelected(label: string, tooLarge = false) {
  state.selected = true;
  state.lost = false;
  state.conversation = [];
  state.pending = null;
  state.applied = [];
  clearProposal();
  $("proposal").hidden = true;
  $("selection-label").textContent = label;
  setStatus(tooLarge ? "That section is very large. Select a smaller one for better results." : "Describe the change you want.", tooLarge);
  render();
  $("prompt").focus();
}

// Content scripts may connect before this panel knows which tab it's bound to,
// so accept every connection and check the tab when each event arrives.
chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== "pagepatch-content" || tabId === undefined) return;
  port.onMessage.addListener((msg) => {
    if (tabId !== state.tabId) return;
    switch (msg.type) {
      case "picking": clearSession("Click a section on the page. Press ↑ to grow the selection, Esc to cancel."); break;
      case "selected": onSelected(msg.label, msg.tooLarge); break;
      case "pickCancelled": if (!state.selected) setStatus("Selection cancelled. Click Select again or the toolbar button."); break;
      case "stale": clearSession("The page replaced the selected section. Select it again."); showReselectOnly(); break;
      case "navigated": clearSession("The page changed. Click the PagePatch toolbar button to start again."); break;
    }
  });
  port.onDisconnect.addListener(() => {
    // Full navigation or tab closed: the content script is gone, and so is activeTab access.
    if (tabId === state.tabId) clearSession("The page changed. Click the PagePatch toolbar button to start again.");
  });
});

function showReselectOnly() {
  state.lost = true;
  $("selection-label").textContent = "Selection lost";
  render();
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.target) bindTarget(changes.target.newValue);
});

// ---------- settings ----------

async function loadSettings() {
  const { provider = "anthropic", model, disclosureAccepted } = await chrome.storage.local.get(["provider", "model", "disclosureAccepted"]);
  const { key, ghToken, ghLogin } = await chrome.storage.session.get(["key", "ghToken", "ghLogin"]);
  $<HTMLSelectElement>("provider").value = provider;
  $<HTMLInputElement>("model").value = model ?? DEFAULT_MODEL[provider];
  $<HTMLInputElement>("key").placeholder = key ? "Key saved for this session" : "Paste your key";
  (window as any).__disclosure = !!disclosureAccepted;
  if (ghToken) { state.ghToken = ghToken; $("gh-login").textContent = ghLogin ?? ""; loadRepos(); }
  if (!key) toggleSettings(true);
}

function toggleSettings(open?: boolean) {
  const s = $("settings");
  s.hidden = open === undefined ? !s.hidden : !open;
  $("toggle-settings").setAttribute("aria-expanded", String(!s.hidden));
}

$("toggle-settings").addEventListener("click", () => toggleSettings());
$<HTMLSelectElement>("provider").addEventListener("change", (e) => {
  const p = (e.target as HTMLSelectElement).value;
  $<HTMLInputElement>("model").value = DEFAULT_MODEL[p];
  $<HTMLInputElement>("model").placeholder = p === "openai" ? "Enter an OpenAI model id" : "";
});
$("save-settings").addEventListener("click", async () => {
  const provider = $<HTMLSelectElement>("provider").value;
  const model = $<HTMLInputElement>("model").value.trim();
  const key = $<HTMLInputElement>("key").value.trim();
  if (!model) { setStatus("Enter a model.", true); return; }
  await chrome.storage.local.set({ provider, model });
  if (key) await chrome.storage.session.set({ key });
  $<HTMLInputElement>("key").value = "";
  $<HTMLInputElement>("key").placeholder = "Key saved for this session";
  toggleSettings(false);
  setStatus(state.selected ? "Settings saved." : "Settings saved. Click the toolbar button on a page to start.");
});
$("clear-key").addEventListener("click", async () => {
  await chrome.storage.session.remove("key");
  $<HTMLInputElement>("key").placeholder = "Paste your key";
  setStatus("Key cleared.");
});

// ---------- disclosure ----------

function ensureDisclosure(): Promise<void> {
  if ((window as any).__disclosure) return Promise.resolve();
  $("disclosure").hidden = false;
  $("accept-disclosure").focus();
  return new Promise((resolve) => {
    $("accept-disclosure").addEventListener("click", async () => {
      await chrome.storage.local.set({ disclosureAccepted: true });
      (window as any).__disclosure = true;
      $("disclosure").hidden = true;
      resolve();
    }, { once: true });
  });
}

// ---------- conversation + preview ----------

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $<HTMLTextAreaElement>("prompt").value.trim();
  if (!text) return;
  busy(async () => {
    await ensureDisclosure();
    const { provider, model } = await chrome.storage.local.get(["provider", "model"]);
    const snap = await toContent<any>({ type: "snapshot" });
    if (!snap.ok) {
      if (snap.error === "stale") { clearSession("The page replaced the selected section. Select it again."); return; }
      throw new Error(snap.error);
    }
    state.conversation.push({ role: "user", content: text });
    $<HTMLTextAreaElement>("prompt").value = "";
    render();
    setStatus("Thinking…");
    try {
      const res = await api("/v1/preview", {
        provider: true,
        body: { provider: provider ?? "anthropic", model: model ?? DEFAULT_MODEL.anthropic, messages: state.conversation, snapshot: snap.snapshot, ids: snap.ids },
      });
      state.conversation.push({ role: "assistant", content: res.summary || "(no summary)" });
      state.pending = res.ops.length ? res.ops : null;
      state.pendingVersion = snap.version;
      $("proposal").hidden = !state.pending;
      $("proposal-summary").textContent = state.pending ? `Proposed: ${res.ops.length} change${res.ops.length === 1 ? "" : "s"}. Apply preview to see it.` : "";
      setStatus(state.pending ? "Review the proposal, then apply the preview." : "No change proposed. Try rephrasing.");
    } catch (e) {
      state.conversation.pop();   // let them retry the same message
      $<HTMLTextAreaElement>("prompt").value = text;
      throw e;
    }
  });
});

$<HTMLTextAreaElement>("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $<HTMLFormElement>("composer").requestSubmit();
});

$("apply").addEventListener("click", () => busy(async () => {
  if (!state.pending) return;
  const r = await toContent<any>({ type: "apply", ops: state.pending, version: state.pendingVersion });
  if (!r.ok) {
    if (r.error === "stale") { clearSession("The page replaced the selected section. Select it again."); return; }
    throw new Error(r.error);
  }
  state.applied.push(state.pending);
  state.pending = null;
  $("proposal").hidden = true;
  clearProposal();
  setStatus("Preview applied. Ask for a follow-up, undo, or save it to source.");
}));

$("undo").addEventListener("click", () => busy(async () => {
  const r = await toContent<any>({ type: "undo" });
  if (!r.ok) throw new Error(r.error);
  state.applied.pop();
  state.pending = null;
  $("proposal").hidden = true;
  clearProposal();
  setStatus("Undid the last preview.");
}));

$("reset").addEventListener("click", () => busy(async () => {
  await toContent({ type: "reset" });
  state.applied = [];
  state.pending = null;
  clearProposal();
  setStatus("Reset to the original page.");
}));

$("reselect").addEventListener("click", () => busy(async () => { await toContent({ type: "pick" }); }));
$("parent").addEventListener("click", () => busy(async () => {
  const r = await toContent<any>({ type: "parent" });
  if (!r.ok) throw new Error(r.error);
}));

// ---------- GitHub ----------

$<HTMLAnchorElement>("gh-install").href = `https://github.com/apps/${GH_APP_SLUG}/installations/new`;

$("gh-signin").addEventListener("click", () => busy(async () => {
  const redirectUri = chrome.identity.getRedirectURL();
  const nonce = crypto.randomUUID();
  // PKCE: the code is useless without this verifier, which never leaves the panel until the exchange.
  const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const codeVerifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const result = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  const back = new URL(result ?? "");
  if (back.searchParams.get("state") !== nonce || !back.searchParams.get("code")) throw new Error("GitHub sign-in was cancelled.");
  const { token, login } = await api("/v1/auth/github", { body: { code: back.searchParams.get("code"), redirectUri, codeVerifier } });
  state.ghToken = token;
  await chrome.storage.session.set({ ghToken: token, ghLogin: login });
  $("gh-login").textContent = login;
  await loadRepos();
}));

$("gh-signout").addEventListener("click", async () => {
  state.ghToken = null;
  await chrome.storage.session.remove(["ghToken", "ghLogin"]);
  clearProposal();
  render();
});

async function loadRepos() {
  try {
    const { repos } = await api("/v1/repos", { github: true });
    const sel = $<HTMLSelectElement>("repo");
    const { lastRepo } = await chrome.storage.local.get("lastRepo");
    sel.replaceChildren(...repos.map((r: any) => {
      const o = document.createElement("option");
      o.value = `${r.owner}/${r.name}`;
      o.dataset.default = r.defaultBranch;
      o.textContent = `${r.owner}/${r.name}`;
      return o;
    }));
    if (!repos.length) setStatus("Install the PagePatch GitHub app on a repository first.", true);
    if (lastRepo && repos.some((r: any) => `${r.owner}/${r.name}` === lastRepo)) sel.value = lastRepo;
    await loadBranches();
  } catch (e: any) {
    if (e?.status === 401) { state.ghToken = null; await chrome.storage.session.remove(["ghToken", "ghLogin"]); }
    setStatus(e.message, true);
    render();
  }
}

async function loadBranches() {
  const sel = $<HTMLSelectElement>("repo");
  const opt = sel.selectedOptions[0];
  const bsel = $<HTMLSelectElement>("branch");
  bsel.replaceChildren();
  if (!opt) { render(); return; }
  const [owner, repo] = opt.value.split("/");
  const { branches } = await api(`/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, { github: true });
  bsel.replaceChildren(...branches.map((b: string) => {
    const o = document.createElement("option");
    o.value = o.textContent = b;
    return o;
  }));
  bsel.value = branches.includes(opt.dataset.default) ? opt.dataset.default! : branches[0] ?? "";
  render();
}

$("repo").addEventListener("change", () => {
  chrome.storage.local.set({ lastRepo: $<HTMLSelectElement>("repo").value });
  clearProposal();
  busy(loadBranches);
});
$("branch").addEventListener("change", () => { clearProposal(); render(); });

async function generate(paths: string[] | null) {
  const { provider, model } = await chrome.storage.local.get(["provider", "model"]);
  const before = await toContent<any>({ type: "snapshot", which: "pristine" });
  const after = await toContent<any>({ type: "snapshot" });
  if (!before.ok || !after.ok) throw new Error(before.error === "stale" || after.error === "stale" ? "The page replaced the selected section. Select it again." : before.error ?? after.error);
  const [owner, repo] = $<HTMLSelectElement>("repo").value.split("/");
  setStatus("Searching the repository…");
  const res = await api("/v1/source/propose", {
    provider: true, github: true,
    body: {
      provider: provider ?? "anthropic", model: model ?? DEFAULT_MODEL.anthropic,
      owner, repo, branch: $<HTMLSelectElement>("branch").value,
      messages: state.conversation, ops: state.applied.flat(),
      snapshot: before.snapshot, after: after.snapshot, signals: before.signals,
      paths: paths ?? undefined,
    },
  });
  if (res.status === "choose") {
    showCandidates(res.candidates);
    setStatus("Choose the file that renders this section.");
    return;
  }
  state.chosenPaths = paths;
  state.proposalId = res.proposalId;
  $("candidates").hidden = true;
  $("diff-summary").textContent = res.summary;
  $("diff-files").textContent = res.files.join(", ");
  renderDiff(res.diff);
  $("diff-view").hidden = false;
  setStatus("Review the diff. Nothing is written until you create the draft PR.");
}

function showCandidates(cands: { path: string; reasons: string[] }[]) {
  $("diff-view").hidden = true;
  $("candidates").hidden = false;
  $("candidate-list").replaceChildren(...cands.map((c) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = c.path;
    b.addEventListener("click", () => busy(() => generate([c.path])));
    const why = document.createElement("span");
    why.className = "reasons";
    why.textContent = c.reasons.join(" · ");
    li.append(b, why);
    return li;
  }));
}

function renderDiff(diff: string) {
  const pre = $("diff");
  pre.replaceChildren(...diff.split("\n").map((line) => {
    const span = document.createElement("span");
    span.className = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("====") ? "meta"
      : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    span.textContent = line + "\n";
    return span;
  }));
}

$("generate").addEventListener("click", () => busy(async () => { clearProposal(); await ensureDisclosure(); await generate(null); }));
$("use-path").addEventListener("click", () => {
  const p = $<HTMLInputElement>("manual-path").value.trim().replace(/^\/+/, "");
  if (p) busy(() => generate([p]));
});

$("create-pr").addEventListener("click", () => busy(async () => {
  if (!state.proposalId) return;
  setStatus("Creating draft pull request…");
  try {
    const { url } = await api("/v1/source/pr", { github: true, body: { proposalId: state.proposalId } });
    if (typeof url !== "string" || !url.startsWith("https://github.com/")) throw new Error("Unexpected pull request link.");
    const out = $("pr-result");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = url;
    out.replaceChildren("Draft PR created: ", a);
    out.hidden = false;
    $("diff-view").hidden = true;
    state.proposalId = null;
    setStatus("Done. The base branch was not changed.");
  } catch (e: any) {
    if (e?.code === "base_advanced" || e?.code === "expired") {
      setStatus(`${e.message} Regenerating…`);
      const paths = state.chosenPaths;
      clearProposal();
      await generate(paths);
      setStatus("The base branch changed, so PagePatch made a new diff. Review it before creating the PR.");
      return;
    }
    throw e;
  }
}));

// ---------- boot ----------

loadSettings().then(async () => {
  const { target } = await chrome.storage.session.get("target");
  if (target) await bindTarget(target);
  render();
});
