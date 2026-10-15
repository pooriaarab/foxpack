import { readFileSync } from "node:fs";
import { createMemory, memoryStore } from "foxmemory";
import { describe, expect, it } from "vitest";
import { createPack, FoxpackError, inMemoryStore, type MemorySink } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const errorCode = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof FoxpackError ? e.code : String(e)));
// A fixed embedder: these tests check storage, not recall.
const embedder = { embed: async (texts: string[]) => ({ model: "fixed-v1", vectors: texts.map(() => [1, 0]) }) };
const foxmemory = () => createMemory({ store: memoryStore(), embedder });

const say = (uuid: string, sender: string, text: string) => ({ uuid, sender, text, created_at: "2026-03-01T10:00:00Z" });
const prompt = (text: string, link: string) => ({ header: "Gemini Apps", title: `Prompted ${text}`, titleUrl: `https://gemini.google.com/app/${link}`, time: "2026-04-02T03:00:10.000Z", products: ["Gemini Apps"] });
const bigTurn = (i: number) => ({ uuid: `u${i}`, sender: "human", text: `${"We talked about the garden again. ".repeat(60)}I prefer red tomatoes number ${i}.`, created_at: "2026-03-01T10:00:00Z" });

async function filled(memory?: MemorySink) {
  const store = inMemoryStore();
  const pack = createPack({ store, memory, now: () => new Date("2026-10-15T12:00:00Z") });
  await pack.import("claude", fixture("claude-conversations.json"));
  return { store, pack };
}

