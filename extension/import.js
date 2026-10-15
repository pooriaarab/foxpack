// The import page. It reads an export file in this page, with no upload
// (B3), keeps the pack in storage.local, and lists the memory candidates
// for review. Each decision is saved before the list changes (B5).
import { createPack, DEFAULT_MAX_BYTES, FoxpackError, SERVICE, storageStore } from "../src/index.ts";

const pack = createPack({ store: storageStore(browser.storage.local) });
const $ = (id) => document.getElementById(id);
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", memories: "Memory lists" };
let view = "pending";
let editing = null;

function say(kind, text) {
  $("status").className = kind;
  $("status").textContent = text;
}

function el(tag, { dataset = {}, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

// The file name hints at the source; the user can still change it.
function guessSource(name) {
  if (/myactivity|takeout/i.test(name)) return "gemini";
  if (/\.(txt|md)$/i.test(name)) return "memories";
  return null;
}

async function importFile(file) {
  if (!file) return;
  const source = $("source").value;
  if (file.size > DEFAULT_MAX_BYTES) return say("bad", `${file.name} is larger than 256 MiB. foxpack does not read files that large.`);
  say("busy", `Reading ${file.name} on this computer…`);
  try {
    const r = await pack.import(source, new Uint8Array(await file.arrayBuffer()));
    const skipped = r.skipped ? `, ${r.skipped} ${r.skipped === 1 ? "entry" : "entries"} skipped` : "";
    say("ok", `${LABELS[source]}: ${r.conversations} conversations and ${r.added} new memories to review${skipped}.`);
  } catch (error) {
    say("bad", error instanceof FoxpackError ? error.message : `foxpack could not read ${file.name}: ${error.message}`);
  }
  $("file").value = "";
  await render();
}

function countCard(value, label, source) {
  return el("div", { className: "count", dataset: { source, count: String(value) } }, el("b", { textContent: String(value) }), el("span", { textContent: label }));
}

async function act(fn) {
  try {
    await fn();
  } catch (error) {
    say("bad", error.message);
  }
  editing = null;
  await render();
}

function memoryCard(m) {
  const date = m.date ? ` · ${m.date.slice(0, 10)}` : "";
  const head = el("div", { className: "memory-head" }, el("span", { className: "chip", textContent: m.kind }), el("span", { textContent: `${Math.round(m.confidence * 100)}% sure` }), el("span", { textContent: `${SERVICE[m.source]}${date}` }));
  const card = el("li", { className: `memory ${m.status}`, dataset: { id: m.id, status: m.status } }, head);
  const button = (text, className, fn) => el("button", { className: `small ${className}`, textContent: text, onclick: () => act(fn) });
  if (editing === m.id) {
    const box = el("textarea", { value: m.text, maxLength: 500, ariaLabel: "Memory text" });
    card.append(box, el("div", { className: "answers" }, button("Cancel", "ghost", async () => {}), button("Save", "primary", () => pack.edit(m.id, box.value))));
    queueMicrotask(() => box.focus());
    return card;
  }
  const edit = el("button", { className: "small ghost edit", textContent: "Edit", onclick: () => ((editing = m.id), render()) });
  const answers = el("div", { className: "answers" }, edit);
  if (m.status === "pending") answers.append(button("Reject", "reject", () => pack.reject(m.id)), button("Accept", "primary accept", () => pack.accept(m.id)));
  if (m.status === "accepted") answers.append(button("Forget", "danger forget", () => pack.forget(m.id)));
  if (m.status === "rejected") answers.append(button("Accept", "accept", () => pack.accept(m.id)));
  card.append(el("p", { className: "memory-text", textContent: m.text }), answers);
  return card;
}

async function render() {
  const stats = await pack.stats().catch((error) => (say("bad", error.message), null));
  if (!stats) return;
  $("counts").replaceChildren(
    ...["chatgpt", "claude", "gemini"].map((s) => countCard(stats.bySource[s], `${LABELS[s]} conversations`, s)),
    countCard(stats.memories.accepted, "Memories kept", "accepted"),
  );
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
    tab.textContent = `${tab.dataset.view[0].toUpperCase()}${tab.dataset.view.slice(1)} (${stats.memories[tab.dataset.view]})`;
  }
  // The surest candidates first.
  const list = (await pack.memories({ status: view })).toSorted((a, b) => b.confidence - a.confidence);
  $("review").replaceChildren(...(list.length ? list.map(memoryCard) : [el("li", { className: "note empty", textContent: view === "pending" ? "Nothing to review. Import an export above." : `No ${view} memories.` })]));
}

async function exportPack() {
  const format = $("format").value;
  const text = await pack.export({ format });
  const name = `foxpack-${new Date().toISOString().slice(0, 10)}.${format === "markdown" ? "md" : "json"}`;
  const url = URL.createObjectURL(new Blob([text], { type: format === "markdown" ? "text/markdown" : "application/json" }));
  el("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  say("ok", `Saved ${name}.`);
}

$("file").addEventListener("change", (e) => importFile(e.target.files[0]));
$("file").addEventListener("click", () => say("", ""));
$("drop").addEventListener("dragover", (e) => (e.preventDefault(), $("drop").classList.add("over")));
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const file = e.dataTransfer.files[0];
  const guess = file && guessSource(file.name);
  if (guess) $("source").value = guess;
  importFile(file);
});
for (const tab of document.querySelectorAll(".tabs button")) tab.addEventListener("click", () => ((view = tab.dataset.view), render()));
$("export").addEventListener("click", () => exportPack().catch((error) => say("bad", error.message)));
$("clear").addEventListener("click", () => {
  if (confirm("Delete every imported conversation and memory from foxpack?")) act(() => pack.clear()).then(() => say("ok", "The pack is empty."));
});
render().catch((error) => say("bad", error.message));
