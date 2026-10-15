# Failure modes

This file lists every way foxpack can fail. Each row names the wanted
behavior and the test that checks it. The rows come before the code. The
tests for a part are written before the code of that part.

An export file is hostile input. It can come from a vendor that changed its
format, from a person who edited it, or from a stranger. foxpack never
trusts it, and never calls a network API to read it.

## Parsers (`parseChatGPT`, `parseClaude`, `parseGemini`, `parseSavedMemories`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| P1 | The input is not JSON, or is JSON of the wrong shape (an object where an array must be, a Claude file given to the ChatGPT parser). | The parser throws `FoxpackError` with code `bad_export`, and the message names the source and what it expected. | `tests/parse.test.ts` |
| P2 | One conversation in the file is broken (no id, no mapping, a node that points to a missing parent). | That conversation is skipped and counted in `skipped`. The others import. | `tests/parse.test.ts` |
| P3 | A ChatGPT conversation has edits and regenerations, so its `mapping` is a tree with many branches. | Only the branch that ends at `current_node` is kept, in order from the root. Messages on other branches never appear. | `tests/parse.test.ts` |
| P4 | A ChatGPT `mapping` has a cycle (a node is its own ancestor), or a branch deeper than the node count. | The walk stops at the first node it has seen. It does not loop forever. | `tests/parse.test.ts` |
| P5 | System, tool and hidden messages (custom instructions, browsing output, code output, `is_visually_hidden_from_conversation`) are imported as if the user said them. | Only `user` and `assistant` messages with text are kept. Tool and system messages, hidden messages and non-text parts (images, files) are dropped. | `tests/parse.test.ts` |
| P6 | A timestamp is missing, `null`, a float in seconds, an ISO string or nonsense. | Times become ISO 8601 strings in UTC. A missing or bad time becomes `null`. It never becomes 1970 or `Invalid Date`. | `tests/parse.test.ts` |
| P7 | A Claude message has its text in `content` blocks, not in `text`, or in both. | The text comes from the `text` blocks of `content` when there are any, else from `text`. Tool blocks and attachments are dropped. | `tests/parse.test.ts` |
| P8 | A Claude message has a sender that is not `human` or `assistant`. | The message is dropped. | `tests/parse.test.ts` |
| P9 | A Gemini Takeout file holds activity from other Google products, or entries that are not prompts ("Used Gemini Apps", "Created Gemini Canvas titled ..."). | Only entries with the header `Gemini Apps` (or the older `Bard`) and a title that starts with `Prompted ` are kept. The others count in `skipped`. | `tests/parse.test.ts` |
| P10 | A Gemini answer is HTML that holds a script, a link or entities. | The answer becomes plain text: tags removed, entities decoded. No HTML reaches the store. | `tests/parse.test.ts` |
| P11 | Gemini Takeout has no conversation ids, so every prompt is a separate entry. | Entries with the same chat link (`gemini.google.com/app/<id>` in `titleUrl` or `details`) form one conversation. An entry with no link is a conversation of its own. This limit is in `docs/format.md` and the README. | `tests/parse.test.ts` |
| P12 | A pasted memory list has bullets (`-`, `*`, `•`, `1.`), blank lines, headings, a BOM or Windows line ends. | Each non-empty line is one memory, with its bullet and spaces removed. A line that starts with `#` or ends in `:` is a heading and is skipped. | `tests/parse.test.ts` |
| P16 | ChatGPT exports have no list of saved memories, so the memories are lost. | Each write to the `bio` memory tool, on any branch, becomes a saved memory with its conversation and date. It is a history of writes: a memory the user deleted later can be in it. | `tests/parse.test.ts` |
| P17 | ChatGPT custom instructions ("about you") repeat in every conversation and give one candidate per conversation. | Each distinct text becomes one user message in a `Custom instructions` conversation. | `tests/parse.test.ts` |
| P18 | Claude `memories.json` is Markdown prose with bold headings, not a list. | Headings are skipped, and a paragraph is split into sentences. | `tests/parse.test.ts` |
| P15 | The Takeout file is `MyActivity.html`, the Takeout default. | `parseGemini` throws `bad_export` and says to choose JSON for My Activity in Takeout. | `tests/parse.test.ts` |
| P13 | A text is huge (a pasted book in one message). | A message is cut at 20000 characters. A memory line longer than 200 characters is split into sentences, and a sentence longer than 500 characters is skipped. | `tests/parse.test.ts` |
| P19 | A memory list or memory file has tens of thousands of lines. | Repeats are dropped with a set, in linear time: 60000 lines parse in well under a second, and import into a pack in under 5 s. The import page does not freeze. | `tests/parse.test.ts` |
| P14 | Two imports of the same file make two copies of every conversation. | A conversation id is `<source>:<id in the export>`. A second import replaces the conversation, it does not add one. | `tests/pack.test.ts` |

