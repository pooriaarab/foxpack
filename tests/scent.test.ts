import { describe, expect, it } from "vitest";
import { createPack, inMemoryStore, memoryResolver } from "../src/index.js";

async function resolver() {
  const pack = createPack({ store: inMemoryStore() });
  await pack.import("claude", JSON.stringify([{ uuid: "c1", name: "t", created_at: "2026-05-01T00:00:00Z", chat_messages: [
    { uuid: "m1", sender: "human", text: "I prefer aisle seats. My sister lives in Oslo. I'm building a bike app. Call me Sam.", created_at: "2026-05-01T00:00:00Z" },
  ] }]));
  const [aisle, sister, , sam] = await pack.memories();
  await pack.accept(aisle?.id ?? "");
  await pack.accept(sister?.id ?? "");
  await pack.reject(sam?.id ?? "");
  return memoryResolver(pack);
}

describe("memoryResolver", () => {
  it("lists the memory fields, with conversations private", async () => {
    const r = await resolver();
    expect(r.namespace).toBe("memory");
    const fields = await r.list();
    expect(fields.map((f) => [f.name, f.sensitivity])).toEqual([
      ["memory.preferences", "ask"], ["memory.facts", "ask"], ["memory.people", "ask"], ["memory.projects", "ask"], ["memory.conversations", "private"],
    ]);
  });

  it("S1: never returns conversations, even by name", async () => {
    const r = await resolver();
    const values = await r.read(["memory.conversations", "memory.preferences"], { derive: false });
    expect(Object.keys(values)).toEqual(["memory.preferences"]);
    expect(JSON.stringify(values)).not.toMatch(/Oslo.*Sam|bike app|c1/);
  });

  it("S2: returns accepted memories only", async () => {
    const values = await (await resolver()).read(["memory.preferences", "memory.people", "memory.projects", "memory.facts"], { derive: true });
    expect(values).toEqual({ "memory.preferences": ["I prefer aisle seats."], "memory.people": ["My sister lives in Oslo."], "memory.projects": [], "memory.facts": [] });
  });

  it("S3: leaves out unknown and other-namespace fields without throwing", async () => {
    const r = await resolver();
    expect(await r.read(["prefs.shopping.size.top", "memory.nope", "memory", "__proto__", 42 as never], { derive: false })).toEqual({});
  });

  it("S4: derive gives only the texts; otherwise text, source and date", async () => {
    const r = await resolver();
    expect(await r.read(["memory.preferences"], { derive: true })).toEqual({ "memory.preferences": ["I prefer aisle seats."] });
    expect(await r.read(["memory.preferences"], { derive: false })).toEqual({ "memory.preferences": [{ text: "I prefer aisle seats.", source: "claude", date: "2026-05-01T00:00:00.000Z" }] });
  });
});
