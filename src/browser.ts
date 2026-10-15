// For the Firefox extension: the pack in browser.storage.local, and the
// SCENT listener for runtime.onMessageExternal.
import { filterMemories, parsePack, type PackStore } from "./pack.js";
import { memoryResolver } from "./scent.js";
import type { PackData } from "./types.js";

/** The parts of browser.storage.local that foxpack uses. */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const PACK_KEY = "fpk:pack";
export const READS_KEY = "fpk:reads";
/** The only extension that may read memories (B1). */
export const FOXSCOPE_ID = "foxscope@pooriaarab";

/** The parts of the Web Locks API (navigator.locks) that foxpack uses. */
export interface Locks {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The pack in one storage.local key. Writes take a Web Lock named after the
 * key, which every page and the event page of the add-on share, so a stale
 * tab cannot write over another tab's change (K12).
 */
export function storageStore(area: StorageArea, key = PACK_KEY, locks: Locks = navigator.locks): PackStore {
  return {
    load: async () => (await area.get(key))[key] ?? null,
    save: (data: PackData) => area.set({ [key]: data }),
    lock: (fn) => locks.request(key, fn),
  };
}

/** One SCENT read, as the popup shows it. */
export interface ReadNotice {
  at: string;
  fields: string[];
}

type Sender = { id?: string } | undefined;

/** The error Firefox gives a sendMessage to an add-on id that is not installed. */
export const NOT_INSTALLED = "Could not establish connection. Receiving end does not exist.";

/**
 * The runtime.onMessageExternal listener. It answers `scent.list` and
 * `scent.read` for foxscope only. Any other sender gets the error of an
 * add-on that is not installed, so it cannot tell that foxpack is (B1):
 * an undefined answer would resolve its call. For any other message from
 * foxscope it returns undefined (B2). Each read is noted in storage, so
 * the popup can show it.
 */
export function scentListener(area: StorageArea, now: () => Date = () => new Date()) {
  const resolver = memoryResolver({ memories: async (f) => filterMemories(parsePack(await storageStore(area).load()), f) });
  return (message: unknown, sender: Sender): Promise<unknown> | undefined => {
    if (sender?.id !== FOXSCOPE_ID) return Promise.reject(new Error(NOT_INSTALLED));
    if (typeof message !== "object" || message === null) return undefined;
    const m = message as { type?: unknown; fields?: unknown; derive?: unknown };
    if (m.type === "scent.list") return resolver.list();
    if (m.type !== "scent.read") return undefined;
    if (!Array.isArray(m.fields) || m.fields.length > 50 || !m.fields.every((f) => typeof f === "string")) {
      return Promise.resolve({ error: "fields must be an array of up to 50 field names." });
    }
    return (async () => {
      try {
        const values = await resolver.read(m.fields as string[], { derive: m.derive === true });
        const reads = ((await area.get(READS_KEY))[READS_KEY] as ReadNotice[] | undefined) ?? [];
        await area.set({ [READS_KEY]: [...reads, { at: now().toISOString(), fields: Object.keys(values) }].slice(-20) });
        return values;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    })();
  };
}
