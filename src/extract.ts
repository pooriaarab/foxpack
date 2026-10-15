// extractMemories: deterministic memory candidates from what the user said.
// No model: a short list of sentence patterns ("I prefer...", "call me...",
// "my sister is...") with a confidence for each. A person reviews every
// candidate before it is stored as a memory.
import type { Candidate, Conversation, MemoryKind, Message, SavedMemory, Source } from "./types.js";

export interface ExtractInput {
  /** The source of saved memories that have no conversation. Default: "memories". */
  source?: Source;
  conversations: readonly Conversation[];
  savedMemories?: readonly SavedMemory[];
}

/** A user turn longer than this is most likely pasted text, not the user's own words (X4). */
export const MAX_TURN_CHARS = 4000;
const MIN_CHARS = 8;
const MAX_CHARS = 200;
const MAX_SAVED_CHARS = 500;

const I_AM = String.raw`i(?:'m| am)`;
const RELATION = String.raw`(?:wife|husband|partner|spouse|girlfriend|boyfriend|fianc[eé]e?|son|daughter|kids?|children|child|baby|mom|mum|mother|dad|father|parents|brother|sister|sibling|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|niece|nephew|(?:best )?friend|roommate|boss|manager|colleague|co-?worker|co-?founder|teammate|dog|cat|pet)`;
const re = (source: string) => new RegExp(source, "i");

// First match wins, so the narrow patterns come first.
const PATTERNS: [MemoryKind, number, RegExp][] = [
  ["fact", 0.9, re(String.raw`^(?:you can |please )?call me\s+\S`)],
  ["fact", 0.9, re(String.raw`^my name is\s+\S`)],
  ["fact", 0.9, re(String.raw`^${I_AM}\s+(?:\w+\s+)?allergic to\s+\S`)],
  ["fact", 0.9, re(String.raw`^i have an?\s+(?:\w+\s+)?allerg(?:y|ies) to\s+\S`)],
  ["preference", 0.8, re(String.raw`^i(?:'d| would)?\s+(?:really\s+|usually\s+|always\s+)?prefer\s+\S`)],
  ["preference", 0.8, re(String.raw`^i(?:'d| would) rather\s+\S`)],
  ["preference", 0.8, re(String.raw`^my fav(?:ou?rite|e)\s+[\w ]{1,30}?\s+(?:is|are)\s+\S`)],
  ["preference", 0.7, re(String.raw`^${I_AM}\s+an?\s+(?:big |huge )?fan of\s+\S`)],
  ["person", 0.75, re(String.raw`^my\s+${RELATION}(?:'s name)?\s+(?:is|'s)\s+(?:called\s+|named\s+)?\S`)],
  ["person", 0.6, re(String.raw`^my\s+${RELATION}\s+(?:\w+\s+)?(?:lives|works|has|loves|likes|hates|was|studies|plays)\b`)],
  ["project", 0.65, re(String.raw`^${I_AM}\s+(?:currently\s+)?(?:working on|building|writing|developing|making|launching|starting)\s+\S`)],
  ["project", 0.65, re(String.raw`^my\s+(?:side\s+)?(?:project|startup|company|app|thesis|book|business|podcast|channel|blog|product)\b.*\b(?:is|'s|called|named)\b`)],
  ["preference", 0.6, re(String.raw`^i\s+(?:really\s+)?(?:love|like|enjoy|hate|dislike|adore|can't stand|cannot stand|don't like|do not like)\s+(?!(?:it|that|this|these|those|your|you|how|what|when|the idea)\b)\S`)],
  ["preference", 0.6, re(String.raw`^i\s+(?:always|never|usually)\s+\S`)],
  ["fact", 0.7, re(String.raw`^${I_AM}\s+an?\s+(?!(?:bit|little|lot)\b)\S`)],
  ["fact", 0.7, re(String.raw`^${I_AM}\s+\d{1,3}\s*(?:years old|yo)\b`)],
  ["fact", 0.7, re(String.raw`^${I_AM}\s+(?:from|based in)\s+\S`)],
  ["fact", 0.7, re(String.raw`^i\s+(?:live|work|study|grew up)\s+(?:in|at|for|near)\s+\S`)],
  ["fact", 0.7, re(String.raw`^${I_AM}\s+(?:vegan|vegetarian|pescatarian|gluten-free|lactose intolerant|diabetic|left-handed|married|single|divorced|pregnant|retired|deaf|blind|colou?rblind)\b`)],
  ["fact", 0.4, re(String.raw`^my\s+(?!(?:code|function|script|query|prompt|question|problem|issue|error|bug|output|input|file|test|example|text|essay|message|draft|request|answer|point|guess|idea|understanding)\b)[\w ]{1,30}?\s+(?:is|are)\s+\S`)],
];

