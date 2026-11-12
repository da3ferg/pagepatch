// Loader injected by the proxy into every HTML page. Holds no secrets: it draws
// the launcher, embeds the panel (a cross-origin iframe on the panel port),
// and runs page.ts on the panel's behalf over postMessage.

import { createPage, type PageEvent } from "./page.ts";

declare global { interface Window { __pagepatch?: true } }

const WIDTH = 360;
const panelPort = (document.currentScript as HTMLScriptElement | null)?.dataset.pagepatchPanel;


function main(port: string) {
  const panelOrigin = `${location.protocol}//${location.hostname}:${port}`;
  const host = document.createElement("pagepatch-overlay");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  shadow.adoptedStyleSheets = [sheet];
  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.textContent = "PagePatch";
  launcher.title = "Select a section to change";
  shadow.append(launcher);
  document.documentElement.append(host);

  let frame: HTMLIFrameElement | null = null;
  let ready = false;
  const queue: object[] = [];

  const post = (msg: object) => {
    if (!ready || !frame?.contentWindow) { queue.push(msg); return; }
    frame.contentWindow.postMessage({ pp: 1, ...msg }, panelOrigin);
  };
  const page = createPage(host, shadow, (event: PageEvent) => post({ event }));

  // Dock the panel beside the page instead of covering it.
  let prevMargin: string | null = null;
  function dock(on: boolean) {
    const s = document.documentElement.style;
    if (on && prevMargin === null) { prevMargin = s.marginRight; s.marginRight = `${WIDTH}px`; }
    if (!on && prevMargin !== null) { s.marginRight = prevMargin; prevMargin = null; }
  }

  const remember = (open: boolean) => { try { sessionStorage.setItem("pagepatch:open", open ? "1" : ""); } catch { /* storage blocked */ } };

  function open(pick: boolean) {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = "PagePatch";
      frame.src = `${panelOrigin}/?parent=${encodeURIComponent(location.origin)}`;
      shadow.append(frame);
    }
    frame.hidden = false;
    launcher.hidden = true;
    dock(true);
    remember(true);
    if (pick) page.pick();
  }

  function close() {
    page.clear();
    if (frame) frame.hidden = true;
    launcher.hidden = false;
    dock(false);
    remember(false);
  }

  launcher.addEventListener("click", () => open(true));

  addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== panelOrigin || e.data?.pp !== 1) return;
    if (e.data.ready) {
      ready = true;
      for (const m of queue.splice(0)) post(m);
      return;
    }
    const args: any[] = Array.isArray(e.data.args) ? e.data.args : [];
    let result: unknown;
    try {
      switch (e.data.cmd) {
        case "pick": page.pick(); result = { ok: true }; break;
        case "key": result = { ok: page.pickKey(String(args[0])) }; break;
        case "parent": result = page.selectParent(); break;
        case "snapshot": result = page.snapshot(args[0] === true, typeof args[1] === "number" ? args[1] : undefined); break;
        case "apply": result = page.apply(args[0], args[1]); break;
        case "undo": result = page.undo(); break;
        case "reset": page.reset(); result = { ok: true }; break;
        case "clear": page.clear(); result = { ok: true }; break;
        case "close": close(); result = { ok: true }; break;
        default: result = { ok: false, error: "unknown command" };
      }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    frame.contentWindow!.postMessage({ pp: 1, id: e.data.id, result }, panelOrigin);
  });

  let wasOpen = false;
  try { wasOpen = sessionStorage.getItem("pagepatch:open") === "1"; } catch { /* storage blocked */ }
  if (wasOpen) open(false);
}

const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  padding: 8px 14px; border-radius: 999px; border: 0; cursor: pointer;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: #1d1d1f; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.18);
}
iframe {
  position: fixed; top: 0; right: 0; width: ${WIDTH}px; height: 100vh; z-index: 2147483646;
  border: 0; color-scheme: normal;
}
`;

if (!window.__pagepatch && window.top === window && panelPort) {
  window.__pagepatch = true;
  main(panelPort);
}
