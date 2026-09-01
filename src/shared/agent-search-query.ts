// Pure, node-free search normalization shared by the desktop and mobile agent
// catalog UIs. One code-point-safe byte cap for the typed query and one bounded
// per-row summary builder, so a pasted blob or a corrupt row cannot multiply
// substring-matching work across a 1,000-agent catalog. Mobile-importable: no
// Node globals, and both sides fold identically so matching cannot drift.

import {
  AGENT_SEARCH_QUERY_MAX_BYTES,
  normalizeAgentLabelKey,
  truncateAgentLabelForDisplay,
  utf8ByteLength
} from './custom-tui-agent-fields'

// Surrogate-safe guard applied to each raw field before NFKC folding, so an
// unbounded corrupt value cannot make normalization itself the hot path. The
// product-visible bound remains AGENT_SEARCH_QUERY_MAX_BYTES below.
const MAX_RAW_SEARCH_FIELD_CODE_UNITS = 2048

/** Truncate to at most `maxBytes` UTF-8 bytes at a Unicode code-point boundary —
 *  never mid-surrogate-pair. May return fewer than `maxBytes` when the next code
 *  point would overflow, rather than splitting it. */
export function truncateToUtf8ByteBudget(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text
  }
  let usedBytes = 0
  let endCodeUnits = 0
  for (const codePoint of text) {
    const codePointBytes = utf8ByteLength(codePoint)
    if (usedBytes + codePointBytes > maxBytes) {
      break
    }
    usedBytes += codePointBytes
    endCodeUnits += codePoint.length
  }
  return text.slice(0, endCodeUnits)
}

// Guard raw length first, then the shared label-key fold (NFKC + collapsed
// White_Space + en-US lowercase) so the query and every summary field fold the
// same way for case-insensitive substring matching.
function normalizeSearchField(raw: string): string {
  return normalizeAgentLabelKey(truncateAgentLabelForDisplay(raw, MAX_RAW_SEARCH_FIELD_CODE_UNITS))
}

/** Normalized, code-point-safe, 2 KiB-capped search input (plan §970). */
export function normalizeAgentSearchQuery(raw: string): string {
  return truncateToUtf8ByteBudget(normalizeSearchField(raw), AGENT_SEARCH_QUERY_MAX_BYTES)
}

export type AgentSearchSummaryFields = {
  /** Row label (custom label or base display name). */
  label: string
  /** Base harness canonical display name. */
  baseName: string
  /** Secondary command summary shown on the row, when present. */
  commandSummary?: string
}

/** One bounded, normalized searchable string per catalog row (label + base
 *  harness canonical name + secondary command summary), capped identically to
 *  the query so 1,000 rows — including corrupt ones — index in bounded work. */
export function buildAgentSearchSummary(fields: AgentSearchSummaryFields): string {
  const parts = [fields.label, fields.baseName, fields.commandSummary ?? '']
    .map(normalizeSearchField)
    .filter((part) => part.length > 0)
  return truncateToUtf8ByteBudget(parts.join(' '), AGENT_SEARCH_QUERY_MAX_BYTES)
}

/** Case-insensitive substring match of an already-normalized query against a row
 *  summary. An empty query matches every row (no active filter). */
export function agentSearchSummaryMatches(summary: string, normalizedQuery: string): boolean {
  return normalizedQuery.length === 0 || summary.includes(normalizedQuery)
}
