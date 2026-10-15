// Gemini chats from Google Takeout: My Activity > Gemini Apps, as
// MyActivity.json. Each entry is one prompt ("Prompted <text>") with the
// answer as HTML in safeHtmlItem. Google publishes no schema; docs/format.md
// lists what is confirmed and what is not.
import { FoxpackError } from "../errors.js";
import type { Conversation, Message, ParsedExport } from "../types.js";
import { clip, isObject, readJson, str, toIso, type Json } from "./common.js";

const HEADERS = new Set(["Gemini Apps", "Bard"]);
const PROMPTED = "Prompted ";
// A chat link, when the entry has one: gemini.google.com/app/<id> or /app/c/<id>.
const CHAT_URL = /gemini\.google\.com\/app\/(?:c\/)?([\w-]+)/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** HTML to plain text: scripts and tags removed, entities decoded (P10). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : lower.startsWith("#") ? Number(lower.slice(1)) : Number.NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function chatId(entry: Json): string | null {
  const urls = [str(entry.titleUrl), ...(Array.isArray(entry.details) ? entry.details.map((d) => (isObject(d) ? str(d.url) : "")) : [])];
  for (const url of urls) {
    const match = CHAT_URL.exec(url);
    if (match?.[1]) return match[1];
  }
  return null;
}

function isGemini(entry: Json): boolean {
  return HEADERS.has(str(entry.header)) || (Array.isArray(entry.products) && entry.products.includes("Gemini Apps"));
}

/** Parses Takeout MyActivity.json for Gemini Apps (text or parsed JSON). */
export function parseGemini(contents: unknown): ParsedExport {
  if (typeof contents === "string" && /^\s*</.test(contents)) {
    throw new FoxpackError("bad_export", "This is My Activity as HTML. In Google Takeout, choose JSON as the format for My Activity, then export again.");
  }
  const data = readJson(contents, "gemini");
  if (!Array.isArray(data)) throw new FoxpackError("bad_export", "The Gemini file must be MyActivity.json from Google Takeout: an array of activity entries.");
  if (data.length > 0 && !data.some((e) => isObject(e) && "time" in e && "title" in e)) {
    throw new FoxpackError("bad_export", "This is not a Google Takeout My Activity file: no entry has a title and a time.");
  }
  const groups = new Map<string, { entry: Json; time: string | null }[]>();
  let skipped = 0;
  data.forEach((entry, index) => {
    if (!isObject(entry) || !isGemini(entry) || !str(entry.title).startsWith(PROMPTED)) {
      skipped++;
      return;
    }
    const time = toIso(entry.time);
    // No chat link: the entry is a conversation of its own (P11).
    const key = chatId(entry) ?? `${time ?? "no-time"}-${index}`;
    groups.set(key, [...(groups.get(key) ?? []), { entry, time }]);
  });
  const conversations: Conversation[] = [];
  for (const [key, items] of groups) {
    items.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    const messages: Message[] = [];
    items.forEach(({ entry, time }, i) => {
      const prompt = clip(str(entry.title).slice(PROMPTED.length));
      if (prompt) messages.push({ id: `${key}:${i}:user`, role: "user", text: prompt, createdAt: time });
      const html = Array.isArray(entry.safeHtmlItem) ? entry.safeHtmlItem.map((h) => (isObject(h) ? str(h.html) : "")).join("\n") : "";
      const answer = clip(htmlToText(html));
      if (answer) messages.push({ id: `${key}:${i}:assistant`, role: "assistant", text: answer, createdAt: time });
    });
    const first = messages[0]?.text ?? "";
    conversations.push({
      id: `gemini:${key}`,
      source: "gemini",
      title: first.length > 80 ? `${first.slice(0, 79)}…` : first || "Untitled",
      createdAt: items[0]?.time ?? null,
      updatedAt: items.at(-1)?.time ?? null,
      messages,
    });
  }
  conversations.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return { source: "gemini", conversations, savedMemories: [], skipped };
}
