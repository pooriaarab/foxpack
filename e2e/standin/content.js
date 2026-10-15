// The stand-in's content script on the E2E site: it relays a request from
// the page to its own background script and posts the answer back.
const me = browser.runtime.getManifest().browser_specific_settings.gecko.id;
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.fpkAsk !== me) return;
  const result = await browser.runtime.sendMessage({ to: event.data.to, payload: event.data.payload });
  window.postMessage({ fpkReply: event.data.id, from: me, result }, "*");
});
document.documentElement.dataset[me.replace(/\W/g, "_")] = "ready";
