// createPack: the local store of imported conversations and memory
// candidates, and the review flow (accept, reject, edit, forget). The
// pack lives in a PackStore: a JSON file in Node (foxpack/node),
// storage.local in the extension, or memory in tests.
import { checkPack, EXPORTED, STORED } from "./check.js";
import { exportPack, type ExportOptions } from "./export.js";
import { extractMemories, normalize, redact } from "./extract.js";
import { FoxpackError } from "./errors.js";
import { readExport, type ReadOptions } from "./read.js";
import { SOURCES, type Conversation, type ImportRecord, type MemoryKind, type MemoryRecord, type MemoryStatus, type PackData, type Source } from "./types.js";

/** Where a pack is kept. `load` returns null when nothing is stored yet. */
export interface PackStore {
  load(): Promise<unknown>;
  save(data: PackData): Promise<void>;
}

/**
 * The parts of a foxmemory `FoxMemory` that foxpack calls. Pass
 * `createMemory(...)` from foxmemory: accepted memories go there too.
 */
export interface MemorySink {
  remember(text: string, meta: { kind: "fact" | "preference"; source: string }): Promise<{ memory: { id: string } }>;
  update(id: string, patch: { text: string }): Promise<unknown>;
  forget(id: string): Promise<boolean>;
}

export interface PackOptions {
  store: PackStore;
  memory?: MemorySink;
  /** Limits for each import. */
  read?: ReadOptions;
  now?: () => Date;
}

export interface ImportResult {
  source: Source;
  conversations: number;
  candidates: number;
  /** Candidates that the pack did not have before. */
  added: number;
  skipped: number;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  source: Source;
  messageId: string;
  role: "user" | "assistant";
  createdAt: string | null;
  snippet: string;
}

export interface PackStats {
  conversations: number;
  messages: number;
  bySource: Record<Source, number>;
  memories: Record<MemoryStatus, number>;
  imports: ImportRecord[];
}

export interface MemoryFilter {
  status?: MemoryStatus | MemoryStatus[];
  kind?: MemoryKind;
  /** A plain text match, any case. */
  query?: string;
}

export const MAX_MEMORY_TEXT = 500;
const MAX_IMPORTS = 100;

export const emptyPack = (): PackData => ({ format: "foxpack/v1", conversations: [], memories: [], imports: [] });

/** Checks a stored pack, every record of it. Throws `corrupt_store`, and never turns bad data into an empty pack (K6). */
export function parsePack(raw: unknown): PackData {
  if (raw === null || raw === undefined) return emptyPack();
  return checkPack(raw, STORED);
}

/** A foxpack file is at most this deep: pack, conversations, one, messages, one, and room to spare (E5). */
const MAX_DEPTH = 16;

/** Throws bad_export when JSON text nests past MAX_DEPTH, so a deep file never reaches JSON.parse or a save. */
function checkDepth(text: string) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (++depth > MAX_DEPTH) throw new FoxpackError("bad_export", `This file nests deeper than ${MAX_DEPTH} levels, so it is not a foxpack export.`);
    } else if (ch === "]" || ch === "}") depth--;
  }
}

const statuses = (s: MemoryFilter["status"]) => (s === undefined ? ["pending", "accepted", "rejected"] : Array.isArray(s) ? s : [s]);

/** Memories that match a filter. The default leaves out forgotten ones. */
export function filterMemories(data: PackData, filter: MemoryFilter = {}): MemoryRecord[] {
  const wanted = statuses(filter.status);
  const q = filter.query ? normalize(filter.query) : "";
  return data.memories.filter((m) => wanted.includes(m.status) && (!filter.kind || m.kind === filter.kind) && (!q || normalize(m.text).includes(q)));
}

export function packStats(data: PackData): PackStats {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
  for (const c of data.conversations) bySource[c.source]++;
  const memories: Record<MemoryStatus, number> = { pending: 0, accepted: 0, rejected: 0, forgotten: 0 };
  for (const m of data.memories) memories[m.status]++;
  return { conversations: data.conversations.length, messages: data.conversations.reduce((n, c) => n + c.messages.length, 0), bySource, memories, imports: data.imports.slice(-10) };
}

