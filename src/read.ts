// readExport: one entry point for every export file, zip or not. It looks
// at the bytes, not the file name (Z6). A zip is read through its central
// directory, and only the needed files are inflated (Z5). Each one is
// inflated into a buffer of its declared size, so a header that lies
// cannot make it grow (Z2), and the declared sizes must fit in maxBytes.
import { unzipSync } from "fflate";
import { FoxpackError } from "./errors.js";
import { parseChatGPT } from "./parse/chatgpt.js";
import { parseClaude } from "./parse/claude.js";
import { isObject } from "./parse/common.js";
import { parseGemini } from "./parse/gemini.js";
import { parseClaudeMemories, parseSavedMemories } from "./parse/memories.js";
import type { Conversation, ParsedExport, Source } from "./types.js";

export interface ReadOptions {
  /** The most bytes to read or inflate. The default is 256 MiB. */
  maxBytes?: number;
}

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
// conversations.json, or conversations-000.json and on in a large export.
// Not shared_conversations.json, which holds only link stubs.
const CHATGPT_FILE = /^conversations(-\d+)?\.json$/;

function wanted(source: Source, path: string): boolean {
  const name = base(path);
  if (source === "chatgpt") return CHATGPT_FILE.test(name);
  if (source === "claude") return name === "conversations.json" || name === "memories.json";
  if (source === "gemini") return name === "MyActivity.json" || name === "MyActivity.html";
  return false;
}

function unzip(source: Source, bytes: Uint8Array, maxBytes: number): Map<string, string> {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted(source, file.name)) return false;
        total += file.originalSize;
        if (total > maxBytes) throw new FoxpackError("too_large", `The export holds more than ${maxBytes} bytes of ${source} data. Raise maxBytes to read it.`);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof FoxpackError) throw error;
    throw new FoxpackError("corrupt_zip", `The zip file is corrupt or cut short (${error instanceof Error ? error.message : String(error)}). Download the export again.`);
  }
  const decoder = new TextDecoder();
  return new Map(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)).map(([path, data]) => [path, decoder.decode(data)]));
}

const json = (text: string, path: string) => {
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as unknown;
  } catch {
    throw new FoxpackError("bad_export", `${base(path)} in the zip is not JSON.`);
  }
};

/** Later copies of a conversation win when they are newer. */
function dedupe(conversations: Conversation[]): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const c of conversations) {
    const old = byId.get(c.id);
    if (!old || (c.updatedAt ?? "") >= (old.updatedAt ?? "")) byId.set(c.id, c);
  }
  return [...byId.values()];
}

function fromZip(source: Source, files: Map<string, string>): ParsedExport {
  const paths = [...files.keys()];
  if (source === "chatgpt") {
    if (paths.length === 0) throw new FoxpackError("bad_export", "The zip has no conversations.json. Is it a ChatGPT data export?");
    const all = paths.flatMap((p) => {
      const data = json(files.get(p) ?? "", p);
      return Array.isArray(data) ? data : [];
    });
    const parsed = parseChatGPT(all);
    return { ...parsed, conversations: dedupe(parsed.conversations) };
  }
  if (source === "claude") {
    const chats = paths.find((p) => base(p) === "conversations.json");
    if (!chats) throw new FoxpackError("bad_export", "The zip has no conversations.json. Is it a Claude data export?");
    const parsed = parseClaude(json(files.get(chats) ?? "", chats));
    const memories = paths.find((p) => base(p) === "memories.json");
    if (!memories) return parsed;
    const notes = parseClaudeMemories(json(files.get(memories) ?? "", memories));
    return { ...parsed, savedMemories: notes.savedMemories, skipped: parsed.skipped + notes.skipped };
  }
  // Gemini: a Takeout zip can hold My Activity for many products. Prefer
  // the Gemini Apps (or older Bard) folder; parseGemini filters entries too.
  const activity = paths.filter((p) => base(p) === "MyActivity.json");
  const gemini = activity.filter((p) => /\/(Gemini Apps|Bard)\/MyActivity\.json$/.test(`/${p}`));
  const chosen = gemini.length > 0 ? gemini : activity;
  if (chosen.length === 0) {
    if (paths.some((p) => base(p) === "MyActivity.html")) return parseGemini("<html>");
    throw new FoxpackError("bad_export", "The zip has no MyActivity.json. In Google Takeout, choose My Activity > Gemini Apps in JSON.");
  }
  const parsed = chosen.map((p) => parseGemini(json(files.get(p) ?? "", p)));
  return { source: "gemini", conversations: dedupe(parsed.flatMap((p) => p.conversations)), savedMemories: [], skipped: parsed.reduce((n, p) => n + p.skipped, 0) };
}

function fromText(source: Source, text: string): ParsedExport {
  if (source === "memories") return parseSavedMemories(text);
  if (source === "chatgpt") return parseChatGPT(text);
  if (source === "gemini") return parseGemini(text);
  const data = json(text, "conversations.json");
  // A large Claude export comes as an index file plus batch zips.
  if (isObject(data) && Array.isArray(data.data_files)) {
    throw new FoxpackError("bad_export", "This is the index of a Claude export that came in parts. Import each batch zip instead.");
  }
  if (Array.isArray(data) && data.some((e) => isObject(e) && "conversations_memory" in e)) return parseClaudeMemories(data);
  return parseClaude(data);
}

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);

/** Reads one export file: a zip, a JSON file or a pasted list, as bytes or text. */
export function readExport(source: Source, input: Uint8Array | ArrayBuffer | string, options: ReadOptions = {}): ParsedExport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (typeof input === "string") {
    if (input.length > maxBytes) throw new FoxpackError("too_large", `The file is larger than ${maxBytes} bytes.`);
    return fromText(source, input);
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > maxBytes) throw new FoxpackError("too_large", `The file is larger than ${maxBytes} bytes.`);
  if (!isZip(bytes)) return fromText(source, new TextDecoder().decode(bytes));
  if (source === "memories") throw new FoxpackError("bad_export", "A memory list is a text file, not a zip.");
  return fromZip(source, unzip(source, bytes, maxBytes));
}
