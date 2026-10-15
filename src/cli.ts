// The foxpack command. It works on the pack file at $FOXPACK_HOME/pack.json
// (default ~/.foxpack/pack.json). Only results go to stdout; messages and
// errors go to stderr (C3). Exit 0 when it works, 1 when it fails, 2 for
// bad arguments (C1).
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FoxpackError } from "./errors.js";
import { EXPORT_FORMATS, type ExportFormat } from "./export.js";
import { createPack, type Pack } from "./pack.js";
import { fileStore, packPath, readExportFile, readOnlySource, type FileStore } from "./node.js";
import { SOURCES, type MemoryRecord, type MemoryStatus, type Source } from "./types.js";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

export const USAGE = `Usage: foxpack <command> [arguments]

Commands:
  import chatgpt <export.zip>      A ChatGPT data export (zip or conversations.json).
  import claude <export.zip>       A Claude data export (zip, conversations.json or memories.json).
  import gemini <takeout.zip>      Google Takeout, My Activity > Gemini Apps, as JSON.
  import memories <file.txt>       A pasted list of saved memories, one per line.
  import foxpack <export.json>     A foxpack export, read back in.
  stats                            Count conversations, messages and memories.
  memories [--pending|--rejected|--all]
                                   List accepted memories (or others): id, kind, confidence, text.
  accept <id> [id...]              Accept memory candidates.
  reject <id> [id...]              Reject memory candidates.
  edit <id> <text>                 Change the text of a memory.
  forget <id> [id...]              Delete a memory's text, and never offer it again.
  search <words>                   Search the imported conversations (a text match).
  export --format foxpack|dti|markdown [--no-conversations]
                                   Print an export with the accepted memories.
  mcp                              Start the read-only MCP server on stdio.

The pack is ${"$"}FOXPACK_HOME/pack.json, else ~/.foxpack/pack.json.
`;

class UsageError extends Error {}

const line = (m: MemoryRecord) => `${m.id}  ${m.kind}  ${m.confidence.toFixed(2)}  ${m.status === "accepted" ? "" : `[${m.status}] `}${m.text}\n`;

async function importCommand(pack: Pack, store: FileStore, rest: string[], io: Io): Promise<void> {
  const [source, file, ...extra] = rest;
  if (!source || !file || extra.length > 0) throw new UsageError("import needs a source and one file.");
  const bytes = await readExportFile(file);
  if (source === "foxpack") {
    const r = await store.lock(() => pack.restore(bytes));
    io.err(`Restored ${r.conversations} conversations and ${r.memories} accepted memories.\n`);
    return;
  }
  if (!SOURCES.includes(source as Source)) throw new UsageError(`The source must be chatgpt, claude, gemini, memories or foxpack, not ${source}.`);
  const r = await store.lock(() => pack.import(source as Source, bytes));
  io.err(`Imported ${r.conversations} conversations and ${r.added} new memory candidates from ${r.source}${r.skipped ? ` (${r.skipped} ${r.skipped === 1 ? "entry" : "entries"} skipped)` : ""}.\n`);
  io.err("Review them with: foxpack memories --pending\n");
}

async function command(name: string, rest: string[], io: Io): Promise<void> {
  const store = fileStore(packPath(io.env));
  const pack = createPack({ store });
  switch (name) {
    case "import":
      return importCommand(pack, store, rest, io);
    case "stats": {
      if (rest.length > 0) throw new UsageError("stats takes no arguments.");
      const s = await pack.stats();
      const by = SOURCES.map((x) => `${x} ${s.bySource[x]}`).join(", ");
      io.out(`conversations: ${s.conversations} (${by})\nmessages: ${s.messages}\nmemories: ${s.memories.pending} pending, ${s.memories.accepted} accepted, ${s.memories.rejected} rejected, ${s.memories.forgotten} forgotten\n`);
      return;
    }
    case "memories": {
      const { values } = parseArgs({ args: rest, options: { pending: { type: "boolean" }, rejected: { type: "boolean" }, all: { type: "boolean" } } });
      const status: MemoryStatus[] = values.all ? ["pending", "accepted", "rejected"] : values.pending ? ["pending"] : values.rejected ? ["rejected"] : ["accepted"];
      for (const m of await pack.memories({ status })) io.out(line(m));
      return;
    }
    case "accept":
    case "reject":
    case "forget": {
      if (rest.length === 0) throw new UsageError(`${name} needs at least one id.`);
      await store.lock(async () => {
        for (const id of rest) io.err(`${name === "accept" ? "Accepted" : name === "reject" ? "Rejected" : "Forgot"}: ${(await pack[name](id)).text || id}\n`);
      });
      return;
    }
    case "edit": {
      const [id, ...words] = rest;
      if (!id || words.length === 0) throw new UsageError("edit needs an id and the new text.");
      const m = await store.lock(() => pack.edit(id, words.join(" ")));
      io.err(`Edited: ${m.text}\n`);
      return;
    }
    case "search": {
      if (rest.length === 0) throw new UsageError("search needs words to look for.");
      for (const h of await pack.search(rest.join(" "))) io.out(`${h.conversationId}  ${h.role}  ${h.title}\n  ${h.snippet.replace(/\s+/g, " ")}\n`);
      return;
    }
    case "export": {
      const { values } = parseArgs({ args: rest, options: { format: { type: "string" }, "no-conversations": { type: "boolean" } } });
      if (!EXPORT_FORMATS.includes(values.format as ExportFormat)) throw new UsageError("export needs --format foxpack, dti or markdown.");
      io.out(await pack.export({ format: values.format as ExportFormat, conversations: !values["no-conversations"] }));
      return;
    }
    case "mcp": {
      if (rest.length > 0) throw new UsageError("mcp takes no arguments.");
      const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([import("./mcp.js"), import("@modelcontextprotocol/sdk/server/stdio.js")]);
      const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      const server = createMcpServer({ data: readOnlySource(store).data, version });
      // The server stops when the client closes the session or stdin ends.
      const closed = new Promise<void>((done) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK has no addEventListener
        server.server.onclose = done;
        process.stdin.once("end", done);
      });
      await server.connect(new StdioServerTransport());
      io.err(`foxpack MCP server: read-only, on ${store.path}\n`);
      await closed;
      return;
    }
    default:
      throw new UsageError(`Unknown command: ${name}.`);
  }
}

/** Runs one foxpack command and returns the exit code. */
export async function run(args: string[], io: Io): Promise<number> {
  const [name, ...rest] = args;
  if (!name || name === "-h" || name === "--help" || name === "help") {
    (name ? io.out : io.err)(USAGE);
    return name ? 0 : 2;
  }
  try {
    await command(name, rest, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`foxpack: ${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    io.err(error instanceof FoxpackError ? `foxpack: ${error.code}: ${error.message}\n` : `foxpack: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
