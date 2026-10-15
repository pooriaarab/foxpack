import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "foxpack-cli-"));
  const file = (name: string, data: string | Uint8Array) => {
    const path = join(home, name);
    writeFileSync(path, data);
    return path;
  };
  const cli = async (...args: string[]) => {
    let out = "";
    let err = "";
    const code = await run(args, { out: (s) => (out += s), err: (s) => (err += s), env: { FOXPACK_HOME: home } });
    return { code, out, err };
  };
  return { home, file, cli };
}

describe("foxpack CLI", () => {
  it("imports every source, reviews, searches and exports", async () => {
    const { file, cli } = setup();
    const zip = file("chatgpt.zip", zipSync({ "conversations.json": strToU8(fixture("chatgpt-conversations.json")) }));
    const r1 = await cli("import", "chatgpt", zip);
    expect(r1).toMatchObject({ code: 0, out: "" });
    expect(r1.err).toContain("Imported 3 conversations and 5 new memory candidates from chatgpt (2 entries skipped).");
    expect((await cli("import", "claude", file("c.json", fixture("claude-conversations.json")))).code).toBe(0);
    expect((await cli("import", "gemini", file("MyActivity.json", fixture("gemini-MyActivity.json")))).code).toBe(0);
    expect((await cli("import", "memories", file("m.txt", fixture("saved-memories.txt")))).code).toBe(0);
    expect((await cli("stats")).out).toBe("conversations: 8 (chatgpt 3, claude 3, gemini 2, memories 0)\nmessages: 17\nmemories: 15 pending, 0 accepted, 0 rejected, 0 forgotten\n");

    const pending = (await cli("memories", "--pending")).out.trim().split("\n");
    expect(pending).toHaveLength(15);
    const [a, b, c] = pending.map((l) => l.split("  ")[0] ?? "");
    expect((await cli("accept", a ?? "", b ?? "")).code).toBe(0);
    expect((await cli("reject", c ?? "")).code).toBe(0);
    expect((await cli("memories")).out).toBe("" + pending.slice(0, 2).map((l) => `${l.replace("[pending] ", "")}\n`).join(""));

    expect((await cli("search", "aisle", "seats")).out).toContain("chatgpt:6795a1b2-0001  user  Trip to Lisbon");
    const md = await cli("export", "--format", "markdown", "--no-conversations");
    expect(md.code).toBe(0);
    expect(md.out.match(/^- \*\*/gm)).toHaveLength(2);
    expect(md.err).toBe("");
  });

  it("C1: a wrong command, source or argument exits 2 with the usage", async () => {
    const { cli, file } = setup();
    for (const args of [[], ["nope"], ["import", "bard", file("x.json", "[]")], ["import", "claude"], ["export"], ["export", "--format", "csv"], ["memories", "--bogus"], ["accept"]]) {
      const r = await cli(...args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
      expect(r.err).toContain("Usage: foxpack");
    }
    expect((await cli("--help")).code).toBe(0);
  });

  it("C2: a failed import exits 1 with one line, and the pack does not change", async () => {
    const { cli, file, home } = setup();
    await cli("import", "memories", file("m.txt", "- Likes tea and toast."));
    const before = readFileSync(join(home, "pack.json"), "utf8");
    const bad = await cli("import", "chatgpt", file("bad.zip", new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])));
    expect(bad).toMatchObject({ code: 1, out: "" });
    expect(bad.err).toMatch(/^foxpack: corrupt_zip: .+\n$/);
    expect((await cli("import", "claude", join(home, "missing.json"))).err).toMatch(/^foxpack: bad_input: There is no file/);
    expect((await cli("accept", "m-nope")).err).toMatch(/^foxpack: not_found:/);
    expect(readFileSync(join(home, "pack.json"), "utf8")).toBe(before);
  });

  it("C4: a confidence that is not a number from 0 to 1 is corrupt_store", async () => {
    const { cli, file, home } = setup();
    await cli("import", "memories", file("m.txt", "- Likes tea and toast."));
    await cli("accept", (await cli("memories", "--pending")).out.split("  ")[0] ?? "");
    const good = JSON.parse(readFileSync(join(home, "pack.json"), "utf8"));
    for (const confidence of ["high", null, 2, -0.5]) {
      writeFileSync(join(home, "pack.json"), JSON.stringify({ ...good, memories: [{ ...good.memories[0], confidence }] }));
      for (const args of [["memories"], ["stats"]]) {
        const r = await cli(...args);
        expect(r).toMatchObject({ code: 1, out: "" });
        expect(r.err).toMatch(/^foxpack: corrupt_store: .*confidence/);
      }
    }
  });

  it("C3: export writes only the export to stdout", async () => {
    const { cli, file } = setup();
    await cli("import", "memories", file("m.txt", "- Likes tea and toast."));
    const id = (await cli("memories", "--pending")).out.split("  ")[0] ?? "";
    await cli("accept", id);
    const r = await cli("export", "--format", "foxpack");
    expect(JSON.parse(r.out).memories.map((m: { text: string }) => m.text)).toEqual(["Likes tea and toast."]);
    expect(r.err).toBe("");
    const dti = await cli("export", "--format", "dti");
    expect(JSON.parse(dti.out)).toEqual([]);
  });

  it("restores a foxpack export with import foxpack", async () => {
    const a = setup();
    await a.cli("import", "memories", a.file("m.txt", "- Likes tea and toast."));
    await a.cli("accept", (await a.cli("memories", "--pending")).out.split("  ")[0] ?? "");
    const exported = (await a.cli("export", "--format", "foxpack")).out;
    const b = setup();
    const r = await b.cli("import", "foxpack", b.file("e.json", exported));
    expect(r.err).toContain("Restored 0 conversations and 1 memories to review.");
    expect((await b.cli("memories", "--pending")).out).toMatch(/\[pending\] Likes tea and toast\.\n$/);
  });
});
