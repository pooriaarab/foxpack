// A pasted "saved memories" list from any assistant: ChatGPT "Manage
// memories", Gemini "Saved info", Claude memory, or a list a person wrote.
// One memory per line, with or without a bullet (P12).
import { FoxpackError } from "../errors.js";
import type { ParsedExport, SavedMemory } from "../types.js";
import { isObject, readJson, str } from "./common.js";

/** A sentence longer than this is not one memory (P13). */
export const MAX_MEMORY_CHARS = 500;

const BULLET = /^(?:[-*•‣◦·–—]|\d{1,3}[.)]|\[[ xX]?\])\s*/;
// "## Work", "Preferences:" and a line of only bold text are headings.
const HEADING = /^(?:#|\*\*[^*]+\*\*:?$)|:$/;

/** The memories in a list or a memory file, with the count of lines skipped. */
function readLines(contents: string): { memories: string[]; skipped: number } {
  const memories = new Set<string>(); // a Set keeps the dedupe linear (P19)
  let skipped = 0;
  for (const raw of contents.replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const line = raw.trim().replace(BULLET, "").trim();
    if (!line) continue;
    if (HEADING.test(raw.trim()) || HEADING.test(line)) {
      skipped++;
      continue;
    }
    // A paragraph (a memory file in prose) is split into sentences.
    for (const piece of line.length > 200 ? line.split(/(?<=[.!?])\s+/) : [line]) {
      if (piece.length > MAX_MEMORY_CHARS) skipped++;
      else memories.add(piece);
    }
  }
  return { memories: [...memories], skipped };
}

const asSaved = (memories: string[]): SavedMemory[] => memories.map((text) => ({ text, conversationId: null, date: null }));

/** Parses a pasted list of memories. It never throws: a line it cannot use is skipped. */
export function parseSavedMemories(contents: string): ParsedExport {
  const { memories, skipped } = readLines(contents);
  return { source: "memories", conversations: [], savedMemories: asSaved(memories), skipped };
}

/**
 * Parses memories.json from a Claude export:
 * `[{ conversations_memory, project_memories: { <id>: text }, account_uuid }]`.
 * Each memory is Markdown text.
 */
export function parseClaudeMemories(contents: unknown): ParsedExport {
  const data = readJson(contents, "claude");
  if (!Array.isArray(data)) throw new FoxpackError("bad_export", "Claude memories.json must be an array of memory entries.");
  const texts: string[] = [];
  for (const entry of data) {
    if (!isObject(entry)) continue;
    texts.push(str(entry.conversations_memory));
    if (isObject(entry.project_memories)) texts.push(...Object.values(entry.project_memories).map(str));
  }
  const { memories, skipped } = readLines(texts.join("\n"));
  return { source: "claude", conversations: [], savedMemories: asSaved(memories), skipped };
}
