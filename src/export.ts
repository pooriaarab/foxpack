// Exports: foxpack/v1 JSON (the whole pack, read back with restore),
// the Data Transfer Initiative "AI Conversation History" schema, and
// Markdown. Every format holds accepted memories only (E1).
import { FoxpackError } from "./errors.js";
import type { Conversation, MemoryRecord, PackData, Source } from "./types.js";

export const EXPORT_FORMATS = ["foxpack", "dti", "markdown"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  format: ExportFormat;
  /** Put the conversations in too. The default is true. */
  conversations?: boolean;
  now?: Date;
}

/** The DTI schema names the service that made the history. */
export const SERVICE: Record<Source, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", memories: "foxpack" };

// The DTI AI Conversation History schema, as published at
// https://github.com/dtinit/schema-refs/blob/main/dti/ai-conversation.json
export interface DtiConversation {
  details: { createdBy: string; createdAt: string; startTime: string; endTime: string; modality: "text" };
  identifiers: { name: string; identifier: string }[];
  messages?: { text: string; sentAt: string; sender: string; channel: "Web" }[];
}

/**
 * One conversation in the DTI schema. The schema has no ids, titles or
 * memories, and every message needs a time: a message with no time takes
 * the start of its conversation, and a conversation with no time at all
 * cannot be written, so it returns null.
 */
export function toDti(c: Conversation, exportedAt: string): DtiConversation | null {
  const start = c.createdAt ?? c.messages.find((m) => m.createdAt)?.createdAt ?? null;
  if (!start) return null;
  const end = c.updatedAt ?? c.messages.findLast((m) => m.createdAt)?.createdAt ?? start;
  const out: DtiConversation = {
    details: { createdBy: SERVICE[c.source], createdAt: exportedAt, startTime: start, endTime: end, modality: "text" },
    identifiers: [{ name: "User", identifier: "user" }],
  };
  if (c.messages.length > 0) out.messages = c.messages.map((m) => ({ text: m.text, sentAt: m.createdAt ?? start, sender: m.role === "user" ? "user" : "AI", channel: "Web" }));
  return out;
}

/** Markdown text that cannot start a heading, a list or a table, or break a line (E2). */
export const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]#|<>~]/g, (ch) => `\\${ch}`).replace(/^(\s*)([-+]|\d+\.)(\s)/gm, "$1\\$2$3");

function markdown(data: PackData, memories: MemoryRecord[], withChats: boolean, exportedAt: string): string {
  const lines = ["# foxpack export", "", `Exported ${exportedAt}.`, "", "## Memories", ""];
  if (memories.length === 0) lines.push("No accepted memories.");
  for (const m of memories) lines.push(`- **${m.kind}:** ${escapeMarkdown(m.text.replace(/\s+/g, " "))}${m.date ? ` (${m.date.slice(0, 10)}, ${SERVICE[m.source]})` : ` (${SERVICE[m.source]})`}`);
  if (withChats) {
    lines.push("", "## Conversations");
    for (const c of data.conversations) {
      lines.push("", `### ${escapeMarkdown(c.title.replace(/\s+/g, " "))}`, "", `${SERVICE[c.source]}${c.createdAt ? `, ${c.createdAt.slice(0, 10)}` : ""}`);
      for (const msg of c.messages) lines.push("", `**${msg.role === "user" ? "You" : SERVICE[c.source]}:**`, "", ...escapeMarkdown(msg.text).split("\n").map((l) => `> ${l}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** An exported memory: no originalText, which can hold text the user edited out, and no foxmemoryId (E6). */
export type ExportedMemory = Omit<MemoryRecord, "originalText" | "foxmemoryId">;

const exportMemory = (m: MemoryRecord): ExportedMemory => ({ id: m.id, text: m.text, kind: m.kind, confidence: m.confidence, source: m.source, conversationId: m.conversationId, date: m.date, seenIn: m.seenIn, status: m.status, decidedAt: m.decidedAt });

const exportConversation = (c: Conversation): Conversation => ({
  id: c.id, source: c.source, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
  messages: c.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt })),
});

/** Writes a pack in one of the export formats. */
export function exportPack(data: PackData, options: ExportOptions): string {
  if (!EXPORT_FORMATS.includes(options.format)) throw new FoxpackError("bad_input", `The format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  const exportedAt = (options.now ?? new Date()).toISOString();
  const withChats = options.conversations ?? true;
  const memories = data.memories.filter((m) => m.status === "accepted");
  if (options.format === "markdown") return markdown(data, memories, withChats, exportedAt);
  if (options.format === "dti") {
    const out = withChats ? data.conversations.map((c) => toDti(c, exportedAt)).filter((c) => c !== null) : [];
    return `${JSON.stringify(out, null, 2)}\n`;
  }
  const file = { format: "foxpack/v1", exportedAt, conversations: withChats ? data.conversations.map(exportConversation) : [], memories: memories.map(exportMemory), imports: [] };
  return `${JSON.stringify(file, null, 2)}\n`;
}
