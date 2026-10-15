import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPack, FoxpackError, fileStore, memoryResolver, packPath, readExportFile } from "../src/node.js";

const dir = () => mkdtempSync(join(tmpdir(), "foxpack-"));
const errorCode = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof FoxpackError ? e.code : String(e)));
const chat = JSON.stringify([{ uuid: "c1", name: "t", created_at: "2026-05-01T00:00:00Z", chat_messages: [{ uuid: "m1", sender: "human", text: "I prefer aisle seats.", created_at: "2026-05-01T00:00:00Z" }] }]);

describe("foxpack/node", () => {
  it("N2: the pack file is $FOXPACK_HOME/pack.json, else ~/.foxpack/pack.json", () => {
    expect(packPath({ FOXPACK_HOME: "/tmp/x" })).toBe("/tmp/x/pack.json");
    expect(packPath({})).toMatch(/\.foxpack\/pack\.json$/);
  });

  it("N2: makes the folder 0700 and the file 0600", async () => {
    const home = join(dir(), "new", "home");
    const pack = createPack({ store: fileStore(join(home, "pack.json")) });
    await pack.import("claude", chat);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "pack.json")).mode & 0o777).toBe(0o600);
  });

  it("N1: a reader never sees a half-written file, and no temp file stays", async () => {
    const path = join(dir(), "pack.json");
    const pack = createPack({ store: fileStore(path) });
    const writes = Array.from({ length: 20 }, (_, i) => pack.import("memories", `- Likes ${"tea ".repeat(500)} number ${i}.`));
    let reads = 0;
    while (reads < 200) {
      try {
        JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      reads++;
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(writes);
    expect(readdirSync(join(path, "..")).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);
  });

  it("N3: a second writer waits for the lock, then fails with locked", async () => {
    const path = join(dir(), "pack.json");
    const a = fileStore(path);
    const b = fileStore(path, { waitMs: 200 });
    const gate: { open?: () => void } = {};
    const holding = a.lock(() => new Promise<void>((r) => (gate.open = r)));
    await new Promise((r) => setTimeout(r, 20));
    expect(await errorCode(b.save({ format: "foxpack/v1", conversations: [], memories: [], imports: [] }))).toBe("locked");
    gate.open?.();
    await holding;
    await b.save({ format: "foxpack/v1", conversations: [], memories: [], imports: [] });
  });

  it("N3: takes over a lock left by a dead process", async () => {
    const path = join(dir(), "pack.json");
    writeFileSync(`${path}.lock`, "99999\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    await fileStore(path, { waitMs: 100 }).save({ format: "foxpack/v1", conversations: [], memories: [], imports: [] });
    expect(JSON.parse(readFileSync(path, "utf8")).format).toBe("foxpack/v1");
  });

  it("K6: a pack file that is not JSON is corrupt_store and stays as it is", async () => {
    const path = join(dir(), "pack.json");
    writeFileSync(path, "{half");
    expect(await errorCode(createPack({ store: fileStore(path) }).import("claude", chat))).toBe("corrupt_store");
    expect(readFileSync(path, "utf8")).toBe("{half");
  });

  it("Z7: readExportFile checks the size before it reads, and names a missing file", async () => {
    const path = join(dir(), "big.json");
    writeFileSync(path, "x".repeat(2000));
    expect(await errorCode(readExportFile(path, 1000))).toBe("too_large");
    expect(await errorCode(readExportFile(join(dir(), "missing.zip")))).toBe("bad_input");
    expect((await readExportFile(path)).length).toBe(2000);
  });

  it("memoryResolver() with no argument reads the pack file at FOXPACK_HOME", async () => {
    const home = dir();
    const before = process.env.FOXPACK_HOME;
    process.env.FOXPACK_HOME = home;
    try {
      const pack = createPack({ store: fileStore() });
      await pack.import("claude", chat);
      await pack.accept((await pack.memories())[0]?.id ?? "");
      expect(await memoryResolver().read(["memory.preferences"], { derive: true })).toEqual({ "memory.preferences": ["I prefer aisle seats."] });
    } finally {
      process.env.FOXPACK_HOME = before;
    }
  });
});