// "Also, ", "btw ", "oh and " in front of a sentence.
const FILLER = /^(?:also|btw|by the way|fyi|oh|and|but|well|ok|okay|so|note|just so you know|for context|hi|hello|hey)\b[,:]?\s*/i;
// Questions, conditions and role play are not facts about the user (X2).
const NOT_A_FACT = /^(?:if|when|whenever|pretend|imagine|suppose|let's say|lets say|what if|act as|you are|as if|in this story)\b|\b(?:pretend|role-?play|imagine that)\b/i;
// Never a candidate: secrets, and digit runs such as card or phone numbers (X3).
const SECRET = /\b(?:password|passcode|passwd|pin|ssn|social security|credit card|card number|cvv|api ?key|token|secret|private key|seed phrase|recovery phrase|bank account|routing number|account number)\b|\d{6,}|(?:\d[ -]?){9,}/i;

/** Lower case, one space, no end punctuation: two ways of writing one fact give one id (X5). */
export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();

/** cyrb53: a small, fast 53-bit string hash. The same text gives the same id everywhere. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const candidateId = (kind: MemoryKind, text: string) => `m${hash(`${kind}|${normalize(text)}`)}`;

/** The kind of a saved memory, from its words. */
export function classify(text: string): MemoryKind {
  const t = text.toLowerCase();
  if (new RegExp(String.raw`\b${RELATION}\b`).test(t) && !/\bmy (?:own )?(?:dog|cat|pet) (?:food|bed)\b/.test(t)) return "person";
  if (/\b(?:working on|building|developing|launching|project|startup|thesis|side project)\b/.test(t)) return "project";
  if (/\b(?:prefer|prefers|preferred|likes?|loves?|enjoys?|hates?|dislikes?|favou?rite|rather|always|never|wants?)\b/.test(t)) return "preference";
  return "fact";
}

/** A sentence of a user turn, and where it is in the turn's text: `text.slice(start, end)`. */
interface Span {
  sentence: string;
  start: number;
  end: number;
}

/** Replaces each match with one space, and keeps for each character left its index in the text. */
function strip(text: string, at: readonly number[], pattern: RegExp): [string, number[]] {
  let out = "";
  const map: number[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += `${text.slice(last, match.index)} `;
    map.push(...at.slice(last, match.index), at[match.index] ?? 0);
    last = match.index + match[0].length;
  }
  map.push(...at.slice(last));
  return [out + text.slice(last), map];
}

/** Sentences of one user turn, with code removed (X4), and their spans in the turn. */
function spans(text: string): Span[] {
  if (text.length > MAX_TURN_CHARS) return [];
  let [prose, at] = strip(text, Array.from({ length: text.length }, (_, i) => i), /```[\s\S]*?(?:```|$)/g);
  [prose, at] = strip(prose, at, /`[^`\n]*`/g);
  prose = prose.replace(/[’‘]/g, "'"); // one character for one
  const found: Span[] = [];
  const add = (from: number, to: number) => {
    const raw = prose.slice(from, to);
    const sentence = raw.trim();
    const first = from + raw.length - raw.trimStart().length;
    if (sentence) found.push({ sentence, start: at[first] ?? 0, end: (at[first + sentence.length - 1] ?? 0) + 1 });
  };
  let from = 0;
  for (const gap of prose.matchAll(/(?<=[.!?])\s+|\n+/g)) {
    add(from, gap.index);
    from = gap.index + gap[0].length;
  }
  add(from, prose.length);
  return found;
}

const sentences = (text: string) => spans(text).map((s) => s.sentence);

function asCandidate(sentence: string): { text: string; kind: MemoryKind; base: number } | null {
  let s = sentence.replace(/^["'([]+|["')\]]+$/g, "");
  for (let i = 0; i < 3 && FILLER.test(s); i++) s = s.replace(FILLER, "");
  if (s.endsWith("?") || NOT_A_FACT.test(s) || SECRET.test(s)) return null;
  if (s.length < MIN_CHARS || s.length > MAX_CHARS) return null;
  for (const [kind, base, pattern] of PATTERNS) {
    if (!pattern.test(s)) continue;
    const text = `${s[0]?.toUpperCase()}${s.slice(1)}`.replace(/[,;:\s]+$/, "");
    return { text: /[.!]$/.test(text) ? text : `${text}.`, kind, base };
  }
  return null;
}

/** What a forgotten sentence becomes in a conversation (K11). */
export const FORGOTTEN = "[forgotten]";

/**
 * Removes forgotten memories from conversations (K11, K14). The source of
 * a memory is each user sentence whose candidate id is in `ids`: the id is
 * a hash of that sentence. Each such sentence, and nothing else, becomes
 * "[forgotten]", and so does its copy in the title (K15). Nothing
 * searches for a memory's text, so an edit to a short text ("I") cannot
 * reach other words. Conversations with nothing to remove are returned
 * as they are.
 */
export function redact(conversations: readonly Conversation[], ids: ReadonlySet<string>): Conversation[] {
  if (ids.size === 0) return [...conversations];
  const source = ({ sentence }: Span) => {
    const hit = asCandidate(sentence);
    return hit !== null && ids.has(candidateId(hit.kind, hit.text));
  };
  return conversations.map((c) => {
    const edits: Edit[] = [];
    const messages = c.messages.map((m): Message => {
      const gone = m.role === "user" ? spans(m.text).filter(source) : [];
      if (gone.length === 0) return m;
      let text = m.text;
      for (const { start, end } of gone.toReversed()) text = `${text.slice(0, start)}${FORGOTTEN}${text.slice(end)}`;
      edits.push({ from: m.text, to: text, gone: gone.map(({ start, end }) => m.text.slice(start, end)) });
      return { ...m, text };
    });
    return edits.length > 0 ? { ...c, title: retitle(c.title, edits), messages } : c;
  });
}

/** One message that redact changed: its text before and after, and the sentences it removed. */
interface Edit {
  from: string;
  to: string;
  gone: string[];
}

/**
 * The title of a conversation that redact changed (K15). A title that is a
 * copy of a message, whole or cut with "…" (Gemini names a chat after its
 * first prompt), becomes the same copy of the redacted message. Else each
 * removed sentence in it, word for word, becomes "[forgotten]". A title
 * that says it in other words ("Jane's epilepsy") stays.
 */
function retitle(title: string, edits: readonly Edit[]): string {
  const cut = title.endsWith("…") ? title.length - 1 : 0;
  for (const { from, to } of edits) {
    if (title === from) return to;
    if (cut > 0 && from.length > cut && from.startsWith(title.slice(0, cut))) return to.length > cut + 1 ? `${to.slice(0, cut)}…` : to;
  }
  return edits.flatMap((e) => e.gone).reduce((t, sentence) => t.replaceAll(sentence, FORGOTTEN), title);
}

/** Memory candidates from the user turns and the saved memories of a pack. Pure and deterministic. */
export function extractMemories(pack: ExtractInput): Candidate[] {
  const found = new Map<string, Candidate & { base: number; seen: Set<string> }>();
  const sourceOf = new Map(pack.conversations.map((c) => [c.id, c.source]));
  const add = (text: string, kind: MemoryKind, base: number, source: Source, conversationId: string | null, date: string | null) => {
    const id = candidateId(kind, text);
    const old = found.get(id);
    const where = conversationId ?? `line:${normalize(text)}`;
    if (!old) found.set(id, { id, text, kind, confidence: base, source, conversationId, date, seenIn: 1, base, seen: new Set([where]) });
    else if (!old.seen.has(where)) {
      old.seen.add(where);
      old.seenIn++;
    }
  };
  for (const memory of pack.savedMemories ?? []) {
    const text = memory.text.trim();
    if (text.length < MIN_CHARS || text.length > MAX_SAVED_CHARS || SECRET.test(text)) continue;
    // A list the user kept is surer than a memory write in a chat.
    const source = (memory.conversationId && sourceOf.get(memory.conversationId)) || pack.source || "memories";
    add(text, classify(text), memory.conversationId ? 0.8 : 0.9, source, memory.conversationId, memory.date);
  }
  for (const conversation of pack.conversations) {
    for (const message of conversation.messages) {
      if (message.role !== "user") continue; // X1
      for (const sentence of sentences(message.text)) {
        const hit = asCandidate(sentence);
        if (hit) add(hit.text, hit.kind, hit.base, conversation.source, conversation.id, message.createdAt ?? conversation.createdAt);
      }
    }
  }
  return [...found.values()].map(({ base, seen: _seen, ...c }) => ({ ...c, confidence: Math.round(Math.min(0.95, base + 0.05 * (c.seenIn - 1)) * 100) / 100 }));
}
