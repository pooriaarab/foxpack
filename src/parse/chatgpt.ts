// ChatGPT data export: conversations.json, an array of conversations. Each
// one holds its messages as a tree in `mapping` (edits and regenerations
// make branches). The branch the user last saw ends at `current_node`, so
// the parser walks from there up to the root (P3).
import { FoxpackError } from "../errors.js";
import type { Conversation, Message, ParsedExport } from "../types.js";
import { clip, isObject, readJson, str, toIso, type Json } from "./common.js";

// Content types that hold what a person or the model said. Code, tool
// output, browsing, custom instructions and reasoning are left out (P5).
const TEXT_TYPES = new Set(["text", "multimodal_text"]);

function toMessage(node: Json): Message | null {
  const m = node.message;
  if (!isObject(m) || !isObject(m.author) || !isObject(m.content)) return null;
  const role = m.author.role;
  if (role !== "user" && role !== "assistant") return null;
  if (isObject(m.metadata) && m.metadata.is_visually_hidden_from_conversation === true) return null;
  // An assistant message to a tool (recipient "python", "browser", ...) is a tool call.
  if (m.recipient !== undefined && m.recipient !== "all") return null;
  if (!TEXT_TYPES.has(str(m.content.content_type))) return null;
  const parts = Array.isArray(m.content.parts) ? m.content.parts : [];
  // Image and file parts are objects; only text parts are kept.
  const text = clip(parts.filter((p): p is string => typeof p === "string").join("\n"));
  if (!text) return null;
  return { id: str(m.id) || str(node.id), role, text, createdAt: toIso(m.create_time) };
}

/** The leaf at the end of the newest child at each step from the root. */
function lastLeaf(mapping: Json): string {
  let cursor = Object.keys(mapping).find((k) => isObject(mapping[k]) && !mapping[k].parent) ?? "";
  const seen = new Set<string>();
  for (;;) {
    const node = mapping[cursor];
    const children = isObject(node) && Array.isArray(node.children) ? node.children : [];
    const next = str(children.at(-1));
    if (!next || seen.has(next) || !isObject(mapping[next])) return cursor;
    seen.add(cursor);
    cursor = next;
  }
}

function toConversation(value: unknown): Conversation | null {
  if (!isObject(value) || !isObject(value.mapping)) return null;
  const id = str(value.conversation_id) || str(value.id);
  const mapping = value.mapping;
  // current_node can be missing: then follow the last child from the root.
  let cursor = str(value.current_node) || lastLeaf(mapping);
  if (!id || !isObject(mapping[cursor])) return null;
  const seen = new Set<string>();
  const branch: Message[] = [];
  // Walk up to the root. A node seen before means a cycle: stop (P4).
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    if (!isObject(node)) return null; // a parent that is not in the mapping (P2)
    const message = toMessage(node);
    if (message) branch.push(message);
    cursor = str(node.parent);
  }
  return {
    id: `chatgpt:${id}`,
    source: "chatgpt",
    title: str(value.title).trim() || "Untitled",
    createdAt: toIso(value.create_time),
    updatedAt: toIso(value.update_time),
    messages: branch.toReversed(),
  };
}

/** Parses ChatGPT conversations.json (text or parsed JSON). Throws `bad_export` for the wrong shape. */
export function parseChatGPT(contents: unknown): ParsedExport {
  const data = readJson(contents, "chatgpt");
  if (!Array.isArray(data)) throw new FoxpackError("bad_export", "The ChatGPT file must be conversations.json: an array of conversations with a mapping.");
  if (data.length > 0 && !data.some((c) => isObject(c) && "mapping" in c)) {
    throw new FoxpackError("bad_export", "This is not a ChatGPT export: no conversation has a mapping.");
  }
  const conversations: Conversation[] = [];
  let skipped = 0;
  for (const item of data) {
    const conversation = toConversation(item);
    if (conversation) conversations.push(conversation);
    else skipped++;
  }
  return { source: "chatgpt", conversations, savedMemories: [], skipped };
}
