import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMemories, parseChatGPT, parseClaude, parseGemini, parseSavedMemories, type Conversation } from "../src/index.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
let n = 0;
const chat = (turns: [("user" | "assistant"), string][], id = `c${++n}`): Conversation => ({
  id: `claude:${id}`, source: "claude", title: "t", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: null,
  messages: turns.map(([role, text], i) => ({ id: `${id}-${i}`, role, text, createdAt: i === 0 ? "2026-01-02T00:00:01.000Z" : null })),
});
const texts = (conversations: Conversation[]) => extractMemories({ conversations }).map((c) => c.text);

describe("extractMemories", () => {
  it("finds the patterns in the fixture exports, with a kind for each", () => {
    const all = [parseChatGPT(fixture("chatgpt-conversations.json")), parseClaude(fixture("claude-conversations.json")), parseGemini(fixture("gemini-MyActivity.json"))];
    const found = all.flatMap((p) => extractMemories(p)).map((c) => [c.kind, c.text]);
    expect(found).toEqual([
      ["preference", "User prefers aisle seats."],
      ["preference", "I prefer aisle seats."],
      ["fact", "I'm allergic to shellfish, so skip seafood places."],
      ["fact", "Call me Sam."],
      ["fact", "I'm a product designer in Vancouver."],
      ["person", "My daughter is called Ava and she loves tomatoes."],
      ["project", "I'm working on a raised bed project this spring."],
      ["preference", "My favorite color is green."],
      ["fact", "I'm a nurse on night shifts."],
    ]);
  });

  it("X1: reads user turns only", () => {
    expect(texts([chat([["assistant", "I am an AI model. I prefer clear questions."], ["user", "I prefer tea."]])])).toEqual(["I prefer tea."]);
  });

  it("X2: skips questions, conditions and role play", () => {
    expect(texts([chat([["user", "Am I allergic to nuts? If I am late, wait. Pretend I am a pirate. Imagine I live in Paris. When I am tired I sleep. Let's say my name is Bob."]])])).toEqual([]);
  });

  it("X3: never offers a secret or a long number", () => {
    expect(texts([chat([["user", "My password is hunter2. My SSN is 123-45-6789. My API key is sk-abc. My card number is 4111 1111 1111 1111. My phone is 6045551234. My PIN is 1234."]])])).toEqual([]);
    expect(extractMemories({ conversations: [], savedMemories: [{ text: "Bank account number 12345678", conversationId: null, date: null }] })).toEqual([]);
  });

  it("X4: skips code and pasted documents", () => {
    expect(texts([chat([["user", "Fix this:\n```\n// I prefer tabs\nconst my_name_is = 1;\n```\nThanks."], ["user", `I prefer short answers. ${"Lorem ipsum dolor sit amet. ".repeat(200)}`]])])).toEqual([]);
  });

  it("X5: the same input gives the same ids in the same order", () => {
    const pack = parseClaude(fixture("claude-conversations.json"));
    const a = extractMemories(pack);
    expect(extractMemories(structuredClone(pack))).toEqual(a);
    expect(a.map((c) => c.id).every((id) => /^m[0-9a-z]+$/.test(id))).toBe(true);
    expect(extractMemories({ conversations: [chat([["user", "i prefer   TEA"]])] })[0]?.id).toBe(extractMemories({ conversations: [chat([["user", "I prefer tea."]])] })[0]?.id);
  });

  it("X6: one candidate for a fact said in many chats, surer each time, at most 0.95", () => {
    const five = Array.from({ length: 5 }, () => chat([["user", "I prefer window seats."]]));
    const [c] = extractMemories({ conversations: five });
    expect(extractMemories({ conversations: five })).toHaveLength(1);
    expect(c?.seenIn).toBe(5);
    expect(c?.confidence).toBe(0.95);
    expect(c?.conversationId).toBe(five[0]?.id);
    const twice = extractMemories({ conversations: [chat([["user", "I prefer window seats. I prefer window seats."]])] });
    expect(twice[0]?.seenIn).toBe(1);
  });

  it("X7: each candidate traces to its chat, source and date; a pasted memory has no chat", () => {
    const [c] = extractMemories({ conversations: [chat([["user", "Call me Sam."]], "x")] });
    expect(c).toMatchObject({ source: "claude", conversationId: "claude:x", date: "2026-01-02T00:00:01.000Z", kind: "fact", confidence: 0.9 });
    const [d] = extractMemories({ conversations: [chat([["user", "hi"], ["user", "I like jazz."]], "y")] });
    expect(d?.date).toBe("2026-01-02T00:00:00.000Z");
    const listed = extractMemories(parseSavedMemories(fixture("saved-memories.txt")));
    expect(listed.map((m) => [m.kind, m.text, m.source, m.conversationId, m.confidence])).toEqual([
      ["preference", "Prefers concise answers with code first.", "memories", null, 0.9],
      ["fact", "Is vegetarian.", "memories", null, 0.9],
      ["person", "Has a dog named Miso.", "memories", null, 0.9],
      ["project", "Is building a budgeting app called Penny.", "memories", null, 0.9],
      ["fact", "Lives in Vancouver.", "memories", null, 0.9],
      ["fact", "Works as a nurse on night shifts.", "memories", null, 0.9],
    ]);
  });

  it("X8: a candidate is 8 to 200 characters", () => {
    expect(texts([chat([["user", `I am a ${"very ".repeat(50)}tall person.`], ["user", "I am a x"]])])).toEqual(["I am a x."]);
    expect(texts([chat([["user", "I'm a x"]])])).toEqual([]);
  });

  it("skips filler words and keeps the rest", () => {
    expect(texts([chat([["user", "Also, btw I'd rather fly at night. Oh and my sister lives in Oslo. I love that idea. My code is broken."]])])).toEqual(["I'd rather fly at night.", "My sister lives in Oslo."]);
  });
});
