// The toolbar popup: what the pack holds, a link to the import page, and
// the last reads by foxscope (the SCENT notice). It only reads storage.
import { packStats, parsePack, PACK_KEY, READS_KEY } from "../src/index.ts";

const $ = (id) => document.getElementById(id);

function card(value, label, id) {
  const node = document.createElement("div");
  node.className = "count";
  node.dataset.count = String(value);
  node.id = id;
  const b = document.createElement("b");
  b.textContent = String(value);
  const span = document.createElement("span");
  span.textContent = label;
  node.append(b, span);
  return node;
}

async function render() {
  const items = await browser.storage.local.get([PACK_KEY, READS_KEY]);
  let stats;
  try {
    stats = packStats(parsePack(items[PACK_KEY] ?? null));
  } catch (error) {
    $("counts").textContent = error.message;
    return;
  }
  $("counts").replaceChildren(
    card(stats.conversations, "Conversations", "conversations"),
    card(stats.memories.pending, "To review", "pending"),
    card(stats.memories.accepted, "Memories kept", "accepted"),
  );
  const reads = (items[READS_KEY] ?? []).toReversed().slice(0, 5);
  if (reads.length === 0) return;
  $("reads").replaceChildren(
    ...reads.map((r) => {
      const li = document.createElement("li");
      li.textContent = `${new Date(r.at).toLocaleString()}: ${r.fields.length ? r.fields.join(", ") : "no fields"}`;
      return li;
    }),
  );
}

$("open").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
render();
