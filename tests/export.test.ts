import { readFileSync } from "node:fs";
import { createMemory, memoryStore } from "foxmemory";
import { describe, expect, it } from "vitest";
import { createPack, escapeMarkdown, exportPack, FoxpackError, inMemoryStore, toDti, type DtiConversation } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const now = () => new Date("2026-10-15T12:00:00Z");

async function reviewed() {
  const pack = createPack({ store: inMemoryStore(), now });
  await pack.import("claude", fixture("claude-conversations.json"));
  await pack.import("memories", "- Prefers tea | not coffee.\n- Is a #1 fan of *jazz*.\n- Likes cold showers.");
  const [ava, bed, tea, jazz, cold] = await pack.memories();
  await pack.accept(ava?.id ?? "");
  await pack.reject(bed?.id ?? "");
  await pack.accept(tea?.id ?? "");
  await pack.accept(jazz?.id ?? "");
  await pack.forget(cold?.id ?? "");
  return pack;
}

const iso = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s));

/** The required fields of the DTI schema, checked by hand (no schema library). */
function dtiShape(c: DtiConversation) {
  const d = c.details;
  const ids = new Set(c.identifiers.map((i) => i.identifier));
  return iso(d.createdAt) && iso(d.startTime) && iso(d.endTime) && typeof d.createdBy === "string" && c.identifiers.length > 0
    && (c.messages === undefined || (c.messages.length > 0 && c.messages.every((m) => iso(m.sentAt) && typeof m.text === "string" && (ids.has(m.sender) || m.sender === "AI"))));
}

