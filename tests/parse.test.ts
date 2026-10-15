import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FoxpackError, parseChatGPT, parseClaude } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxpackError ? error.code : String(error);
  }
  return "no error";
};

const createdAt = (create_time: unknown) =>
  parseChatGPT([{ conversation_id: "x", current_node: "a", create_time, mapping: { a: { id: "a", parent: null, message: null } } }]).conversations[0]?.createdAt;

describe("parseChatGPT", () => {
  const parsed = parseChatGPT(fixture("chatgpt-conversations.json"));
  const [lisbon, sam] = parsed.conversations;

  it("P1: refuses text that is not JSON and JSON of the wrong shape", () => {
    expect(code(() => parseChatGPT("{nope"))).toBe("bad_export");
    expect(code(() => parseChatGPT({ mapping: {} }))).toBe("bad_export");
    expect(code(() => parseChatGPT(fixture("claude-conversations.json")))).toBe("bad_export");
  });

  it("P2: skips a broken conversation and keeps the others", () => {
    expect(parsed.conversations.map((c) => c.id)).toEqual(["chatgpt:6795a1b2-0001", "chatgpt:6795a1b2-0002"]);
    expect(parsed.skipped).toBe(2);
  });

  it("P3: keeps only the branch that ends at current_node, root first", () => {
    expect(lisbon?.messages.map((m) => m.id)).toEqual(["n1", "n4", "n5"]);
    expect(JSON.stringify(lisbon)).not.toContain("OLD BRANCH");
  });

  it("P3: with no current_node, follows the last child from the root", () => {
    const mapping = {
      r: { id: "r", parent: null, children: ["a", "b"], message: null },
      a: { id: "a", parent: "r", children: [], message: { id: "a", author: { role: "user" }, content: { content_type: "text", parts: ["old"] } } },
      b: { id: "b", parent: "r", children: [], message: { id: "b", author: { role: "user" }, content: { content_type: "text", parts: ["new"] } } },
    };
    expect(parseChatGPT([{ conversation_id: "x", mapping }]).conversations[0]?.messages.map((m) => m.text)).toEqual(["new"]);
  });

  it("P4: stops at a cycle", () => {
    expect(sam?.messages.map((m) => m.text)).toEqual(["Call me Sam.", "Sure, Sam."]);
  });

  it("P5: drops system, hidden, tool and image parts", () => {
    expect(lisbon?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(lisbon?.messages[2]?.text).toBe("I'm allergic to shellfish, so skip seafood places.");
    expect(JSON.stringify(parsed)).not.toMatch(/web results|search\(|file-service/);
  });

  it("P6: turns epoch seconds into ISO and a bad time into null", () => {
    expect(lisbon?.createdAt).toBe("2026-01-01T00:00:00.123Z");
    expect(lisbon?.messages[0]?.createdAt).toBe("2026-01-01T00:00:01.000Z");
    expect(sam?.createdAt).toBeNull();
    expect(sam?.updatedAt).toBeNull();
    expect(sam?.title).toBe("Untitled");
  });

  it("P6: a time before 2001 or not finite becomes null", () => {
    expect([0, -5, Number.NaN, "1970-01-01T00:00:00Z", 1e15].map(createdAt)).toEqual([null, null, null, null, null]);
  });

  it("P13: cuts a huge message at 20000 characters", () => {
    const huge = "a".repeat(30_000);
    const [c] = parseChatGPT([{ conversation_id: "x", current_node: "a", mapping: { a: { id: "a", parent: null, message: { id: "a", author: { role: "user" }, content: { content_type: "text", parts: [huge] } } } } }]).conversations;
    expect(c?.messages[0]?.text.length).toBe(20_001);
  });
});

describe("parseClaude", () => {
  const parsed = parseClaude(fixture("claude-conversations.json"));
  const [garden, branched, empty] = parsed.conversations;

  it("P1: refuses the wrong shape", () => {
    expect(code(() => parseClaude("[1, 2"))).toBe("bad_export");
    expect(code(() => parseClaude({ chat_messages: [] }))).toBe("bad_export");
    expect(code(() => parseClaude(fixture("chatgpt-conversations.json")))).toBe("bad_export");
  });

  it("P2: skips a conversation with no uuid", () => {
    expect(parsed.conversations.map((c) => c.id)).toEqual(["claude:0b1c2d3e-0001", "claude:0b1c2d3e-0003", "claude:0b1c2d3e-0002"]);
    expect(parsed.skipped).toBe(1);
  });

  it("P7: reads text blocks first, then text, and drops tool blocks", () => {
    expect(garden?.messages.map((m) => m.text)).toEqual(["My daughter is called Ava and she loves tomatoes.", "Tomatoes are a good choice.", "I'm working on a raised bed project this spring."]);
  });

  it("P3: keeps the branch that ends at the newest leaf", () => {
    expect(branched?.messages.map((m) => m.text)).toEqual(["Pick a name for my cat.", "How about Miso?", "Miso it is."]);
  });

  it("P8: maps human to user and drops other senders", () => {
    expect(garden?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("P6: keeps ISO times in UTC and a bad one as null", () => {
    expect(garden?.createdAt).toBe("2026-02-01T10:00:00.000Z");
    expect(garden?.messages[2]?.createdAt).toBe("2026-02-01T10:01:00.000Z");
    expect(empty?.createdAt).toBeNull();
    expect(empty?.title).toBe("Untitled");
  });
});
