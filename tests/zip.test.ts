import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FoxpackError, readExport } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxpackError ? error.code : String(error);
  }
  return "no error";
};

describe("readExport", () => {
  it("Z1: a corrupt or cut zip throws corrupt_zip", () => {
    const good = zip({ "conversations.json": fixture("chatgpt-conversations.json") });
    expect(code(() => readExport("chatgpt", good.subarray(0, good.length - 40)))).toBe("corrupt_zip");
    const noise = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9]);
    expect(code(() => readExport("chatgpt", noise))).toBe("corrupt_zip");
  });

  it("Z2: stops a zip bomb from its declared size, before it inflates", () => {
    const bomb = zip({ "conversations.json": new Uint8Array(5_000_000) });
    expect(bomb.length).toBeLessThan(10_000);
    expect(code(() => readExport("chatgpt", bomb, { maxBytes: 1_000_000 }))).toBe("too_large");
  });

  it("Z2: a header that lies about the size cannot make the file grow", () => {
    const bytes = zip({ "conversations.json": `[${'{"x":1},'.repeat(10_000)}{"x":1}]` });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const central = bytes.findLastIndex((_, i) => i + 4 <= bytes.length && view.getUint32(i, true) === 0x02014b50);
    view.setUint32(central + 24, 10, true);
    expect(code(() => readExport("chatgpt", bytes))).toMatch(/bad_export|corrupt_zip/);
  });

  it("Z3: a zip with no export file names what it looked for", () => {
    const other = zip({ "photo.jpg": new Uint8Array([1, 2, 3]) });
    expect(() => readExport("chatgpt", other)).toThrow(/no conversations\.json/);
    expect(() => readExport("claude", other)).toThrow(/no conversations\.json/);
    expect(() => readExport("gemini", other)).toThrow(/no MyActivity\.json/);
  });

  it("Z4: finds Takeout's file at any depth and prefers the Gemini Apps folder", () => {
    const takeout = zip({
      "Takeout/My Activity/Search/MyActivity.json": JSON.stringify([{ header: "Search", title: "Prompted not gemini", time: "2026-01-01T00:00:00Z" }]),
      "Takeout/My Activity/Gemini Apps/MyActivity.json": fixture("gemini-MyActivity.json"),
    });
    const parsed = readExport("gemini", takeout);
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.skipped).toBe(3);
  });

  it("Z4: an HTML Takeout says to choose JSON", () => {
    expect(() => readExport("gemini", zip({ "Takeout/My Activity/Gemini Apps/MyActivity.html": "<html></html>" }))).toThrow(/choose JSON/);
  });

  it("Z5: reads only the export files, and merges ChatGPT shards", () => {
    const shards = JSON.parse(fixture("chatgpt-conversations.json")) as unknown[];
    const parsed = readExport("chatgpt", zip({
      "conversations-000.json": JSON.stringify(shards.slice(0, 1)),
      "conversations-001.json": JSON.stringify(shards.slice(1)),
      "shared_conversations.json": "not json at all",
      "dalle-generations/file-1.webp": new Uint8Array(1000),
    }));
    expect(parsed.conversations.map((c) => c.id)).toEqual(["chatgpt:6795a1b2-0001", "chatgpt:6795a1b2-0002", "chatgpt:custom-instructions"]);
    expect(parsed.savedMemories).toHaveLength(1);
  });

  it("Z5: a Claude zip gives the chats and memories.json", () => {
    const parsed = readExport("claude", zip({ "conversations.json": fixture("claude-conversations.json"), "memories.json": fixture("claude-memories.json"), "users.json": "[]" }));
    expect(parsed.conversations).toHaveLength(3);
    expect(parsed.savedMemories.map((m) => m.text)).toContain("Has a daughter named Ava.");
  });

  it("Z6: looks at the bytes, not the name: JSON bytes and text both work", () => {
    const text = fixture("claude-conversations.json");
    expect(readExport("claude", new TextEncoder().encode(text)).conversations).toHaveLength(3);
    expect(readExport("claude", text).conversations).toHaveLength(3);
    expect(readExport("memories", new TextEncoder().encode("- Likes tea.").buffer).savedMemories[0]?.text).toBe("Likes tea.");
    expect(code(() => readExport("memories", zip({ "a.txt": "x" })))).toBe("bad_export");
  });

  it("Z6: the wrong source for a file is bad_export", () => {
    expect(code(() => readExport("chatgpt", zip({ "conversations.json": fixture("claude-conversations.json") })))).toBe("bad_export");
    expect(code(() => readExport("claude", JSON.stringify({ data_files: [{ filename: "batch-0.zip" }] })))).toBe("bad_export");
  });

  it("Z7: a JSON file larger than maxBytes is refused before it parses", () => {
    expect(code(() => readExport("claude", "[" + " ".repeat(2000) + "]", { maxBytes: 1000 }))).toBe("too_large");
    expect(code(() => readExport("claude", new Uint8Array(2000), { maxBytes: 1000 }))).toBe("too_large");
  });
});