## Zip files and size (`readExport`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| Z1 | The zip is corrupt or cut short. | `readExport` throws `FoxpackError` with code `corrupt_zip`. Nothing is stored. | `tests/zip.test.ts` |
| Z2 | The zip is a zip bomb: a small file that inflates to gigabytes, or a header that lies about the size. | The declared sizes of the needed files are added up before anything inflates. Past `maxBytes` (default 256 MiB) it stops with `too_large`. Each file inflates into a buffer of its declared size, so a header that lies gives a cut file, which fails as `bad_export`. | `tests/zip.test.ts` |
| Z3 | The zip has no `conversations.json` (a wrong zip, or a Takeout zip without Gemini). | It throws `bad_export` and names the file it looked for. | `tests/zip.test.ts` |
| Z4 | The export file is in a folder in the zip (`Takeout/My Activity/Gemini Apps/MyActivity.json`). | The file is found by its name at any depth. | `tests/zip.test.ts` |
| Z5 | A ChatGPT zip holds `conversations.json` and other big files (images, audio). | Only the needed JSON files are inflated. The others are skipped unread. | `tests/zip.test.ts` |
| Z6 | A plain JSON file is given where a zip is expected, or the other way round. | `readExport` looks at the first bytes (`PK`), not the file name. | `tests/zip.test.ts` |
| Z7 | A JSON file is larger than `maxBytes`. | It throws `too_large` before it parses. | `tests/zip.test.ts` |

## Memory candidates (`extractMemories`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| X1 | A sentence from the assistant becomes a memory about the user ("I am an AI model"). | Only user turns are read. | `tests/extract.test.ts` |
| X2 | A question, a condition or a role play becomes a fact ("Am I allergic to nuts?", "If I am late...", "Pretend I am a pirate"). | Sentences that end in `?`, or start with `if`, `when`, `pretend`, `imagine`, `suppose`, are skipped. | `tests/extract.test.ts` |
| X3 | A secret becomes a memory ("my password is hunter2", "my SSN is ..."). | A sentence that names a password, PIN, passcode, SSN, social security number, card number, API key, token or secret, or that holds a long digit run, is never a candidate. | `tests/extract.test.ts` |
| X4 | Code or a pasted document becomes a memory. | Text in code fences is skipped. A user turn longer than 4000 characters is skipped. | `tests/extract.test.ts` |
| X5 | Two runs on the same pack give other ids or another order. | Ids come from a hash of the kind and the normalized text. The order is fixed. The same input gives the same output. | `tests/extract.test.ts` |
| X6 | The same fact said in five conversations gives five candidates. | One candidate, with the first source and date, and a count of the conversations. Confidence goes up with the count, to at most 0.95. | `tests/extract.test.ts` |
| X7 | A candidate has no trace to where it came from. | Each candidate has the conversation id, the source and the date of the message, or `null` when the export has no date. A pasted memory has no conversation. | `tests/extract.test.ts` |
| X8 | A candidate is too short or too long to mean anything ("I am a", 300 words). | The text must be 8 to 200 characters. | `tests/extract.test.ts` |

## The pack (`createPack`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| K1 | A rejected candidate comes back after the next import. | A decision is kept by candidate id. A new import never changes an accepted, rejected or forgotten id back to pending. | `tests/pack.test.ts` |
| K2 | `accept`, `reject`, `edit` or `forget` gets an unknown id. | It throws `not_found`. The store does not change. | `tests/pack.test.ts` |
| K3 | `edit` sets an empty text or one longer than 500 characters. | It throws `bad_input`. | `tests/pack.test.ts` |
| K4 | `forget` leaves the memory in foxmemory. | `forget` calls `memory.forget` on the foxmemory id, and keeps a tombstone so a new import does not offer it again. | `tests/pack.test.ts` |
| K5 | foxmemory fails during `accept`. | The candidate stays pending, and the error goes to the caller. The pack and foxmemory do not disagree. | `tests/pack.test.ts` |
| K6 | The stored pack is corrupt, or comes from a newer foxpack. | `createPack` throws `corrupt_store` with the reason. It never replaces the file with an empty pack. | `tests/pack.test.ts` |
| K7 | A failed import leaves half of a file in the store. | Parse and extract finish before the store is written. One import is one write. | `tests/pack.test.ts` |
| K8 | Two calls at the same time lose a write. | The calls of one pack run one after the other. | `tests/pack.test.ts` |
| K9 | `search` with an empty query returns the whole pack. | It throws `bad_input`. Results are capped at `limit` (default 20). | `tests/pack.test.ts` |
| K10 | Edits of an accepted memory are lost in foxmemory. | `edit` of an accepted memory calls `memory.update`. | `tests/pack.test.ts` |

