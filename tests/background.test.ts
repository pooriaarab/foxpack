import { describe, expect, it } from "vitest";
import { createPack, FOXSCOPE_ID, PACK_KEY, READS_KEY, scentListener, storageStore, type StorageArea } from "../src/index.js";

/** A stand-in for browser.storage.local. */
function area(initial: Record<string, unknown> = {}): StorageArea & { items: Record<string, unknown> } {
  const items = structuredClone(initial);
  return {
    items,
    get: async (key) => (key in items ? { [key]: structuredClone(items[key]) } : {}),
    set: async (next) => void Object.assign(items, structuredClone(next)),
  };
}

async function filled() {
  const storage = area();
  const pack = createPack({ store: storageStore(storage) });
  await pack.import("memories", "- Prefers aisle seats.\n- Has a sister named Lea.");
  const [aisle] = await pack.memories();
  await pack.accept(aisle?.id ?? "");
  return { storage, listen: scentListener(storage, () => new Date("2026-10-15T12:00:00Z")) };
}

const foxscope = { id: FOXSCOPE_ID };

describe("the extension's onMessageExternal listener", () => {
  it("B1: answers foxscope; anybody else gets the error of a missing add-on", async () => {
    const { listen } = await filled();
    for (const sender of [{ id: "evil@example.com" }, { id: "foxscope@pooriaarab.evil" }, {}, undefined, { id: "FOXSCOPE@POORIAARAB" }]) {
      for (const message of [{ type: "scent.list" }, { type: "scent.read", fields: ["memory.preferences"] }, { type: "scent.write" }, null]) {
        await expect(listen(message, sender)).rejects.toThrow(/^Could not establish connection\. Receiving end does not exist\.$/);
      }
    }
    expect(((await listen({ type: "scent.list" }, foxscope)) as { name: string }[]).map((f) => f.name)).toContain("memory.preferences");
  });

  it("S2 + S4: foxscope reads accepted memories only, and derive is passed through", async () => {
    const { listen, storage } = await filled();
    expect(await listen({ type: "scent.read", fields: ["memory.preferences", "memory.people", "memory.conversations"], derive: true }, foxscope)).toEqual({ "memory.preferences": ["Prefers aisle seats."], "memory.people": [] });
    expect(await listen({ type: "scent.read", fields: ["memory.preferences"], derive: "yes" }, foxscope)).toEqual({ "memory.preferences": [{ text: "Prefers aisle seats.", source: "memories", date: null }] });
    expect(storage.items[READS_KEY]).toEqual([
      { at: "2026-10-15T12:00:00.000Z", fields: ["memory.preferences", "memory.people"] },
      { at: "2026-10-15T12:00:00.000Z", fields: ["memory.preferences"] },
    ]);
  });

  it("B2: unknown types get no answer; bad fields get an error; it never throws", async () => {
    const { listen } = await filled();
    expect(listen({ type: "scent.write", fields: [] }, foxscope)).toBeUndefined();
    expect(listen(null, foxscope)).toBeUndefined();
    expect(listen("scent.list", foxscope)).toBeUndefined();
    expect(await listen({ type: "scent.read", fields: "memory.preferences" }, foxscope)).toEqual({ error: "fields must be an array of up to 50 field names." });
    expect(await listen({ type: "scent.read", fields: [1] }, foxscope)).toHaveProperty("error");
    expect(await listen({ type: "scent.read", fields: Array.from({ length: 51 }, () => "memory.facts") }, foxscope)).toHaveProperty("error");
  });

  it("K12: two pages on one storage area never lose a write", async () => {
    const storage = area();
    const slow: StorageArea = { get: async (key) => (await new Promise((done) => setTimeout(done, 5)), storage.get(key)), set: storage.set };
    const [a, b] = [createPack({ store: storageStore(slow) }), createPack({ store: storageStore(slow) })];
    await Promise.all(["- Prefers tea.", "- Prefers jazz.", "- Likes long walks.", "- Is a morning person."].map((list, i) => (i % 2 ? b : a).import("memories", list)));
    expect((await a.memories()).length).toBe(4);
  });

  it("K6: a corrupt stored pack gives an error answer, not a throw", async () => {
    const listen = scentListener(area({ [PACK_KEY]: { format: "foxpack/v9" } }));
    expect(await listen({ type: "scent.read", fields: ["memory.facts"] }, foxscope)).toEqual({ error: expect.stringMatching(/foxpack\/v9/) });
  });
});
