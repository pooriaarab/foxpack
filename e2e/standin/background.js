// A stand-in for another extension, for the E2E only. run.mjs installs it
// twice: once with the id foxscope@pooriaarab, once with a stranger's id.
// It sends one message to foxpack and passes back what came back.
browser.runtime.onMessage.addListener(async ({ to, payload }) => {
  try {
    return { ok: true, reply: await browser.runtime.sendMessage(to, payload) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
