import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, DATA_NOTE } from "../src/mcp.js";
import { createPack, inMemoryStore, type PackData } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

async function connect() {
  const store = inMemoryStore();
  const pack = createPack({ store });
  await pack.import("claude", fixture("claude-conversations.json"));
  await pack.import("memories", "- Has a dog named Miso.\n- Prefers green tea.");
  const [ava, , dog] = await pack.memories();
  await pack.accept(ava?.id ?? "");
  await pack.accept(dog?.id ?? "");
  // The server gets a reader only. A save would throw.
  const saved = structuredClone(store.saved) as PackData;
  const server = createMcpServer({ data: async () => structuredClone(saved) });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const parts = (r.content as { text: string }[]).map((c) => c.text);
    if (r.isError) return { parts, value: null, isError: true };
    return { parts, value: JSON.parse(parts.at(-1) ?? "null") as unknown, isError: false };
  };
  return { client, call };
}

describe("foxpack mcp", () => {
  it("M1 + M2: has three read-only tools", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["memory_list", "memory_search", "pack_stats"]);
  });

  it("M1: memory_list returns accepted memories only, never conversations", async () => {
    const { call } = await connect();
    const { value, parts } = await call("memory_list");
    expect((value as { text: string }[]).map((m) => m.text)).toEqual(["My daughter is called Ava and she loves tomatoes.", "Has a dog named Miso."]);
    expect(parts.join("\n")).not.toMatch(/raised bed|green tea|Tomatoes are a good choice|claude:0b1c/);
    expect(((await call("memory_list", { kind: "person" })).value as unknown[]).length).toBe(2);
    expect((await call("memory_list", { kind: "project" })).value).toEqual([]);
  });

  it("M1: memory_search matches accepted text only", async () => {
    const { call } = await connect();
    expect(((await call("memory_search", { query: "MISO" })).value as { text: string }[]).map((m) => m.text)).toEqual(["Has a dog named Miso."]);
    expect((await call("memory_search", { query: "tea" })).value).toEqual([]);
    expect((await call("memory_search", { query: "" })).isError).toBe(true);
  });

  it("M3: memory text goes back as data, after a note that says so", async () => {
    const { call } = await connect();
    const { parts } = await call("memory_list");
    expect(parts[0]).toBe(DATA_NOTE);
  });

  it("pack_stats returns counts and no text", async () => {
    const { call } = await connect();
    expect((await call("pack_stats")).value).toEqual({ conversations: 3, messages: 6, bySource: { chatgpt: 0, claude: 3, gemini: 0, memories: 0 }, memories: { pending: 2, accepted: 2, rejected: 0, forgotten: 0 } });
  });
});
