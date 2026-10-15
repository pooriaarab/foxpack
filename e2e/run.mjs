// The Firefox E2E for foxpack. It runs on the release build in dist-ext/,
// locally or on Ichabod (FOXKIT_BROWSER=ichabod), and checks:
//   1. the import page reads a ChatGPT zip, a Claude zip, a Google Takeout
//      zip and a memory list in the page, and shows the counts per source;
//   2. a wrong file shows an error and changes nothing (B4);
//   3. the candidates match what the Node library finds in the same files;
//   4. two accepts and one reject persist after the page reloads (B5), and
//      a forget in one tab is not undone by an accept in another (K12, B6);
//   5. the export holds the accepted memories and no rejected one (E1);
//   6. a stand-in foxscope extension reads accepted memories over
//      onMessageExternal, and a stand-in stranger gets the error of an
//      add-on that is not installed (B1);
//   7. the popup counts the pack and lists the foxscope read.
// Usage: pnpm e2e [--shots <dir>]. Writes artifacts/e2e-<date>.json.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";
import { createPack, inMemoryStore } from "../dist/index.js";

const args = process.argv.slice(2);
const shots = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1]) : null;
const record = { startedAt: new Date().toISOString(), mode: process.env.FOXKIT_BROWSER ?? "local", checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const fixture = (name) => readFileSync(`tests/fixtures/${name}`);

// The export files a user downloads, built from the test fixtures.
const files = [
  ["chatgpt", "chatgpt-export.zip", zipSync({ "conversations.json": fixture("chatgpt-conversations.json"), "user.json": strToU8("{}"), "chat.html": strToU8("<html></html>") })],
  ["claude", "claude-export.zip", zipSync({ "conversations.json": fixture("claude-conversations.json"), "memories.json": fixture("claude-memories.json"), "users.json": strToU8("[]") })],
  ["gemini", "takeout-20261015.zip", zipSync({ "Takeout/My Activity/Gemini Apps/MyActivity.json": fixture("gemini-MyActivity.json") })],
  ["memories", "saved-memories.txt", fixture("saved-memories.txt")],
];

// The same files through the Node library: the page must find the same candidates.
const node = createPack({ store: inMemoryStore() });
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", memories: "Memory lists" };
const reports = [];
for (const [source, , bytes] of files) {
  const r = await node.import(source, new Uint8Array(bytes));
  reports.push(`ok: ${LABELS[source]}: ${r.conversations} conversations and ${r.added} new memories to review${r.skipped ? `, ${r.skipped} ${r.skipped === 1 ? "entry" : "entries"} skipped` : ""}.`);
}
const expected = (await node.memories()).map((m) => m.text).toSorted();

// Two stand-in extensions: one with foxscope's id, one with a stranger's.
const standin = (id) => zipSync({
  "manifest.json": strToU8(JSON.stringify({
    manifest_version: 2, name: `stand-in ${id}`, version: "1.0",
    browser_specific_settings: { gecko: { id } },
    background: { scripts: ["background.js"] },
    content_scripts: [{ matches: ["http://127.0.0.1/*", "https://*.trycloudflare.com/*"], js: ["content.js"] }],
  })),
  "background.js": readFileSync("e2e/standin/background.js"),
  "content.js": readFileSync("e2e/standin/content.js"),
});

async function drop(page, source, name, bytes) {
  await page.evaluate((arg) => {
    const data = Uint8Array.from(atob(arg.b64), (ch) => ch.charCodeAt(0));
    document.getElementById("status").className = "";
    document.getElementById("source").value = arg.source;
    const dt = new DataTransfer();
    dt.items.add(new File([data], arg.name));
    const input = document.getElementById("file");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { source, name, b64: Buffer.from(bytes).toString("base64") });
  return poll(page, () => {
    const s = document.getElementById("status");
    return (s.className === "ok" || s.className === "bad") && `${s.className}: ${s.textContent}`;
  });
}

const counts = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#counts .count")].map((c) => [c.dataset.source, Number(c.dataset.count)])));
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll(".tabs button")].map((b) => b.textContent));
const shown = (page) => page.evaluate(() => [...document.querySelectorAll("#review .memory")].map((c) => ({ id: c.dataset.id, status: c.dataset.status, text: c.querySelector(".memory-text")?.textContent })));
const clickIn = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const ready = (page) => poll(page, () => document.querySelectorAll("#counts .count").length === 4);

