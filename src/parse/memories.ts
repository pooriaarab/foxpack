// A pasted "saved memories" list from any assistant: ChatGPT "Manage
// memories", Gemini "Saved info", Claude memory, or a list a person wrote.
// One memory per line, with or without a bullet (P12).
import type { ParsedExport, SavedMemory } from "../types.js";

/** A line longer than this is not one memory (P13). */
export const MAX_MEMORY_CHARS = 500;

const BULLET = /^(?:[-*•‣◦·–—]|\d{1,3}[.)]|\[[ xX]?\])\s*/;

/** Parses a pasted list of memories. It never throws: a line it cannot use is skipped. */
export function parseSavedMemories(contents: string): ParsedExport {
  const savedMemories: SavedMemory[] = [];
  let skipped = 0;
  for (const raw of contents.replace(/^﻿/, "").split(/\r\n?|\n/)) {
    const line = raw.trim().replace(BULLET, "").trim();
    if (!line) continue;
    // "Saved memories:", "Preferences:" and "## Work" are headings, not memories.
    if (line.endsWith(":") || line.startsWith("#") || line.length > MAX_MEMORY_CHARS) {
      skipped++;
      continue;
    }
    if (!savedMemories.some((m) => m.text === line)) savedMemories.push({ text: line, conversationId: null, date: null });
  }
  return { source: "memories", conversations: [], savedMemories, skipped };
}