/** A plain text search over conversation titles and messages (K9). */
export function searchConversations(data: PackData, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) throw new FoxpackError("bad_input", "Give a word or a phrase to search for.");
  const hits: SearchHit[] = [];
  for (const c of data.conversations) {
    for (const m of c.messages) {
      const at = m.text.toLowerCase().indexOf(q);
      if (at < 0 && !c.title.toLowerCase().includes(q)) continue;
      const from = Math.max(0, at - 60);
      const snippet = `${from > 0 ? "…" : ""}${m.text.slice(from, Math.max(at, 0) + q.length + 60)}${at + q.length + 60 < m.text.length ? "…" : ""}`;
      hits.push({ conversationId: c.id, title: c.title, source: c.source, messageId: m.id, role: m.role, createdAt: m.createdAt, snippet });
      if (hits.length >= limit) return hits;
      if (at < 0) break; // a title match counts once per conversation
    }
  }
  return hits;
}

const forgottenIds = (d: PackData) => new Set(d.memories.filter((m) => m.status === "forgotten").map((m) => m.id));

const foxmemoryKind = (kind: MemoryKind) => (kind === "preference" ? "preference" : "fact");

export function createPack(options: PackOptions) {
  const { store, memory } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  let data: PackData | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  // One call at a time, so two calls never lose a write (K8).
  function run<T>(fn: (d: PackData) => Promise<T>): Promise<T> {
    const next = chain.then(async () => fn((data ??= parsePack(await store.load()))));
    chain = next.catch(() => undefined);
    return next;
  }

  async function commit(next: PackData) {
    await store.save(next);
    data = next;
  }

  /**
   * Applies fn to a copy of one memory, then saves. The pack does not change
   * when fn throws. fn can return a change to the rest of the pack. Other
   * records are shared, not copied, so a large pack stays fast.
   */
  function change(id: string, fn: (m: MemoryRecord) => Promise<void | ((d: PackData) => PackData)>): Promise<MemoryRecord> {
    return run(async (d) => {
      const at = d.memories.findIndex((m) => m.id === id);
      const old = d.memories[at];
      if (!old) throw new FoxpackError("not_found", `There is no memory with id ${id}.`);
      const record = structuredClone(old);
      const more = await fn(record);
      record.decidedAt = now();
      const next = { ...d, memories: d.memories.with(at, record) };
      await commit(more ? more(next) : next);
      return structuredClone(record);
    });
  }

  return {
    /** Reads one export file and adds it. Parsing finishes before anything is written (K7). */
    import(source: Source, contents: Uint8Array | ArrayBuffer | string, read: ReadOptions = options.read ?? {}): Promise<ImportResult> {
      if (!SOURCES.includes(source)) return Promise.reject(new FoxpackError("bad_input", `The source must be one of ${SOURCES.join(", ")}.`));
      return run(async (d) => {
        const parsed = readExport(source, contents, read);
        const candidates = extractMemories(parsed);
        const next: PackData = { ...d, conversations: [...d.conversations], memories: [...d.memories] };
        const byId = new Map(next.conversations.map((c, i) => [c.id, i]));
        for (const c of redact(parsed.conversations, forgottenIds(d))) {
          const at = byId.get(c.id);
          if (at === undefined) next.conversations.push(c);
          else next.conversations[at] = c; // a second import replaces (P14)
        }
        const known = new Set(next.memories.map((m) => m.id));
        let added = 0;
        for (const c of candidates) {
          if (known.has(c.id)) continue; // a decision is never undone by an import (K1)
          next.memories.push({ ...c, status: "pending", originalText: c.text, decidedAt: null });
          added++;
        }
        const record = { source, at: now(), conversations: parsed.conversations.length, candidates: candidates.length, skipped: parsed.skipped };
        next.imports = [...next.imports, record].slice(-MAX_IMPORTS);
        await commit(next);
        return { source, conversations: record.conversations, candidates: record.candidates, added, skipped: record.skipped };
      });
    },

    conversations(filter: { source?: Source } = {}): Promise<Conversation[]> {
      return run(async (d) => structuredClone(d.conversations.filter((c) => !filter.source || c.source === filter.source)));
    },

    search(query: string, opts: { limit?: number } = {}): Promise<SearchHit[]> {
      return run(async (d) => searchConversations(d, query, opts.limit));
    },

    memories(filter: MemoryFilter = {}): Promise<MemoryRecord[]> {
      return run(async (d) => structuredClone(filterMemories(d, filter)));
    },

    /** Accepts a candidate. With a foxmemory sink, it is stored there first; when that fails, nothing changes (K5). */
    accept(id: string): Promise<MemoryRecord> {
      return change(id, async (m) => {
        if (m.status === "accepted") return;
        if (m.status === "forgotten") throw new FoxpackError("bad_input", "This memory was forgotten, and its text is gone.");
        if (memory) m.foxmemoryId = (await memory.remember(m.text, { kind: foxmemoryKind(m.kind), source: m.conversationId ?? `foxpack:${m.source}` })).memory.id;
        m.status = "accepted";
      });
    },

    reject(id: string): Promise<MemoryRecord> {
      return change(id, async (m) => {
        if (m.status === "forgotten") throw new FoxpackError("bad_input", "This memory was forgotten already.");
        if (m.foxmemoryId && memory) await memory.forget(m.foxmemoryId);
        delete m.foxmemoryId;
        m.status = "rejected";
      });
    },

    /** Changes the text. An accepted memory changes in foxmemory too (K10). */
    edit(id: string, text: string): Promise<MemoryRecord> {
      const clean = text.trim();
      if (!clean || clean.length > MAX_MEMORY_TEXT) return Promise.reject(new FoxpackError("bad_input", `A memory must be 1 to ${MAX_MEMORY_TEXT} characters.`));
      return change(id, async (m) => {
        if (m.status === "forgotten") throw new FoxpackError("bad_input", "This memory was forgotten, and cannot be edited.");
        if (m.foxmemoryId && memory) await memory.update(m.foxmemoryId, { text: clean });
        m.text = clean;
      });
    },

    /**
     * Deletes the text, here, in the conversations it came from (K11) and
     * in foxmemory, and keeps the id so an import does not offer it again (K4).
     */
    forget(id: string): Promise<MemoryRecord> {
      return change(id, async (m) => {
        if (m.foxmemoryId && memory) await memory.forget(m.foxmemoryId);
        delete m.foxmemoryId;
        const texts = [m.text, m.originalText];
        Object.assign(m, { status: "forgotten", text: "", originalText: "", conversationId: null });
        return (d) => ({ ...d, conversations: redact(d.conversations, new Set([m.id]), texts) });
      });
    },

    /** Writes the pack as foxpack, dti or markdown. Accepted memories only (E1). */
    export(opts: ExportOptions): Promise<string> {
      return run(async (d) => exportPack(d, { now: options.now?.(), ...opts }));
    },

    /**
     * Reads a foxpack export back in (E3). Its conversations replace the
     * ones with the same id. Its accepted memories come back as pending,
     * because a file can say anything (E8); a decision this pack made wins.
     * One bad record and nothing is saved (E7).
     */
    restore(contents: string | Uint8Array): Promise<{ conversations: number; memories: number }> {
      return run(async (d) => {
        const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
        checkDepth(text);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch (error) {
          throw new FoxpackError("bad_export", `This is not a foxpack export (${error instanceof Error ? error.message : String(error)}).`);
        }
        const file = checkPack(raw, EXPORTED);
        const next: PackData = { ...d, conversations: [...d.conversations], memories: [...d.memories] };
        const at = new Map(next.conversations.map((c, i) => [c.id, i]));
        for (const c of redact(file.conversations, forgottenIds(d))) {
          const i = at.get(c.id);
          if (i === undefined) next.conversations.push(c);
          else next.conversations[i] = c;
        }
        const known = new Set(next.memories.map((m) => m.id));
        let added = 0;
        for (const m of file.memories) {
          if (m.status !== "accepted" || known.has(m.id)) continue;
          next.memories.push({ ...m, status: "pending", decidedAt: null });
          added++;
        }
        await commit(next);
        return { conversations: file.conversations.length, memories: added };
      });
    },

    /** Deletes every conversation and memory, here and in foxmemory. */
    clear(): Promise<void> {
      return run(async (d) => {
        if (memory) for (const m of d.memories) if (m.foxmemoryId) await memory.forget(m.foxmemoryId);
        await commit(emptyPack());
      });
    },

    stats(): Promise<PackStats> {
      return run(async (d) => packStats(d));
    },

    /** A copy of the whole stored pack. */
    data(): Promise<PackData> {
      return run(async (d) => structuredClone(d));
    },
  };
}

export type Pack = ReturnType<typeof createPack>;

/** A store in this process's memory. It starts empty, or with a copy of `initial`. */
export function inMemoryStore(initial?: unknown): PackStore & { saved: PackData | null } {
  let saved = initial === undefined ? null : structuredClone(initial);
  return {
    get saved() {
      return saved as PackData | null;
    },
    async load() {
      return structuredClone(saved);
    },
    async save(next) {
      saved = structuredClone(next);
    },
  };
}
