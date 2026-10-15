// The foxpack/v1 format. docs/format.md describes it.

/** Where a conversation or a memory came from. "memories" is a pasted list. */
export type Source = "chatgpt" | "claude" | "gemini" | "memories";
export const SOURCES: readonly Source[] = ["chatgpt", "claude", "gemini", "memories"];

export type Role = "user" | "assistant";

export interface Message {
  id: string;
  role: Role;
  text: string;
  /** ISO 8601 in UTC, or null when the export has no usable time. */
  createdAt: string | null;
}

export interface Conversation {
  /** `<source>:<id in the export>`, so a second import replaces it. */
  id: string;
  source: Source;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messages: Message[];
}

/** A memory the user or the assistant saved, as text. */
export interface SavedMemory {
  text: string;
  /** The conversation it was saved in, or null for a list or a memory file. */
  conversationId: string | null;
  date: string | null;
}

/** What a parser returns: one export file, normalized. */
export interface ParsedExport {
  source: Source;
  conversations: Conversation[];
  /** Saved memories: a pasted list, a memory file, or memory writes inside chats. */
  savedMemories: SavedMemory[];
  /** Conversations or entries the parser could not read. */
  skipped: number;
}

export type MemoryKind = "preference" | "fact" | "person" | "project";
export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact", "person", "project"];

/** A memory that extractMemories found. Nothing is stored until a person accepts it. */
export interface Candidate {
  /** A hash of the kind and the normalized text: the same input gives the same id. */
  id: string;
  text: string;
  kind: MemoryKind;
  /** 0 to 1: how sure the pattern is that this is a lasting fact about the user. */
  confidence: number;
  source: Source;
  /** The conversation of the first sentence that gave it, or null for a pasted memory. */
  conversationId: string | null;
  date: string | null;
  /** How many conversations (or list lines) said it. */
  seenIn: number;
}

/** A memory text is 1 to this many characters, after trimming: in edit (K3) and in restore (E9). */
export const MAX_MEMORY_TEXT = 500;

export type MemoryStatus = "pending" | "accepted" | "rejected" | "forgotten";

export interface MemoryRecord extends Candidate {
  status: MemoryStatus;
  /** The text that extractMemories found, before any edit. */
  originalText: string;
  decidedAt: string | null;
  /** The id in foxmemory, when the pack has a foxmemory sink. */
  foxmemoryId?: string;
}

export interface ImportRecord {
  source: Source;
  at: string;
  conversations: number;
  candidates: number;
  skipped: number;
}

/** The stored pack: what pack.json and storage.local hold. */
export interface PackData {
  format: "foxpack/v1";
  conversations: Conversation[];
  memories: MemoryRecord[];
  imports: ImportRecord[];
}