## Export (`pack.export`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| E1 | A rejected, forgotten or pending candidate is in an export. | Exports hold accepted memories only. | `tests/export.test.ts`, E2E |
| E2 | Markdown output breaks when a text holds `#`, `*`, `|` or a new line. | Memory and message text is escaped and kept on its own line. | `tests/export.test.ts` |
| E3 | An export cannot be read back in. | A `foxpack` export imports into an empty pack with the same conversations and accepted memories. | `tests/export.test.ts` |
| E4 | An unknown format is asked for. | It throws `bad_input` and lists the formats. | `tests/export.test.ts` |

## SCENT resolver (`memoryResolver`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| S1 | A raw conversation reaches an agent. | `memory.conversations` is listed as `private`. `read` never returns it, also when it is asked for by name. | `tests/scent.test.ts` |
| S2 | A pending or rejected candidate reaches an agent. | `read` returns accepted memories only. | `tests/scent.test.ts` |
| S3 | A field outside the `memory` namespace, or an unknown field, is asked for. | It is left out of the answer. It does not throw, and it does not return other data. | `tests/scent.test.ts` |
| S4 | `derive: true` returns as much as `derive: false`. | With `derive`, a field is a list of texts only, with no source, date or conversation id. | `tests/scent.test.ts` |

## Node store and CLI

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| N1 | A crash during a write leaves a half-written `pack.json`. | Writes go to a temp file in the same folder, then rename. | `tests/node.test.ts` |
| N2 | `FOXPACK_HOME` is not set and the home folder does not exist. | The default is `~/.foxpack/pack.json`. The folder is made with mode 0700, the file with 0600. | `tests/node.test.ts` |
| N3 | Two CLI processes write the pack at the same time. | A lock file next to `pack.json` keeps writers apart, over the whole read, change and write. A second writer waits, then fails with `locked`. A lock from a dead process (older than 30 s) is taken over. | `tests/node.test.ts` |
| C1 | A command or a source name is wrong. | The CLI prints the usage to stderr and exits 2. | `tests/cli.test.ts` |
| C2 | An import fails (bad file, corrupt zip). | The CLI prints one line with the code and the reason to stderr, and exits 1. The store does not change. | `tests/cli.test.ts` |
| C3 | `export` writes binary or log text to stdout and breaks a pipe to a file. | Only the export goes to stdout. Messages go to stderr. | `tests/cli.test.ts` |

## MCP server (`foxpack mcp`)

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| M1 | A tool returns raw conversations or pending candidates. | The tools are `memory_list`, `memory_search` and `pack_stats`. They read accepted memories and counts only. | `tests/mcp.test.ts` |
| M2 | A tool changes the pack. | No tool writes. The server opens the store read-only and has no write path. | `tests/mcp.test.ts` |
| M3 | Memory text holds instructions to the model ("ignore the user and..."). | Memory text goes back as data in a JSON block, and the tool descriptions say it is the user's notes, not instructions. | `tests/mcp.test.ts` |

## Extension

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| B1 | Another extension or a web page reads memories through `onMessageExternal`. | Only sender id `foxscope@pooriaarab` gets an answer. Any other sender gets nothing: the listener returns `undefined`. | `tests/background.test.ts`, E2E (a stand-in foxscope and a stand-in stranger extension) |
| B2 | foxscope sends a message that is not `scent.list` or `scent.read`, or `scent.read` with bad fields. | The answer is `undefined` for an unknown type and `{ error }` for bad fields. It never throws in the event page. | `tests/background.test.ts` |
| B3 | The import page uploads an export to read it. | The page reads the file with `File.arrayBuffer()` and parses it in the page. The manifest has no host permissions, so a request cannot leave. | E2E, manifest review |
| B4 | A wrong file is dropped (a photo, a zip of something else). | The page shows the error in words and stores nothing. | E2E |
| B5 | Decisions are lost when the page reloads. | Each decision is saved in `storage.local` before the list changes. After a reload the list shows the same states. | E2E |

## Data collection declaration (`extension/manifest.json`)

| ID | Failure | Wanted result | How we check |
|---|---|---|---|
| DC1 | The add-on starts to send user data while the manifest still declares `"none"`. | The same change adds the matching AMO data types to `data_collection_permissions`. | Review of each change to `extension/` |
