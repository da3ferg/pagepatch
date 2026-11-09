// Toolbar click: open the side panel and inject the picker into this tab.
// activeTab grants access to the clicked tab only, until it navigates.

chrome.action.onClicked.addListener((tab) => {
  // Must run synchronously inside the user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId });
  const tabId = tab.id;
  const supported = tabId !== undefined && /^https?:\/\//.test(tab.url ?? "");
  const target = (ok: boolean, reason?: string) =>
    chrome.storage.session.set({ target: { tabId, supported: ok, reason, at: Date.now() } });
  if (!supported) {
    target(false, "PagePatch works on regular http and https pages.");
    return;
  }
  chrome.scripting
    .executeScript({ target: { tabId: tabId! }, files: ["content.js"] })
    .then(() => target(true))
    .catch(() => target(false, "Chrome doesn't allow extensions on this page."));
});
