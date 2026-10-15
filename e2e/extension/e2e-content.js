// The E2E content script. Only build-ext.mjs --e2e adds it, to dist-e2e/;
// the release build in dist-ext/ never has it. It marks each page on
// 127.0.0.1, where the E2E test serves e2e/site.
document.documentElement.dataset.fixture = "content-script-ran";