async function ask(page, as, payload, to = "foxpack@pooriaarab") {
  return page.evaluate((arg) => new Promise((done) => {
    const id = Math.random().toString(36).slice(2);
    const onReply = (e) => {
      if (e.data?.fpkReply !== id) return;
      window.removeEventListener("message", onReply);
      done(e.data.result);
    };
    window.addEventListener("message", onReply);
    window.postMessage({ fpkAsk: arg.as, id, to: arg.to, payload: arg.payload }, "*");
  }), { as, payload, to });
}

const site = await serve("e2e/site");
let fox;
try {
  fox = await launch({ extension: "dist-ext" });
  record.firefox = await fox.browser.version();
  // Puppeteer sends raw WebDriver BiDi commands on its connection.
  for (const id of ["foxscope@pooriaarab", "stranger@example.com"]) {
    await fox.browser.connection.send("webExtension.install", { extensionData: { type: "base64", value: Buffer.from(standin(id)).toString("base64") } });
  }

  let page = await fox.openExtensionPage("import.html");
  await ready(page);
  check("an empty pack shows zero counts", { chatgpt: 0, claude: 0, gemini: 0, accepted: 0 }, await counts(page));

  // 1. Every source, read in the page.
  const said = [];
  for (const [source, name, bytes] of files) said.push(await drop(page, source, name, bytes));
  check("each import reports what the Node library reports", reports, said);
  check("the counts per source", { chatgpt: 3, claude: 3, gemini: 2, accepted: 0 }, await counts(page));

  // 2. A wrong file: a PNG named as a zip.
  const png = readFileSync("extension/icons/icon-48.png");
  check("a wrong file shows an error", true, (await drop(page, "chatgpt", "export.zip", png)).startsWith("bad: The ChatGPT file is not JSON"));
  check("a wrong file changes no count", { chatgpt: 3, claude: 3, gemini: 2, accepted: 0 }, await counts(page));

  // 3. The page finds what the Node library finds.
  const pending = await shown(page);
  check("the page lists the same candidates as the Node library", expected, pending.map((m) => m.text).toSorted());

  // 4. Accept two, reject one, then reload.
  const [a, b, c] = pending;
  await clickIn(page, `[data-id="${a.id}"] .accept`);
  await poll(page, (id) => !document.querySelector(`[data-id="${id}"]`), a.id);
  await clickIn(page, `[data-id="${b.id}"] .accept`);
  await poll(page, (id) => !document.querySelector(`[data-id="${id}"]`), b.id);
  await clickIn(page, `[data-id="${c.id}"] .reject`);
  await poll(page, (id) => !document.querySelector(`[data-id="${id}"]`), c.id);
  await page.close();
  page = await fox.openExtensionPage("import.html");
  await ready(page);
  const n = expected.length;
  check("after a reload the tabs count the decisions", [`Pending (${n - 3})`, "Accepted (2)", "Rejected (1)"], await tabs(page));
  await clickIn(page, '[data-view="accepted"]');
  await poll(page, () => document.querySelector("#review .memory")?.dataset.status === "accepted");
  check("after a reload the accepted ones are kept", [a.text, b.text].toSorted(), (await shown(page)).map((m) => m.text).toSorted());
  await clickIn(page, '[data-view="rejected"]');
  await poll(page, () => document.querySelector("#review .memory")?.dataset.status === "rejected");
  check("after a reload the rejected one is kept", [c.text], (await shown(page)).map((m) => m.text));
  check("the kept count", 2, (await counts(page)).accepted);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await clickIn(page, '[data-view="accepted"]');
    await poll(page, () => document.querySelector("#review .memory")?.dataset.status === "accepted");
    await page.screenshot({ path: join(shots, "import.png"), fullPage: true });
  }

  // 4b. Two tabs: a forget in one is not undone by the other (K12), and
  // the other tab draws the change (B6).
  const other = await fox.openExtensionPage("import.html");
  await ready(other);
  const d = (await shown(other))[0];
  await clickIn(page, '[data-view="accepted"]');
  await poll(page, (id) => Boolean(document.querySelector(`[data-id="${id}"]`)), a.id);
  await clickIn(page, `[data-id="${a.id}"] .forget`);
  await poll(page, (id) => !document.querySelector(`[data-id="${id}"]`), a.id);
  check("the other tab draws the forget", 1, await poll(other, () => document.querySelector('#counts [data-source="accepted"]')?.dataset.count === "1" && 1));
  await clickIn(other, `[data-id="${d.id}"] .accept`);
  await poll(other, (id) => !document.querySelector(`[data-id="${id}"]`), d.id);
  const stored = await page.evaluate(async (ids) => (await browser.storage.local.get("fpk:pack"))["fpk:pack"].memories.filter((m) => ids.includes(m.id)).map((m) => [m.status, m.text]), [a.id, d.id]);
  check("a forget in one tab stays after an accept in another", [["accepted", d.text], ["forgotten", ""]], stored.toSorted((x, y) => x[0].localeCompare(y[0])));
  await other.close();

  // 5. The export: catch the download link and read the file it points to.
  const exported = await page.evaluate(() => new Promise((done) => {
    HTMLAnchorElement.prototype.click = function () {
      fetch(this.href).then((r) => r.text()).then((text) => done({ name: this.download, text }));
    };
    document.getElementById("format").value = "foxpack";
    document.getElementById("export").click();
  }));
  const file = JSON.parse(exported.text);
  check("the export is a foxpack file", ["foxpack/v1", true], [file.format, /^foxpack-\d{4}-\d{2}-\d{2}\.json$/.test(exported.name)]);
  check("the export has the accepted memories", [b.text, d.text].toSorted(), file.memories.map((m) => m.text).toSorted());
  check("the export has no trace of the forgotten memory", false, exported.text.toLowerCase().includes(a.text.toLowerCase()));
  check("the export has no rejected or pending memory", true, file.memories.every((m) => m.status === "accepted") && !file.memories.some((m) => m.text === c.text));
  check("the export has the conversations", 8, file.conversations.length);
  await page.close();

  // 6. Other extensions ask for memories.
  const web = await fox.open(`${site.url}/index.html`);
  await poll(web, () => document.documentElement.dataset.foxscope_pooriaarab === "ready" && document.documentElement.dataset.stranger_example_com === "ready");
  const fields = ["memory.preferences", "memory.facts", "memory.people", "memory.projects", "memory.conversations"];
  const list = await ask(web, "foxscope@pooriaarab", { type: "scent.list" });
  check("foxscope lists the fields; conversations are private", "private", list.reply?.find((f) => f.name === "memory.conversations")?.sensitivity);
  const read = await ask(web, "foxscope@pooriaarab", { type: "scent.read", fields, derive: true });
  check("foxscope reads the accepted memories only, and no conversations", [b.text, d.text].toSorted(), Object.values(read.reply ?? {}).flat().toSorted());
  check("foxscope gets no memory.conversations key", false, "memory.conversations" in (read.reply ?? {}));
  // A stranger must see what it sees when no add-on has the id (B1).
  const stranger = [await ask(web, "stranger@example.com", { type: "scent.list" }), await ask(web, "stranger@example.com", { type: "scent.read", fields, derive: false })];
  const absent = await ask(web, "stranger@example.com", { type: "scent.list" }, "nobody@foxpack.test");
  record.stranger = stranger;
  record.absent = absent;
  check("a missing add-on gives an error", false, absent.ok);
  check("a stranger gets the same error as for a missing add-on", [absent, absent], stranger);
  await web.evaluate((arg) => {
    document.getElementById("foxscope").textContent = JSON.stringify(arg.read, null, 2);
    document.getElementById("stranger").textContent = JSON.stringify(arg.stranger[1], null, 2);
  }, { read, stranger });
  if (shots) await web.screenshot({ path: join(shots, "site.png"), fullPage: true });

  // 7. The popup.
  const popup = await fox.openExtensionPage("popup.html");
  await poll(popup, () => Boolean(document.getElementById("accepted")));
  check("the popup counts the pack", { conversations: 8, pending: n - 4, accepted: 2 }, await popup.evaluate(() => Object.fromEntries([...document.querySelectorAll(".count")].map((el) => [el.id, Number(el.dataset.count)]))));
  check("the popup lists the foxscope read", true, await popup.evaluate(() => /memory\.preferences|memory\.facts|memory\.people/.test(document.getElementById("reads").textContent)));
  if (shots) await popup.screenshot({ path: join(shots, "popup.png") });
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site.close();
}

record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.filter((c) => c.ok).length}/${record.checks.length}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
