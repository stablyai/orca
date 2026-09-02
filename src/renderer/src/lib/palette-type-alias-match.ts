import type { MatchRange } from './worktree-palette-search'

export type PaletteTypeAliasMatch = { text: string; range: MatchRange }

/**
 * Earliest match start wins, not declaration order: "emulator" has to score as a
 * prefix hit on 'emulator' rather than a mid-string hit inside 'mobile emulator
 * tab'. Ties keep the first alias so the longest phrasing stays the label.
 */
export function selectPaletteTypeAliasMatch(
  aliases: readonly string[],
  lowercasedQuery: string
): PaletteTypeAliasMatch | null {
  if (!lowercasedQuery) {
    return null
  }
  let best: PaletteTypeAliasMatch | null = null
  for (const alias of aliases) {
    const start = alias.toLowerCase().indexOf(lowercasedQuery)
    if (start === -1) {
      continue
    }
    if (!best || start < best.range.start) {
      best = { text: alias, range: { start, end: start + lowercasedQuery.length } }
    }
  }
  return best
}
