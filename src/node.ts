// foxpack/node: the pack in a JSON file for the CLI, the MCP server and
// Node callers. In Node, `import("@pooriaarab/foxpack")` gives this entry too, so
// `memoryResolver()` with no argument reads ~/.foxpack/pack.json.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
  /**
   * A lock file with no pid in it (its writer died before it wrote one) is
   * taken over when it is older than this. Default 30000 ms. A lock with a
   * pid is taken over only when that process is gone.
   */
  staleMs?: number;
}

export interface FileStore extends PackStore {
  readonly path: string;
}

/** Is a process with this pid running? EPERM means it runs as another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

/** The holder of a lock file: its pid, or null when the file has none. */
const holder = (file: string) => readFile(file, "utf8").then((text) => (/^\d+\n$/.test(text) ? Number(text) : null), () => null);

/** Flushes a folder, so a rename in it is on disk. Windows cannot open a folder, and does not need it. */
async function syncFolder(folder: string) {
  if (process.platform === "win32") return;
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException | null)?.code === code;

/** A pack in one JSON file. Writes go to a temp file and rename (N1), under a lock file (N3). */
export function fileStore(path: string = packPath(), options: FileStoreOptions = {}): FileStore {
  const lockPath = `${path}.lock`;
  const waitMs = options.waitMs ?? 5000;
  const staleMs = options.staleMs ?? 30_000;
  // The calls that run inside the lock, so a save there does not wait for itself (N4).
  const inside = new AsyncLocalStorage<true>();
  let turn: Promise<unknown> = Promise.resolve();

  /** Is the lock at `file` free to take: its pid is gone, or it has no pid and is old (N3)? */
  async function abandoned(file: string): Promise<boolean> {
    const pid = await holder(file);
    if (pid !== null) return !alive(pid);
    return stat(file).then((s) => Date.now() - s.mtimeMs > staleMs, () => false);
  }

  /**
   * Removes an abandoned lock. It moves the file away first, so of two
   * waiters only one gets it, then checks what it moved: when another
   * waiter has taken the lock meanwhile, it puts that lock back.
   */
  async function takeOver(): Promise<boolean> {
    if (!(await abandoned(lockPath))) return false;
    const moved = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.old`;
    try {
      await rename(lockPath, moved);
    } catch (error) {
      if (isCode(error, "ENOENT")) return true;
      throw error;
    }
    if (!(await abandoned(moved))) await link(moved, lockPath).catch(() => undefined);
    await rm(moved, { force: true });
    return true;
  }

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
      if (await takeOver()) continue;
      if (Date.now() > deadline) throw new FoxpackError("locked", `Another foxpack process is writing ${path}. Try again when it is done, or delete ${lockPath} if no foxpack runs.`);
      else await sleep(50);
    }
  }

  /** Runs fn under the lock file. Callers take turns: another pack on this store waits too (N4). */
  function lock<T>(fn: () => Promise<T>): Promise<T> {
    if (inside.getStore()) return fn();
    const next = turn.then(async () => {
      await acquire();
      try {
        return await inside.run(true, fn);
      } finally {
        await rm(lockPath, { force: true });
      }
    });
    turn = next.catch(() => undefined);
    return next;
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
        const file = await open(temp, "w", 0o600);
        try {
          await file.writeFile(JSON.stringify(data));
          await file.sync(); // the data is on disk before the rename makes it the pack (N1)
        } finally {
          await file.close();
        }
        await rename(temp, path);
        await syncFolder(dirname(path));
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
