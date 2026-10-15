// The record checks for a stored pack (K6) and a restore file (E7). Each
// record is rebuilt from the fields foxpack knows, so a field it does not
// know never reaches the store, an export or a save.
import { FoxpackError, type FoxpackErrorCode } from "./errors.js";
import { MEMORY_KINDS, SOURCES, type Conversation, type ImportRecord, type MemoryRecord, type MemoryStatus, type Message, type PackData } from "./types.js";

const STATUSES: readonly MemoryStatus[] = ["pending", "accepted", "rejected", "forgotten"];
type Raw = Record<string, unknown>;

/** Reads one kind of file: the stored pack, or a foxpack export. */
export interface Checker {
  code: FoxpackErrorCode;
  /** "The stored pack" or "The file". */
  what: string;
  /** An export has no originalText or foxmemoryId (E6). */
  exported: boolean;
}

export const STORED: Checker = { code: "corrupt_store", what: "The stored pack", exported: false };
export const EXPORTED: Checker = { code: "bad_export", what: "The file", exported: true };

export function checkPack(raw: unknown, k: Checker): PackData {
  const fail = (reason: string): never => {
    throw new FoxpackError(k.code, `${k.what} ${reason}`);
  };
  const obj = (v: unknown, name: string): Raw => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : fail(`has ${name} that is not an object.`));
  const str = (v: unknown, name: string): string => (typeof v === "string" ? v : fail(`has ${name} that is not text.`));
  const time = (v: unknown, name: string): string | null => (v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v))) ? v : fail(`has ${name} that is not a date or null.`));
  const count = (v: unknown, name: string, min = 0): number => (Number.isSafeInteger(v) && (v as number) >= min ? (v as number) : fail(`has ${name} that is not a whole number from ${min}.`));
  const oneOf = <T extends string>(v: unknown, all: readonly T[], name: string): T => (all.includes(v as T) ? (v as T) : fail(`has ${name} that is not one of ${all.join(", ")}.`));
  const list = (v: unknown, name: string): unknown[] => (Array.isArray(v) ? v : fail(`is missing its ${name}.`));

  const value = obj(raw, "a top level");
  if (value.format !== "foxpack/v1") {
    fail(typeof value.format === "string" ? `has format ${value.format}, which this foxpack cannot read. Update foxpack.` : "has no format field.");
  }
  const conversationIds = new Set<string>();
  const conversations = list(value.conversations, "conversations").map((item, at): Conversation => {
    const c = obj(item, `conversation ${at}`);
    const name = `conversation ${typeof c.id === "string" ? c.id : at}:`;
    const id = str(c.id, `${name} an id`);
    if (conversationIds.has(id)) fail(`has two conversations with the id ${id}.`);
    conversationIds.add(id);
    const messages = list(c.messages, `${name} messages`).map((x, i): Message => {
      const m = obj(x, `${name} message ${i}`);
      return { id: str(m.id, `${name} a message id`), role: oneOf(m.role, ["user", "assistant"], `${name} a role`), text: str(m.text, `${name} a message text`), createdAt: time(m.createdAt, `${name} a message time`) };
    });
    return { id, source: oneOf(c.source, SOURCES, `${name} a source`), title: str(c.title, `${name} a title`), createdAt: time(c.createdAt, `${name} createdAt`), updatedAt: time(c.updatedAt, `${name} updatedAt`), messages };
  });
  const memoryIds = new Set<string>();
  const memories = list(value.memories, "memories").map((item, at): MemoryRecord => {
    const m = obj(item, `memory ${at}`);
    const name = `memory ${typeof m.id === "string" ? m.id : at}:`;
    const id = str(m.id, `${name} an id`);
    if (memoryIds.has(id)) fail(`has two memories with the id ${id}.`);
    memoryIds.add(id);
    if (typeof m.confidence !== "number" || !(m.confidence >= 0 && m.confidence <= 1)) fail(`has ${name} a confidence that is not a number from 0 to 1.`);
    const text = str(m.text, `${name} a text`);
    const record: MemoryRecord = {
      id,
      text,
      kind: oneOf(m.kind, MEMORY_KINDS, `${name} a kind`),
      confidence: m.confidence as number,
      source: oneOf(m.source, SOURCES, `${name} a source`),
      conversationId: m.conversationId === null ? null : str(m.conversationId, `${name} a conversationId`),
      date: time(m.date, `${name} a date`),
      seenIn: count(m.seenIn, `${name} seenIn`, 1),
      status: oneOf(m.status, STATUSES, `${name} a status`),
      originalText: k.exported ? text : str(m.originalText, `${name} an originalText`),
      decidedAt: time(m.decidedAt, `${name} decidedAt`),
    };
    if (!k.exported && m.foxmemoryId !== undefined) record.foxmemoryId = str(m.foxmemoryId, `${name} a foxmemoryId`);
    return record;
  });
  const imports = list(value.imports, "imports").map((item, at): ImportRecord => {
    const r = obj(item, `import ${at}`);
    const name = `import ${at}:`;
    const source = oneOf(r.source, SOURCES, `${name} a source`);
    const when = time(r.at, `${name} a time`) ?? fail(`has ${name} no time.`);
    return { source, at: when, conversations: count(r.conversations, `${name} conversations`), candidates: count(r.candidates, `${name} candidates`), skipped: count(r.skipped, `${name} skipped`) };
  });
  return { format: "foxpack/v1", conversations, memories, imports };
}
