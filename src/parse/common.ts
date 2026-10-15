// Helpers that every parser uses. Export files are hostile input: every
// field is checked, and a bad field never throws past the parser.
import { FoxpackError } from "../errors.js";
import type { Source } from "../types.js";

/** A message longer than this is cut (P13). */
export const MAX_MESSAGE_CHARS = 20_000;

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses export text, or takes an already parsed value. */
export function readJson(contents: unknown, source: Source): unknown {
  if (typeof contents !== "string") return contents;
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    throw new FoxpackError("bad_export", `The ${source} file is not JSON.`);
  }
}

// From 2001 to 2100: a time outside it is a bad field, not a real chat (P6).
const MIN_MS = Date.UTC(2001, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

/** Seconds since 1970 (ChatGPT) or an ISO string (Claude, Gemini) to ISO in UTC, else null. */
export function toIso(value: unknown): string | null {
  let ms: number;
  if (typeof value === "number") ms = value * 1000;
  else if (typeof value === "string" && value.trim() !== "") ms = Date.parse(value);
  else return null;
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return null;
  return new Date(ms).toISOString();
}

/** Trims a text and cuts it at MAX_MESSAGE_CHARS. */
export function clip(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  return trimmed.length > MAX_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…` : trimmed;
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
