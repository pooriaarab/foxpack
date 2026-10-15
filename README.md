# foxpack

[![npm version](https://img.shields.io/npm/v/foxpack)](https://www.npmjs.com/package/foxpack)
[![Downloads/month](https://img.shields.io/npm/dm/foxpack)](https://www.npmjs.com/package/foxpack)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Quickstart](#keep-your-first-memory) · [API reference](#runtime-surfaces) · [Export coverage](#coverage) · [FAQ](#faq)

foxpack brings your AI memory home: it imports ChatGPT, Claude and Gemini exports into a local store.
It finds memory candidates in what you said, and you accept, edit or reject each one.
Agents can read the accepted memories through SCENT or MCP; they never see the raw conversations.

## Install

```bash
npm install foxpack
```

Node.js 24 or later is required.
The library also runs in a browser; the Firefox extension targets Firefox 153 or later.
Runtime dependencies: `fflate` for zip files, and `@modelcontextprotocol/sdk` with `zod` for the MCP server.
foxmemory is an optional peer dependency.

## Keep your first memory

Save this as `example.mjs`, then run `node example.mjs`.
No API keys, network access or `.env` file are needed.

```js
import { createPack, inMemoryStore } from "foxpack";

const pack = createPack({ store: inMemoryStore() });
await pack.import("memories", "- Prefers aisle seats.\n- Has a dog named Miso.");
const [first] = await pack.memories({ status: "pending" });
await pack.accept(first.id);
console.log((await pack.memories({ status: "accepted" })).map((m) => `${m.kind}: ${m.text}`));
```

Success prints `[ 'preference: Prefers aisle seats.' ]`.
From the command line, with a real export:

```bash
npx foxpack import chatgpt ~/Downloads/chatgpt-export.zip
npx foxpack memories --pending
npx foxpack accept <id>
npx foxpack export --format markdown > my-memory.md
```

## How it works

```text
export file -> readExport (zip or JSON, size cap) -> parser per source -> conversations
conversations -> extractMemories (sentence patterns, no model) -> candidates
candidates -> you: accept / edit / reject / forget -> accepted memories
accepted memories -> export (foxpack, DTI, Markdown) | SCENT resolver | MCP tools | foxmemory
```

foxpack makes no network calls.
The pack is one JSON object: in `~/.foxpack/pack.json` for the CLI, in `browser.storage.local` for the extension.
A decision is kept by candidate id, so a new import never brings back a memory you rejected.

## Why it exists

Your AI memory sits in many vendor clouds, and you cannot read it, fix it or move it.
ChatGPT, Claude and Gemini each export your chats, but in three formats, and none of them exports your saved memories as data.
Claude's [memory import](https://claude.com/import-memory) takes a pasted summary from another assistant; nothing flows back.
foxpack reads all three exports in one place. You choose what is true, and the result stays on your computer.

## Compare

Checked on 2026-10-15 against the [convoviz README](https://github.com/mohamed-chs/convoviz) and the [Claude memory import page](https://claude.com/import-memory).

| Property | foxpack | convoviz | Claude memory import |
|---|---|---|---|
| Sources | ChatGPT, Claude, Gemini Takeout, pasted lists | ChatGPT | Text pasted from another assistant |
| Output | Local pack, foxpack/DTI/Markdown exports | Markdown files, word clouds and usage graphs | Memory inside Claude |
| Memory review | Each candidate: accept, edit, reject | None | Claude picks what to keep |
| Agent access | SCENT resolver and read-only MCP tools | None | Claude only |

## Coverage

| Export | Status | How it was checked |
|---|---|---|
| ChatGPT data export, zip or `conversations.json`, also split `conversations-000.json` files | ✓ | Fixtures built from field names in open-source parsers of real exports; Firefox E2E |
| ChatGPT memory writes (`bio` tool) and custom instructions | ✓ | Same; the `bio` content shape is unconfirmed |
| Claude data export, zip, `conversations.json`, `memories.json` | ✓ | Same |
| Google Takeout, My Activity > Gemini Apps, `MyActivity.json` | ✓ | Same; conversation grouping is unconfirmed, see [docs/format.md](docs/format.md) |
| Google Takeout as HTML (the Takeout default) | — | Refused with a message to choose JSON |
| A pasted memory list from any assistant | ✓ | Unit tests and E2E |
| DTI "AI Conversation History" export | ✓ | Checked against the required fields of the published schema |

No real user export was used in the tests. The fixtures follow the shapes in
[docs/format.md](docs/format.md), which lists what is confirmed and what is not.

## Common use cases

1. A person who used ChatGPT for two years moves to Claude and takes the facts that matter with them.
2. A Firefox user keeps one local list of their preferences and lets the foxscope extension share parts of it with an agent.
3. A developer gives a coding agent the user's accepted project notes through `foxpack mcp`, without the chats.
4. A foxmate builder sends accepted memories to foxmemory with `createPack({ store, memory })`.
5. A person backs up their history from three vendors as one Markdown file they can read.

## Features

- **Three vendor exports and plain lists:** zip or JSON, found at any depth in the zip; see [coverage](#coverage).
- **Candidates without a model:** fixed sentence patterns, a kind and a confidence, the source chat and date.
- **Review that sticks:** accept, edit, reject and forget survive re-imports. Forget deletes the memory, and the sentence it came from in your imported chats.
- **Exports:** foxpack JSON (reads back in), DTI JSON, Markdown; accepted memories only.
- **Agents see accepted memories only:** SCENT and MCP never return a conversation or a pending candidate.

## Runtime surfaces

### Library (`foxpack`)

| Export | What it does |
|---|---|
| `parseChatGPT(contents)`, `parseClaude(contents)`, `parseClaudeMemories(contents)`, `parseGemini(contents)`, `parseSavedMemories(text)` | Pure parsers, from file text or parsed JSON to `{ source, conversations, savedMemories, skipped }`. Throw `FoxpackError` `bad_export`. |
| `readExport(source, bytes or text, { maxBytes? })` | Detects a zip by its bytes, reads only the needed files, and calls the parser. `maxBytes` defaults to 256 MiB. |
| `extractMemories({ conversations, savedMemories?, source? })` | Candidates `{ id, text, kind, confidence, source, conversationId, date, seenIn }`. Kinds: `preference`, `fact`, `person`, `project`. |
| `createPack({ store, memory?, read?, now? })` | The pack. `store` is any `{ load(), save(data) }`; `memory` is a foxmemory memory. |
| `memoryResolver(pack)` | A SCENT v0.1 resolver for the `memory` namespace. |
| `exportPack(data, options)`, `toDti(conversation, at)` | The export functions that `pack.export` uses. |
| `inMemoryStore()`, `storageStore(browser.storage.local)` | Stores for tests and for an extension. |
| `scentListener(storage)` | The `runtime.onMessageExternal` listener: answers `foxscope@pooriaarab` only. |
| `FoxpackError` | Every failure. `code` is `bad_input`, `bad_export`, `corrupt_zip`, `too_large`, `not_found`, `corrupt_store` or `locked`. |

A pack has these methods. They run one at a time.

| Method | What it does |
|---|---|
| `import(source, contents)` | `source` is `chatgpt`, `claude`, `gemini` or `memories`. Returns `{ source, conversations, candidates, added, skipped }`. Nothing is written when it fails. |
| `conversations({ source? })`, `search(query, { limit? })` | The imported chats, and a plain text search over them. |
| `memories({ status?, kind?, query? })` | Candidates and memories. The default leaves out forgotten ones. |
| `accept(id)`, `reject(id)`, `edit(id, text)`, `forget(id)` | The review. With a foxmemory sink, accept, edit and forget change foxmemory too. |
| `export({ format, conversations? })` | `foxpack`, `dti` or `markdown`, with accepted memories only. |
| `restore(text)` | Reads a foxpack export back in. Its memories come back as pending, to review again: a file can say anything, so foxpack does not take its word that they were accepted. A local decision wins. One bad record and nothing is saved. |
| `stats()`, `clear()`, `data()` | Counts; delete everything; a copy of the stored pack. |

### `foxpack/node`

`fileStore(path?)` keeps the pack in `$FOXPACK_HOME/pack.json`, else `~/.foxpack/pack.json`, with a lock file and atomic writes.
`readExportFile(path)` checks the size before it reads.
In Node, `import("foxpack")` resolves to this entry, so `memoryResolver()` with no argument reads the pack file read-only.

### CLI

```bash
foxpack import chatgpt|claude|gemini|memories|foxpack <file>
foxpack stats
foxpack memories [--pending|--rejected|--all]
foxpack accept|reject|forget <id> [id...]
foxpack edit <id> <text>
foxpack search <words>
foxpack export --format foxpack|dti|markdown [--no-conversations]
foxpack mcp
```

Output of `stats` after one Claude export:

```text
conversations: 3 (chatgpt 0, claude 3, gemini 0, memories 0)
messages: 6
memories: 2 pending, 0 accepted, 0 rejected, 0 forgotten
```

Results go to stdout and messages to stderr. The exit code is 0 when the command works, 1 when it fails, and 2 for bad arguments.

### MCP server

`foxpack mcp` starts a read-only server on stdio with three tools:
`memory_list` (accepted memories, optional `kind`), `memory_search` (text match on accepted memories) and `pack_stats` (counts only).
No tool returns a conversation or a pending candidate, and no tool writes.

```json
{ "mcpServers": { "foxpack": { "command": "npx", "args": ["foxpack", "mcp"] } } }
```

### SCENT fields

| Field | Sensitivity | Value |
|---|---|---|
| `memory.preferences`, `memory.facts`, `memory.people`, `memory.projects` | ask | Accepted memories of that kind. With `derive`, texts only. |
| `memory.conversations` | private | Never returned. |

### Firefox extension

The import page (the add-on's options page) reads an export in the page and lists the candidates for review.
The popup counts the pack and lists the last reads by foxscope.
The add-on has the `storage` permission only, and no host permissions.

## Delivery and behavior limits

- **Patterns, not understanding.** extractMemories matches sentences like "I prefer...", "call me...", "my sister is...". It misses facts said any other way, and it can propose a sentence that is not true of you. You review each one.
- **No real exports in the tests.** The fixtures follow the field names that open-source parsers read in real exports. A vendor can change its export at any time.
- **Gemini has no conversation ids.** Entries are grouped by a chat link when the export has one, else each prompt is its own conversation.
- **One JSON object.** The whole pack is read and written at once. Very large histories (hundreds of MB) are slow, and the 256 MiB cap stops larger files.
- **Not encrypted.** The pack is plain JSON in your home folder or in Firefox storage.
- **Forget matches words, not meaning.** It removes the sentence that gave the memory and each exact copy of it, also in a re-import. A reply that says the same thing in other words stays in the chat.
- **ChatGPT memory writes are a history.** A memory you deleted in ChatGPT can still show up as a candidate.
- **The extension does not use foxmemory.** A separate add-on cannot read foxpack's storage anyway; use the library with your own foxmemory to share memories.

## FAQ

### Does foxpack upload my export?

No. The library, the CLI and the extension read the file on your computer and make no network calls.

### Which export formats are confirmed?

No vendor publishes a schema. [docs/format.md](docs/format.md) lists each field, where it was seen, and what is unconfirmed.

### Does foxpack use an AI model to find memories?

No. It uses fixed sentence patterns, so the same file always gives the same candidates.

### What is the DTI export?

The Data Transfer Initiative publishes an "AI Conversation History" schema. `export --format dti` writes one object per conversation in that schema. The schema has no place for memories, so a DTI export holds the conversations only.

### Can an agent read my conversations?

No. SCENT and MCP return accepted memories only. `memory.conversations` is a private field.

## Try the extension

```bash
pnpm install
pnpm ci:local
pnpm build:ext
```

Load `dist-ext/manifest.json` from Firefox `about:debugging`, then open the add-on's options page.
`pnpm e2e` runs the Firefox E2E and writes `artifacts/e2e-<date>.json`; set `FOXKIT_BROWSER=ichabod` to run it on Ichabod.

## License

[MIT](https://opensource.org/license/mit)
