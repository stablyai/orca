// Allowlist matching for the cloud glossary lint. Entries match by file + term + a snippet of the
// string, never by line number, so unrelated edits that shift lines don't make entries stale.

export type GlossaryHit = { file: string; line: number; term: string; text: string }
export type AllowEntry = { path: string; term: string; match: string; reason: string }

export function isAllowed(hit: GlossaryHit, entry: AllowEntry): boolean {
  return (
    hit.file === entry.path &&
    hit.term === entry.term &&
    entry.match.length > 0 &&
    hit.text.includes(entry.match)
  )
}

/** Entries that no longer match any hit, or that have no reason. */
export function staleAllowEntries(hits: GlossaryHit[], allow: AllowEntry[]): AllowEntry[] {
  return allow.filter(
    (entry) => !entry.reason?.trim() || !hits.some((hit) => isAllowed(hit, entry))
  )
}
