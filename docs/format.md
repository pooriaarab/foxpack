# The foxpack/v1 format

foxpack stores every import in one format, `foxpack/v1`. This file describes
it, says how it relates to the Data Transfer Initiative (DTI) schema, and
lists what we know about each vendor export and what we could not confirm.

## Why not the DTI schema itself

The Data Transfer Initiative publishes one schema for this area: "AI
Conversation History" (`$id` `https://id.schemas.pub/o/DTI/ai-personal-history`,
source in [dtinit/schema-refs](https://github.com/dtinit/schema-refs/blob/main/dti/ai-conversation.json),
listing at [schemas.pub/schemas/24](https://schemas.pub/schemas/24)). It was
added on 2025-11-13 with Inflection AI. The 2026-05-14 update added an
example to its README; the fields did not change. It has no version number.

One DTI object is one conversation: `details` (`createdBy`, `createdAt`,
`startTime`, `endTime`, `modality`), `identifiers` (the human senders) and
`messages` (`text`, `sentAt`, `sender`, `channel`). It has no conversation
id, no title, no message id, no roles other than "AI", and no place for
memories. DTI has no published memory schema.

So foxpack keeps its own format, which holds all of that, and writes DTI as
an export: `pack.export({ format: "dti" })` and `foxpack export --format dti`.

## foxpack/v1

```ts
interface PackData {
  format: "foxpack/v1";
  conversations: Conversation[];
  memories: MemoryRecord[];
  imports: ImportRecord[];   // the last 100 imports
}

interface Conversation {
  id: string;                // "<source>:<id in the export>"
  source: "chatgpt" | "claude" | "gemini" | "memories";
  title: string;             // "Untitled" when the export has none
  createdAt: string | null;  // ISO 8601, UTC; null when the export has no usable time
  updatedAt: string | null;
  messages: { id: string; role: "user" | "assistant"; text: string; createdAt: string | null }[];
}

interface MemoryRecord {
  id: string;                // "m" + a hash of the kind and the normalized text
  text: string;              // after any edit; "" once forgotten
  originalText: string;      // as extractMemories found it; "" once forgotten
  kind: "preference" | "fact" | "person" | "project";
  confidence: number;        // 0 to 1
  source: Source;
  conversationId: string | null;
  date: string | null;
  seenIn: number;            // how many conversations said it
  status: "pending" | "accepted" | "rejected" | "forgotten";
  decidedAt: string | null;
  foxmemoryId?: string;      // with a foxmemory sink
}
```

A `foxpack` export is the same object with `exportedAt`, the accepted
memories only, and an empty `imports` list. An exported memory has no
`originalText` and no `foxmemoryId`: the text the user edited out stays on
this computer. `pack.restore()` reads it back, checks every record, and
puts its memories back as pending: an export has no signature, so foxpack
cannot tell the user's own file from one someone else wrote.

### Mapping to DTI

| foxpack | DTI |
|---|---|
| `source` | `details.createdBy`: ChatGPT, Claude, Gemini |
| export time | `details.createdAt` |
| `createdAt`, else the first message time | `details.startTime` |
| `updatedAt`, else the last message time | `details.endTime` |
| — | `details.modality`: `text` |
| — | `identifiers`: one entry, `{ name: "User", identifier: "user" }` |
| `role: "user"` | `sender: "user"` |
| `role: "assistant"` | `sender: "AI"` |
| message `createdAt`, else `startTime` | `sentAt` |
| — | `channel`: `Web` |

Lost in DTI: ids, titles and memories. A conversation with no time at all
cannot be written, because `startTime` is required; it is left out.

## Vendor exports

No vendor publishes a schema for its export. Every field below was read in
open-source parsers that read real exports, and checked against help pages
where they exist. "Unconfirmed" means we found it in one source or none.

### ChatGPT (Settings > Data controls > Export)

- `conversations.json` is an array of conversations. Large exports split it
  into `conversations-000.json`, `conversations-001.json` and on, about 100
  conversations each, and drop the plain name. foxpack reads all of them.
  `shared_conversations.json` holds only link stubs and is not read.
- A conversation has `title`, `create_time` and `update_time` (seconds since
  1970), `conversation_id` (or `id`), `current_node` and `mapping`, a tree of
  `{ id, message, parent, children }`.
- foxpack keeps the branch from `current_node` to the root. With no
  `current_node`, it follows the last child from the root.
- Kept: `user` and `assistant` messages of type `text` and `multimodal_text`,
  with `recipient` `all`, not `is_visually_hidden_from_conversation`. Only
  string parts are kept; image parts are dropped.
- There is no list of saved memories in the export. foxpack reads writes to
  the `bio` memory tool as saved memories. Unconfirmed: the exact content
  shape of a `bio` write; foxpack reads string `parts`, else `text`. These
  writes are a history: a memory the user deleted later can still be there.
- Custom instructions: `metadata.user_context_message_data.about_user_message`.
  Each distinct text becomes one user message in a "Custom instructions"
  conversation, so extractMemories reads it.

### Claude (Settings > Privacy > Export data)

- `conversations.json`: an array of `{ uuid, name, created_at, updated_at,
  chat_messages }`. A message has `uuid`, `sender` (`human` or `assistant`),
  `text`, `content` blocks, `created_at` and `parent_message_uuid`.
- Newer exports leave `text` empty and put the body in `content` blocks of
  type `text`. foxpack reads the blocks first.
- Edits make branches through `parent_message_uuid`. The export has no
  pointer to the branch the user saw, so foxpack keeps the branch that ends
  at the newest message. This is a guess, the same one other parsers make.
- `memories.json`: `[{ conversations_memory, project_memories, account_uuid }]`,
  Markdown text. Unconfirmed: the keys of `project_memories` are project ids.
- Large exports come as an index file with `data_files` plus batch zips.
  foxpack refuses the index and asks for the batch zips.

### Gemini (Google Takeout > My Activity > Gemini Apps)

- Takeout writes My Activity as HTML by default. foxpack needs JSON: choose
  it under "Multiple formats" for My Activity. The HTML file gets an error
  that says so.
- The file is `Takeout/My Activity/Gemini Apps/MyActivity.json`. Older
  accounts may have a `Bard` folder (unconfirmed). Folder names can be in
  the account's language; foxpack finds `MyActivity.json` at any depth and
  prefers a `Gemini Apps` or `Bard` folder.
- An entry is `{ header: "Gemini Apps", title: "Prompted <prompt>", time,
  products, safeHtmlItem: [{ html: <answer> }] }`. Entries whose title does
  not start with `Prompted ` ("Used Gemini Apps", "Created Gemini Canvas
  titled ...") are skipped. Some entries have no answer.
- There are no conversation ids. foxpack groups entries by a chat link
  (`gemini.google.com/app/<id>`) in `titleUrl` or `details` when there is one
  (unconfirmed: whether Takeout writes it), else each entry is a conversation
  of its own.
- Unconfirmed: `subtitles`, `details`, `attachedFiles` and the word `Prompted`
  in accounts that are not in English.
- Gemini "Saved info" is not in Takeout as far as we could find. Copy it
  from the Saved info page and import it as a memory list.

### A pasted memory list

ChatGPT (Settings > Personalization > Manage memories), Gemini (Saved info)
and Claude (Settings > Memory) show saved memories but do not export them
as data. Copy the list, or ask the assistant to "list every memory you have
about me, one per line", and save it as a text file. One memory per line;
bullets and headings are removed.
