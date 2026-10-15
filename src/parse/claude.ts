// Claude data export: conversations.json, an array of conversations, each
// with a flat list of `chat_messages` from sender "human" or "assistant".
import { FoxpackError } from "../errors.js";
import type { Conversation, Message, ParsedExport } from "../types.js";
import { clip, isObject, readJson, str, toIso, type Json } from "./common.js";

const ROLES = { human: "user", assistant: "assistant" } as const;

function toMessage(value: unknown): Message | null {
  if (!isObject(value)) return null;
  const role = ROLES[str(value.sender) as keyof typeof ROLES];
  if (!role) return null; // P8
  // Newer exports put the text in content blocks; older ones in text (P7).
  const blocks = Array.isArray(value.content) ? value.content.filter((b) => isObject(b) && b.type === "text") : [];
  const raw = blocks.length > 0 ? blocks.map((b) => str((b as { text?: unknown }).text)).join("\n") : str(value.text);
  const text = clip(raw);
  if (!text) return null;
  return { id: str(value.uuid), role, text, createdAt: toIso(value.created_at) };
}

const time = (m: Json) => Date.parse(str(m.created_at)) || 0;

/**
 * Edits and retries make branches: each message names its parent. The
 * export has no pointer to the branch the user saw, so foxpack keeps the
 * branch that ends at the newest leaf (P3). With no parent fields, the
 * list order is the conversation.
 */
function currentBranch(list: Json[]): Json[] {
  if (!list.some((m) => str(m.parent_message_uuid))) return list;
  const byId = new Map(list.map((m) => [str(m.uuid), m]));
  const parents = new Set(list.map((m) => str(m.parent_message_uuid)));
  const leaves = list.filter((m) => !parents.has(str(m.uuid)));
  let cursor = leaves.reduce<Json | undefined>((best, m) => (!best || time(m) >= time(best) ? m : best), undefined);
  const seen = new Set<Json>();
  const branch: Json[] = [];
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    branch.push(cursor);
    cursor = byId.get(str(cursor.parent_message_uuid));
  }
  return branch.toReversed();
}

function toConversation(value: unknown): Conversation | null {
  if (!isObject(value) || !Array.isArray(value.chat_messages)) return null;
  const id = str(value.uuid);
  if (!id) return null;
  const messages = currentBranch(value.chat_messages.filter(isObject)).map(toMessage).filter((m): m is Message => m !== null);
  return {
    id: `claude:${id}`,
    source: "claude",
    title: str(value.name).trim() || "Untitled",
    createdAt: toIso(value.created_at),
    updatedAt: toIso(value.updated_at),
    messages,
  };
}

/** Parses Claude conversations.json (text or parsed JSON). Throws `bad_export` for the wrong shape. */
export function parseClaude(contents: unknown): ParsedExport {
  const data = readJson(contents, "claude");
  if (!Array.isArray(data)) throw new FoxpackError("bad_export", "The Claude file must be conversations.json: an array of conversations with chat_messages.");
  if (data.length > 0 && !data.some((c) => isObject(c) && "chat_messages" in c)) {
    throw new FoxpackError("bad_export", "This is not a Claude export: no conversation has chat_messages.");
  }
  const conversations: Conversation[] = [];
  let skipped = 0;
  for (const item of data) {
    const conversation = toConversation(item);
    if (conversation) conversations.push(conversation);
    else skipped++;
  }
  return { source: "claude", conversations, savedMemories: [], skipped };
}