describe("createPack", () => {
  it("imports a file and lists its conversations and candidates", async () => {
    const { pack } = await filled();
    expect((await pack.conversations()).map((c) => c.id)).toEqual(["claude:0b1c2d3e-0001", "claude:0b1c2d3e-0003", "claude:0b1c2d3e-0002"]);
    expect((await pack.memories()).map((m) => [m.status, m.kind])).toEqual([["pending", "person"], ["pending", "project"]]);
    const stats = await pack.stats();
    expect(stats).toMatchObject({ conversations: 3, messages: 6, bySource: { claude: 3, chatgpt: 0 }, memories: { pending: 2, accepted: 0 } });
    expect(stats.imports).toEqual([{ source: "claude", at: "2026-10-15T12:00:00.000Z", conversations: 3, candidates: 2, skipped: 1 }]);
  });

  it("P14 + K1: a second import replaces conversations and keeps every decision", async () => {
    const { pack } = await filled();
    const [first, second] = await pack.memories();
    await pack.reject(first?.id ?? "");
    await pack.accept(second?.id ?? "");
    const again = await pack.import("claude", fixture("claude-conversations.json"));
    expect(again.added).toBe(0);
    expect((await pack.conversations()).length).toBe(3);
    expect((await pack.memories()).map((m) => m.status)).toEqual(["rejected", "accepted"]);
  });

  it("K2: an unknown id is not_found and changes nothing", async () => {
    const { pack, store } = await filled();
    const before = JSON.stringify(store.saved);
    for (const call of [pack.accept("nope"), pack.reject("nope"), pack.edit("nope", "x"), pack.forget("nope")]) expect(await errorCode(call)).toBe("not_found");
    expect(JSON.stringify(store.saved)).toBe(before);
  });

  it("K3: an empty or too long edit is bad_input", async () => {
    const { pack } = await filled();
    const [m] = await pack.memories();
    expect(await errorCode(pack.edit(m?.id ?? "", "   "))).toBe("bad_input");
    expect(await errorCode(pack.edit(m?.id ?? "", "x".repeat(501)))).toBe("bad_input");
    const edited = await pack.edit(m?.id ?? "", "  My daughter is Ava.  ");
    expect([edited.text, edited.originalText]).toEqual(["My daughter is Ava.", "My daughter is called Ava and she loves tomatoes."]);
  });

  it("K4 + K10: accept, edit and forget reach foxmemory; forget keeps a tombstone", async () => {
    const memory = foxmemory();
    const { pack } = await filled(memory);
    const [m] = await pack.memories();
    const accepted = await pack.accept(m?.id ?? "");
    expect((await memory.list()).map((x) => [x.text, x.kind, x.source])).toEqual([["My daughter is called Ava and she loves tomatoes.", "fact", "claude:0b1c2d3e-0001"]]);
    await pack.edit(accepted.id, "My daughter is Ava.");
    expect((await memory.list()).map((x) => x.text)).toEqual(["My daughter is Ava."]);
    const gone = await pack.forget(accepted.id);
    expect(await memory.list()).toEqual([]);
    expect([gone.status, gone.text, gone.originalText]).toEqual(["forgotten", "", ""]);
    expect(await pack.memories()).toHaveLength(1);
    await pack.import("claude", fixture("claude-conversations.json"));
    expect((await pack.memories({ status: "forgotten" })).map((x) => x.id)).toEqual([accepted.id]);
    expect(await errorCode(pack.accept(accepted.id))).toBe("bad_input");
  });

  it("K4: reject of an accepted memory removes it from foxmemory", async () => {
    const memory = foxmemory();
    const { pack } = await filled(memory);
    const [m] = await pack.memories();
    await pack.accept(m?.id ?? "");
    await pack.reject(m?.id ?? "");
    expect(await memory.list()).toEqual([]);
  });

  it("K11: forget deletes the sentence from the conversations, also after a re-import and a restore", async () => {
    const chat = JSON.stringify([{
      uuid: "c1", name: "Family", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T10:01:00Z",
      chat_messages: [
        { uuid: "u1", sender: "human", text: "Also, my sister Jane has epilepsy. I like green tea.", created_at: "2026-03-01T10:00:00Z" },
        { uuid: "a1", sender: "assistant", text: "Green tea is nice.", created_at: "2026-03-01T10:00:05Z" },
      ],
    }]);
    const { pack } = await filled();
    await pack.import("claude", chat);
    const sister = (await pack.memories({ query: "epilepsy" }))[0];
    const backup = await pack.export({ format: "foxpack" });
    await pack.accept(sister?.id ?? "");
    await pack.forget(sister?.id ?? "");
    const gone = async () => {
      expect(await pack.search("epilepsy")).toEqual([]);
      expect(JSON.stringify(await pack.data())).not.toMatch(/epilepsy/i);
      for (const format of ["foxpack", "dti", "markdown"] as const) expect(await pack.export({ format })).not.toMatch(/epilepsy/i);
    };
    await gone();
    const messages = (await pack.conversations()).find((c) => c.id === "claude:c1")?.messages.map((m) => m.text);
    expect(messages).toEqual(["[forgotten] I like green tea.", "Green tea is nice."]);
    await pack.import("claude", chat);
    await gone();
    await pack.restore(backup);
    await gone();
    expect((await pack.memories({ query: "green tea" })).length).toBe(1);
  });

  it("K14: forget removes only the source sentences, also when the memory was edited to a short text", async () => {
    const chat = JSON.stringify([
      { uuid: "c1", name: "Family", created_at: "2026-03-01T10:00:00Z", chat_messages: [
        say("u1", "human", "Then I said I live in Paris 🙂. I live in Paris. My friend Janet is a nurse `ok`. My sister Jane has epilepsy. I bike in the city."),
        say("a1", "assistant", "You live in Paris, and I hope Jane is well. My sister Jane has epilepsy, you said."),
      ] },
      { uuid: "c2", name: "Bikes", created_at: "2026-03-02T10:00:00Z", chat_messages: [
        say("u2", "human", "Janet and I ride bikes. I live in Paris. I like it here."),
        say("a2", "assistant", "Is Janet in Paris too?"),
      ] },
    ]);
    const store = inMemoryStore();
    const pack = createPack({ store });
    await pack.import("claude", chat);
    const paris = (await pack.memories({ query: "i live in paris" }))[0];
    const sister = (await pack.memories({ query: "epilepsy" }))[0];
    expect([paris?.text, paris?.seenIn, sister?.text]).toEqual(["I live in Paris.", 2, "My sister Jane has epilepsy."]);
    await pack.edit(paris?.id ?? "", "I");
    await pack.edit(sister?.id ?? "", "Jane");
    await pack.forget(paris?.id ?? "");
    await pack.forget(sister?.id ?? "");
    expect((await pack.conversations()).map((c) => [c.title, c.messages.map((m) => m.text)])).toEqual([
      ["Family", [
        "Then I said I live in Paris 🙂. [forgotten] My friend Janet is a nurse `ok`. [forgotten] I bike in the city.",
        "You live in Paris, and I hope Jane is well. My sister Jane has epilepsy, you said.",
      ]],
      ["Bikes", ["Janet and I ride bikes. [forgotten] I like it here.", "Is Janet in Paris too?"]],
    ]);
  });

  it("K15: forget removes the sentence from a title that holds it, and keeps a title in other words", async () => {
    const long = `My sister Jane has epilepsy. ${"We plan a long trip by train and by boat. ".repeat(3)}`;
    const claude = JSON.stringify([
      { uuid: "c1", name: "My sister Jane has epilepsy.", created_at: "2026-03-01T10:00:00Z", chat_messages: [say("u1", "human", "My sister Jane has epilepsy. I like green tea.")] },
      { uuid: "c2", name: "Jane's epilepsy", created_at: "2026-03-02T10:00:00Z", chat_messages: [say("u2", "human", "My sister Jane has epilepsy.")] },
      { uuid: "c3", name: "My sister Jane has epilepsy.", created_at: "2026-03-03T10:00:00Z", chat_messages: [say("u3", "human", "I like black tea.")] },
    ]);
    const store = inMemoryStore();
    const pack = createPack({ store });
    await pack.import("claude", claude);
    await pack.import("gemini", JSON.stringify([prompt("My sister Jane has epilepsy. Is a beach safe?", "1a"), prompt(long, "2b")]));
    const titles = async () => (await pack.conversations()).map((c) => c.title);
    expect((await titles()).slice(3)).toEqual(["My sister Jane has epilepsy. Is a beach safe?", `${long.slice(0, 79)}…`]);
    await pack.forget((await pack.memories({ query: "epilepsy" }))[0]?.id ?? "");
    // c3 holds the sentence in its title only, so it is not where the memory came from.
    const after = ["[forgotten]", "Jane's epilepsy", "My sister Jane has epilepsy.", "[forgotten] Is a beach safe?", `[forgotten] ${long.slice(29, 96)}…`];
    expect(await titles()).toEqual(after);
    await pack.import("claude", claude);
    await pack.import("gemini", JSON.stringify([prompt("My sister Jane has epilepsy. Is a beach safe?", "1a"), prompt(long, "2b")]));
    expect(await titles()).toEqual(after);
  });

  it("K12: a forget in one pack is not undone by a second pack on the same store", async () => {
    const store = inMemoryStore();
    const a = createPack({ store });
    const b = createPack({ store });
    await a.import("memories", "- My sister Jane has epilepsy.\n- Likes long walks.");
    const [sister, walks] = await b.memories();
    await a.accept(sister?.id ?? "");
    await a.forget(sister?.id ?? "");
    await b.accept(walks?.id ?? "");
    expect(store.saved?.memories.map((m) => [m.status, m.text])).toEqual([["forgotten", ""], ["accepted", "Likes long walks."]]);
    expect(await errorCode(b.accept(sister?.id ?? ""))).toBe("bad_input");
    await Promise.all([a.import("memories", "- Prefers tea."), b.import("memories", "- Prefers jazz.")]);
    expect((await a.memories({ status: "pending" })).map((m) => m.text).toSorted()).toEqual(["Prefers jazz.", "Prefers tea."]);
  });

  it("K13: a review click on a pack with 20 MB of conversations takes under 2 s", async () => {
    const chats = Array.from({ length: 200 }, (_, c) => ({ uuid: `c${c}`, name: `Chat ${c}`, created_at: "2026-03-01T10:00:00Z", chat_messages: Array.from({ length: 50 }, (__, i) => bigTurn(c * 50 + i)) }));
    const store = inMemoryStore();
    const pack = createPack({ store });
    await pack.import("claude", JSON.stringify(chats), { maxBytes: 64 * 1024 * 1024 });
    expect(JSON.stringify(store.saved).length).toBeGreaterThan(20_000_000);
    const [m] = await pack.memories({ query: "number 7." });
    const started = performance.now();
    await pack.accept(m?.id ?? "");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("K5: when foxmemory fails, the candidate stays pending", async () => {
    const broken: MemorySink = { remember: async () => Promise.reject(new Error("disk full")), update: async () => undefined, forget: async () => true };
    const { pack } = await filled(broken);
    const [m] = await pack.memories();
    expect(await errorCode(pack.accept(m?.id ?? ""))).toBe("Error: disk full");
    expect((await pack.memories())[0]?.status).toBe("pending");
  });

  it("K6: a corrupt or newer stored pack is corrupt_store, and is not replaced", async () => {
    const good = (await filled()).store.saved as unknown as { conversations: Record<string, unknown>[]; memories: Record<string, unknown>[]; imports: Record<string, unknown>[] };
    const [c] = good.conversations;
    const [m] = good.memories;
    const [i] = good.imports;
    const corrupt = [
      { conversations: [{ id: "z" }] },
      { conversations: [{ ...c, title: null }] },
      { conversations: [c, c] },
      { memories: [{ ...m, kind: "weird" }] },
      { memories: [{ ...m, status: "maybe" }] },
      { memories: [{ ...m, originalText: undefined }] },
      { memories: [{ ...m, decidedAt: "soon" }] },
      { memories: [{ ...m, foxmemoryId: 1 }] },
      { imports: [{ ...i, skipped: -1 }] },
    ].map((patch) => ({ ...good, ...patch }));
    for (const bad of ["text", [1], { format: "foxpack/v9", conversations: [], memories: [], imports: [] }, { format: "foxpack/v1" }, { format: "foxpack/v1", conversations: [], memories: [{ id: 1 }], imports: [] }, ...corrupt]) {
      const store = inMemoryStore(bad);
      const pack = createPack({ store });
      expect(await errorCode(pack.stats())).toBe("corrupt_store");
      expect(await errorCode(pack.import("claude", fixture("claude-conversations.json")))).toBe("corrupt_store");
      expect(store.saved).toEqual(bad);
    }
    await expect(createPack({ store: inMemoryStore({ format: "foxpack/v9", conversations: [], memories: [], imports: [] }) }).stats()).rejects.toThrow(/foxpack\/v9/);
    const extra = createPack({ store: inMemoryStore({ ...good, memories: [{ ...m, deep: [[["x"]]] }] }) });
    expect(Object.keys((await extra.data()).memories[0] ?? {})).not.toContain("deep");
  });

  it("K7: a failed import writes nothing", async () => {
    const { pack, store } = await filled();
    const before = JSON.stringify(store.saved);
    expect(await errorCode(pack.import("chatgpt", fixture("claude-conversations.json")))).toBe("bad_export");
    expect(await errorCode(pack.import("gemini" as never, new Uint8Array([0x50, 0x4b, 3, 4, 0])))).toBe("corrupt_zip");
    expect(await errorCode(pack.import("bard" as never, "x"))).toBe("bad_input");
    expect(JSON.stringify(store.saved)).toBe(before);
  });

  it("K8: calls at the same time all land", async () => {
    const { pack } = await filled();
    const ids = (await pack.memories()).map((m) => m.id);
    await Promise.all([pack.accept(ids[0] ?? ""), pack.reject(ids[1] ?? ""), pack.import("memories", "- Likes long walks.\n- Is a morning person.")]);
    expect((await pack.memories()).map((m) => m.status)).toEqual(["accepted", "rejected", "pending", "pending"]);
  });

  it("K9: search needs a query, finds text and titles, and stops at the limit", async () => {
    const { pack } = await filled();
    expect(await errorCode(pack.search("  "))).toBe("bad_input");
    const hits = await pack.search("TOMATOES");
    expect(hits.map((h) => [h.conversationId, h.role])).toEqual([["claude:0b1c2d3e-0001", "user"], ["claude:0b1c2d3e-0001", "assistant"]]);
    expect(hits[0]?.snippet).toBe("My daughter is called Ava and she loves tomatoes.");
    expect((await pack.search("branched")).map((h) => h.conversationId)).toEqual(["claude:0b1c2d3e-0003"]);
    expect(await pack.search("o", { limit: 1 })).toHaveLength(1);
  });

  it("clear deletes everything, here and in foxmemory", async () => {
    const memory = foxmemory();
    const { pack } = await filled(memory);
    await pack.accept((await pack.memories())[0]?.id ?? "");
    await pack.clear();
    expect(await pack.stats()).toMatchObject({ conversations: 0, memories: { pending: 0, accepted: 0, rejected: 0, forgotten: 0 } });
    expect(await memory.list()).toEqual([]);
  });

  it("filters memories by status, kind and text", async () => {
    const { pack } = await filled();
    expect((await pack.memories({ kind: "project" })).map((m) => m.kind)).toEqual(["project"]);
    expect((await pack.memories({ query: "AVA" })).map((m) => m.kind)).toEqual(["person"]);
    expect(await pack.memories({ status: "accepted" })).toEqual([]);
  });
});
