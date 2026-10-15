import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPack, FoxpackError, htmlToText, inMemoryStore, parseChatGPT, parseClaude, parseClaudeMemories, parseGemini, parseSavedMemories } from "../src/index.js";

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
    expect(parsed.conversations.map((c) => c.id)).toEqual(["chatgpt:6795a1b2-0001", "chatgpt:6795a1b2-0002", "chatgpt:custom-instructions"]);
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

describe("memories inside exports", () => {
  it("P16: reads ChatGPT memory writes (bio) from every branch, with their chat and date", () => {
    expect(parseChatGPT(fixture("chatgpt-conversations.json")).savedMemories).toEqual([
      { text: "User prefers aisle seats.", conversationId: "chatgpt:6795a1b2-0001", date: "2026-01-01T00:00:05.500Z" },
    ]);
  });

  it("P17: turns custom instructions into one user message, once", () => {
    const about = parseChatGPT(fixture("chatgpt-conversations.json")).conversations.at(-1);
    expect(about?.messages.map((m) => [m.role, m.text])).toEqual([["user", "I'm a product designer in Vancouver."]]);
  });

  it("P18: reads Claude memories.json: headings skipped, prose split into sentences", () => {
    const parsed = parseClaudeMemories(fixture("claude-memories.json"));
    expect(parsed.savedMemories.map((m) => m.text)).toEqual(["Sam is a product designer who prefers short answers. Sam is building a garden planner app.", "Has a daughter named Ava.", "Prefers TypeScript over Python."]);
    expect(parsed.skipped).toBe(2);
    expect(code(() => parseClaudeMemories({}))).toBe("bad_export");
  });

  it("P18: splits a paragraph longer than 200 characters into sentences", () => {
    const long = `${"Likes long walks on the beach at dawn. ".repeat(6)}Owns a red bike.`;
    expect(parseSavedMemories(long).savedMemories.map((m) => m.text)).toEqual(["Likes long walks on the beach at dawn.", "Owns a red bike."]);
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

describe("parseGemini", () => {
  const parsed = parseGemini(fixture("gemini-MyActivity.json"));
  const [color, nurse] = parsed.conversations;

  it("P1: refuses the wrong shape and the HTML version of My Activity", () => {
    expect(code(() => parseGemini("<html><body>My Activity</body></html>"))).toBe("bad_export");
    expect(code(() => parseGemini({ title: "x" }))).toBe("bad_export");
    expect(code(() => parseGemini(fixture("claude-conversations.json")))).toBe("bad_export");
  });

  it("P9: keeps Gemini Apps and Bard prompts, and skips other products and actions", () => {
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.skipped).toBe(3);
    expect(JSON.stringify(parsed)).not.toMatch(/flights|Canvas|Used Gemini/);
  });

  it("P10: turns the HTML answer into plain text", () => {
    expect(nurse?.messages[1]?.text).toBe("Try light meals & protein.\n- Greek yogurt\n- Nuts \u2014 a handful");
    expect(htmlToText("a<br/>b &lt;i&gt; &#x41; &bogus; &#0;")).toBe("a\nb <i> A &bogus; &#0;");
  });

  it("P11: groups entries by their chat link, else one entry is one conversation", () => {
    expect(nurse?.id).toBe("gemini:1a2b3c4d5e");
    expect(nurse?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(nurse?.messages[2]?.text).toBe("And something with no sugar?");
    expect(color?.id).toMatch(/^gemini:2025-12-24T10:00:00.000Z-\d+$/);
    expect(color?.title).toBe("My favorite color is green.");
    expect(color?.createdAt).toBe("2025-12-24T10:00:00.000Z");
  });
});

describe("parseSavedMemories", () => {
  it("P12: one memory per line, with bullets, headings, blanks and repeats removed", () => {
    const parsed = parseSavedMemories(fixture("saved-memories.txt"));
    expect(parsed.savedMemories.map((m) => m.text)).toEqual([
      "Prefers concise answers with code first.",
      "Is vegetarian.",
      "Has a dog named Miso.",
      "Is building a budgeting app called Penny.",
      "Lives in Vancouver.",
      "Works as a nurse on night shifts.",
    ]);
    expect(parsed.skipped).toBe(2);
    expect(parsed.savedMemories[0]).toEqual({ text: "Prefers concise answers with code first.", conversationId: null, date: null });
  });

  it("P12: removes a BOM and Windows line ends", () => {
    expect(parseSavedMemories("\uFEFFLikes hiking.\r\nIs tall.\r\n").savedMemories.map((m) => m.text)).toEqual(["Likes hiking.", "Is tall."]);
  });

  it("P19: 60000 lines parse and import in linear time", async () => {
    const text = Array.from({ length: 60_000 }, (_, i) => `- I like item number ${i} a lot.`).join("\n");
    let started = performance.now();
    expect(parseSavedMemories(`${text}\n- I like item number 7 a lot.`).savedMemories).toHaveLength(60_000);
    expect(performance.now() - started).toBeLessThan(1000);
    started = performance.now();
    expect((await createPack({ store: inMemoryStore() }).import("memories", text)).added).toBe(60_000);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("P13: skips a line longer than 500 characters", () => {
    expect(parseSavedMemories(`${"x".repeat(501)}\nShort one.`).savedMemories.map((m) => m.text)).toEqual(["Short one."]);
  });
});
