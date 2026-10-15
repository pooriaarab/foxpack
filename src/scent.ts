// SCENT v0.1 (Scoped Context Exchange with Notice and Trail). foxscope
// defines these types; foxpack copies them so it does not depend on it.
// memoryResolver answers for the "memory" namespace: accepted memories by
// kind. Raw conversations are "private" and never returned (S1).
import type { MemoryFilter } from "./pack.js";
import type { MemoryKind, MemoryRecord } from "./types.js";

export type Sensitivity = "public" | "ask" | "private";
export interface ScentField {
  name: string;
  label: string;
  sensitivity: Sensitivity;
  derivable?: boolean;
}
export interface ScentResolver {
  namespace: string;
  list(): Promise<ScentField[]>;
  read(fields: string[], opts: { derive: boolean }): Promise<Record<string, unknown>>;
}
export interface ScentRequest {
  agent: string;
  fields: string[];
  purpose: string;
  ttlSeconds?: number;
}
export type ScentResponse =
  | { status: "granted"; grantId: string; expiresAt: string; values: Record<string, unknown> }
  | { status: "pending"; requestId: string }
  | { status: "denied"; reason: string };

/** Anything that lists memories: a Pack, or a read-only view of a stored pack. */
export interface MemorySource {
  memories(filter?: MemoryFilter): Promise<MemoryRecord[]>;
}

const KIND_FIELDS: Record<string, MemoryKind> = {
  "memory.preferences": "preference",
  "memory.facts": "fact",
  "memory.people": "person",
  "memory.projects": "project",
};

export const MEMORY_FIELDS: readonly ScentField[] = [
  { name: "memory.preferences", label: "Preferences you accepted, such as seats, food and tone", sensitivity: "ask", derivable: true },
  { name: "memory.facts", label: "Facts about you that you accepted", sensitivity: "ask", derivable: true },
  { name: "memory.people", label: "People in your life that you accepted", sensitivity: "ask", derivable: true },
  { name: "memory.projects", label: "Your projects that you accepted", sensitivity: "ask", derivable: true },
  { name: "memory.conversations", label: "Your imported conversations", sensitivity: "private" },
];

/** The value of one memory field. With derive, only the texts (S4). */
export type MemoryValue = string[] | { text: string; source: string; date: string | null }[];

/** A SCENT resolver for the "memory" namespace over a pack. */
export function memoryResolver(source: MemorySource): ScentResolver {
  return {
    namespace: "memory",
    list: async () => MEMORY_FIELDS.map((f) => ({ ...f })),
    async read(fields, opts) {
      const values: Record<string, MemoryValue> = {};
      const asked = [...new Set(fields.filter((f): f is string => typeof f === "string"))];
      // Unknown, private and other-namespace fields are left out (S1, S3).
      const kinds = asked.filter((f) => Object.hasOwn(KIND_FIELDS, f));
      if (kinds.length === 0) return values;
      const accepted = await source.memories({ status: "accepted" }); // S2
      for (const field of kinds) {
        const of = accepted.filter((m) => m.kind === KIND_FIELDS[field]);
        values[field] = opts.derive === true ? of.map((m) => m.text) : of.map((m) => ({ text: m.text, source: m.source, date: m.date }));
      }
      return values;
    },
  };
}
