// foxpack/node: the pack in a JSON file for the CLI, the MCP server and
// Node callers. In Node, `import("foxpack")` gives this entry too, so
// `memoryResolver()` with no argument reads ~/.foxpack/pack.json.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FoxpackError } from "./errors.js";
import { filterMemories, parsePack, type MemoryFilter, type PackStore } from "./pack.js";
import { DEFAULT_MAX_BYTES } from "./read.js";
import { memoryResolver as resolverOf, type MemorySource, type ScentResolver } from "./scent.js";
import type { PackData } from "./types.js";

export * from "./index.js";

/** The pack file: `$FOXPACK_HOME/pack.json`, else `~/.foxpack/pack.json` (N2). */
export function packPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.FOXPACK_HOME || join(homedir(), ".foxpack"), "pack.json");
}

export interface FileStoreOptions {
  /** How long a writer waits for the lock. Default 5000 ms. */
  waitMs?: number;
  /** A lock older than this is from a dead process and is taken over. Default 30000 ms. */
  staleMs?: number;
}

export interface FileStore extends PackStore {
  readonly path: string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | null)?.code === code;

/** A pack in one JSON file. Writes go to a temp file and rename (N1), under a lock file (N3). */
export function fileStore(path: string = packPath(), options: FileStoreOptions = {}): FileStore {
  const lockPath = `${path}.lock`;
  const waitMs = options.waitMs ?? 5000;
  const staleMs = options.staleMs ?? 30_000;
  let held = 0;

  async function acquire() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        return;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) await rm(lockPath, { force: true });
      else if (Date.now() > deadline) throw new FoxpackError("locked", `Another foxpack process is writing ${path}. Try again when it is done, or delete ${lockPath} if no foxpack runs.`);
      else await sleep(50);
    }
  }

  async function lock<T>(fn: () => Promise<T>): Promise<T> {
    if (held === 0) await acquire();
    held++;
    try {
      return await fn();
    } finally {
      held--;
      if (held === 0) await rm(lockPath, { force: true });
    }
  }

  return {
    path,
    lock,
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isCode(error, "ENOENT")) return null;
        throw error;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new FoxpackError("corrupt_store", `${path} is not JSON. Move it away to start a new pack.`);
      }
    },
    save(data: PackData) {
      return lock(async () => {
        const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, path);
      });
    },
  };
}

/** Reads an export file from disk. Its size is checked before it is read (Z7). */
export async function readExportFile(path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<Uint8Array> {
  const info = await stat(path).catch((error: unknown) => {
    throw new FoxpackError("bad_input", isCode(error, "ENOENT") ? `There is no file ${path}.` : `Cannot read ${path}.`);
  });
  if (!info.isFile()) throw new FoxpackError("bad_input", `${path} is not a file.`);
  if (info.size > maxBytes) throw new FoxpackError("too_large", `${path} is larger than ${maxBytes} bytes.`);
  return new Uint8Array(await readFile(path));
}

/** A read-only view of the memories in a stored pack. It has no write path. */
export function readOnlySource(store: PackStore): MemorySource & { data(): Promise<PackData> } {
  const data = async () => parsePack(await store.load());
  return { data, memories: async (filter?: MemoryFilter) => filterMemories(await data(), filter) };
}

/** A SCENT resolver for the memory namespace. With no source, it reads the pack file read-only. */
export function memoryResolver(source: MemorySource = readOnlySource(fileStore())): ScentResolver {
  return resolverOf(source);
}