describe("export", () => {
  it("E1: every format holds accepted memories only", async () => {
    const pack = await reviewed();
    const file = JSON.parse(await pack.export({ format: "foxpack" })) as { memories: { text: string; status: string }[] };
    expect(file.memories.map((m) => m.text)).toEqual(["My daughter is called Ava and she loves tomatoes.", "Prefers tea | not coffee.", "Is a #1 fan of *jazz*."]);
    expect(file.memories.every((m) => m.status === "accepted")).toBe(true);
    const md = await pack.export({ format: "markdown", conversations: false });
    expect(md).toContain("Ava");
    expect(md).not.toMatch(/raised bed|cold showers/);
    expect(await pack.export({ format: "dti", conversations: false })).toBe("[]\n");
  });

  it("E2: markdown escapes text that would make headings, tables or lists", async () => {
    const md = await (await reviewed()).export({ format: "markdown" });
    expect(md).toContain("- **preference:** Prefers tea \\| not coffee. (foxpack)");
    expect(md).toContain("Is a \\#1 fan of \\*jazz\\*.");
    expect(escapeMarkdown("# x\n- y\n1. z\n<script>")).toBe("\\# x\n\\- y\n\\1. z\n\\<script\\>");
    expect(md).toContain("### Garden planning\n\nClaude, 2026-02-01\n\n**You:**\n\n> My daughter is called Ava and she loves tomatoes.");
  });

  it("E3 + E8: a foxpack export reads back into an empty pack, with its memories to review", async () => {
    const text = await (await reviewed()).export({ format: "foxpack" });
    const memory = createMemory({ store: memoryStore(), embedder: { embed: async (t: string[]) => ({ model: "fixed", vectors: t.map(() => [1]) }) } });
    const fresh = createPack({ store: inMemoryStore(), memory, now });
    expect(await fresh.restore(text)).toEqual({ conversations: 3, memories: 3 });
    expect((await fresh.memories()).map((m) => [m.status, m.decidedAt])).toEqual([["pending", null], ["pending", null], ["pending", null]]);
    expect((await fresh.conversations()).length).toBe(3);
    expect(await memory.list()).toEqual([]);
    await expect(fresh.restore("{}")).rejects.toThrow(FoxpackError);
  });

  it("E7: a restore file with one bad record is bad_export and saves nothing", async () => {
    const file = JSON.parse(await (await reviewed()).export({ format: "foxpack" }));
    const [c] = file.conversations;
    const [m] = file.memories;
    const bad = [
      { conversations: [{ id: "z" }] },
      { conversations: [{ ...c, source: "bard" }] },
      { conversations: [{ ...c, createdAt: "yesterday" }] },
      { conversations: [{ ...c, messages: [{ ...c.messages[0], role: "system" }] }] },
      { conversations: [c, c] },
      { memories: [{ ...m, kind: "weird" }] },
      { memories: [{ ...m, seenIn: "2" }] },
      { memories: [{ ...m, conversationId: 7 }] },
      { memories: [{ ...m, source: "bard" }] },
      { memories: [m, m] },
    ];
    const store = inMemoryStore();
    const pack = createPack({ store, now });
    await pack.import("memories", "- Likes long walks.");
    const before = JSON.stringify(store.saved);
    for (const patch of bad) {
      const error = await pack.restore(JSON.stringify({ ...file, ...patch })).then(() => null, (e: unknown) => e);
      expect(error, JSON.stringify(patch).slice(0, 80)).toMatchObject({ code: "bad_export", message: expect.stringMatching(/conversation|memor/) });
    }
    expect(JSON.stringify(store.saved)).toBe(before);
    expect((await pack.stats()).memories.pending).toBe(1);
  });

  it("E3: restore keeps a local rejection", async () => {
    const pack = await reviewed();
    const text = await pack.export({ format: "foxpack" });
    const ava = (await pack.memories({ status: "accepted" }))[0];
    await pack.reject(ava?.id ?? "");
    expect((await pack.restore(text)).memories).toBe(0);
    expect((await pack.memories({ status: "rejected" })).map((m) => m.id)).toContain(ava?.id);
  });

  it("E5: a deeply nested restore file is bad_export, and saves nothing", async () => {
    const store = inMemoryStore();
    const pack = createPack({ store, now });
    const file = JSON.parse(await (await reviewed()).export({ format: "foxpack" }));
    for (const depth of [17, 5000]) {
      const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
      const text = JSON.stringify({ ...file, memories: [{ ...file.memories[0], note: "{[]} \\\" [" }] }).replace('"note":', `"deep":${deep},"note":`);
      const error = await pack.restore(text).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(FoxpackError);
      expect(error).toMatchObject({ code: "bad_export", message: expect.stringMatching(/16 levels/) });
    }
    expect(store.saved).toBeNull();
    expect(await pack.restore(JSON.stringify({ ...file, memories: [{ ...file.memories[0], note: "[[[[[[[[[[[[[[[[[[[[" }] }))).toMatchObject({ memories: 1 });
  });

  it("E6: an export has no originalText, foxmemoryId or other hidden field", async () => {
    const memory = createMemory({ store: memoryStore(), embedder: { embed: async (t: string[]) => ({ model: "fixed", vectors: t.map(() => [1]) }) } });
    const store = inMemoryStore();
    const pack = createPack({ store, memory, now });
    await pack.import("claude", fixture("claude-conversations.json"));
    const [ava] = await pack.memories();
    await pack.accept(ava?.id ?? "");
    await pack.edit(ava?.id ?? "", "I have a daughter.");
    const stored = store.saved as unknown as { conversations: Record<string, unknown>[] };
    stored.conversations[0] = { ...stored.conversations[0], secret: "hidden" };
    const text = await pack.export({ format: "foxpack" });
    const file = JSON.parse(text);
    expect(Object.keys(file.memories[0]).toSorted()).toEqual(["confidence", "conversationId", "date", "decidedAt", "id", "kind", "seenIn", "source", "status", "text"]);
    expect(Object.keys(file.conversations[0]).toSorted()).toEqual(["createdAt", "id", "messages", "source", "title", "updatedAt"]);
    expect(text).not.toContain("hidden");
    for (const format of ["foxpack", "markdown"] as const) expect(await pack.export({ format, conversations: false })).not.toMatch(/tomatoes|called Ava/);
    const fresh = createPack({ store: inMemoryStore(), now });
    await fresh.restore(text);
    expect((await fresh.memories()).map((m) => [m.text, m.originalText])).toEqual([["I have a daughter.", "I have a daughter."]]);
  });

  it("E4: an unknown format is bad_input and names the formats", () => {
    expect(() => exportPack({ format: "foxpack/v1", conversations: [], memories: [], imports: [] }, { format: "csv" as never })).toThrow(/foxpack, dti, markdown/);
  });

  it("DTI: one object per conversation with the schema's required fields", async () => {
    const out = JSON.parse(await (await reviewed()).export({ format: "dti" })) as DtiConversation[];
    // The third Claude conversation has no time and no messages, so it cannot be written.
    expect(out).toHaveLength(2);
    expect(out.every(dtiShape)).toBe(true);
    expect(out[0]).toMatchObject({ details: { createdBy: "Claude", createdAt: "2026-10-15T12:00:00.000Z", startTime: "2026-02-01T10:00:00.000Z", modality: "text" }, identifiers: [{ name: "User", identifier: "user" }] });
    expect(out[0]?.messages?.map((m) => m.sender)).toEqual(["user", "AI", "user"]);
  });

  it("DTI: a message with no time takes the start; a conversation with no time is left out", () => {
    const base = { id: "x", source: "chatgpt" as const, title: "t", updatedAt: null };
    const msg = { id: "m", role: "user" as const, text: "hi", createdAt: null };
    expect(toDti({ ...base, createdAt: "2026-01-01T00:00:00.000Z", messages: [msg] }, "2026-10-15T00:00:00.000Z")?.messages?.[0]?.sentAt).toBe("2026-01-01T00:00:00.000Z");
    expect(toDti({ ...base, createdAt: null, messages: [msg] }, "2026-10-15T00:00:00.000Z")).toBeNull();
    expect(toDti({ ...base, createdAt: "2026-01-01T00:00:00.000Z", messages: [] }, "2026-10-15T00:00:00.000Z")?.messages).toBeUndefined();
  });
});
