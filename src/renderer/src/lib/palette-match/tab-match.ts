import { matchPaletteDocument } from './match-document'
import { preparePaletteQuery, type PreparedPaletteQuery } from './palette-query'
import {
  PALETTE_TAB_ALIAS_FIELD_PREFIX,
  PALETTE_TAB_BRANCH_FIELD_ID,
  PALETTE_TAB_REPO_FIELD_ID,
  PALETTE_TAB_SECONDARY_FIELD_PREFIX,
  PALETTE_TAB_TITLE_FIELD_ID,
  PALETTE_TAB_WORKSPACE_FIELD_ID,
  PALETTE_TAB_WORKTREE_FIELD_ID,
  parsePaletteTabIndexedFieldId
} from './tab-document'
import type { MatchRange } from './normalized-text'
import type { PaletteResultQualityClass } from './match-quality'
import type { PaletteDocument, PaletteDocumentRank } from './palette-document'

const NO_RANGES: readonly MatchRange[] = []

export type PaletteTabIndexedMatch = { index: number; ranges: readonly MatchRange[] }

export type PaletteTabMatch = {
  qualityClass: PaletteResultQualityClass
  rank: PaletteDocumentRank
  titleRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  workspaceRanges: readonly MatchRange[]
  secondary: PaletteTabIndexedMatch | null
  typeAlias: PaletteTabIndexedMatch | null
}

function firstIndexed(
  rangesByField: ReadonlyMap<string, readonly MatchRange[]>,
  prefix: string
): PaletteTabIndexedMatch | null {
  let best: PaletteTabIndexedMatch | null = null
  for (const [fieldId, ranges] of rangesByField) {
    const index = parsePaletteTabIndexedFieldId(fieldId, prefix)
    if (index === null) {
      continue
    }
    if (!best || index < best.index) {
      best = { index, ranges }
    }
  }
  return best
}

export function matchPaletteTabDocument(
  document: PaletteDocument,
  query: Extract<PreparedPaletteQuery, { state: 'ready' }>
): PaletteTabMatch | null {
  const match = matchPaletteDocument({
    document,
    tokens: query.tokens,
    normalizedQuery: query.normalized
  })
  if (!match) {
    return null
  }
  const ranges = match.rangesByField
  return {
    qualityClass: match.qualityClass,
    rank: match.rank,
    titleRanges: ranges.get(PALETTE_TAB_TITLE_FIELD_ID) ?? NO_RANGES,
    worktreeRanges: ranges.get(PALETTE_TAB_WORKTREE_FIELD_ID) ?? NO_RANGES,
    branchRanges: ranges.get(PALETTE_TAB_BRANCH_FIELD_ID) ?? NO_RANGES,
    repoRanges: ranges.get(PALETTE_TAB_REPO_FIELD_ID) ?? NO_RANGES,
    workspaceRanges: ranges.get(PALETTE_TAB_WORKSPACE_FIELD_ID) ?? NO_RANGES,
    secondary: firstIndexed(ranges, PALETTE_TAB_SECONDARY_FIELD_PREFIX),
    typeAlias: firstIndexed(ranges, PALETTE_TAB_ALIAS_FIELD_PREFIX)
  }
}

/**
 * Shared entry point for the tab sections: `null` means the query is unusable
 * (empty or invalid) and the caller should fall back to its positional listing.
 */
export function preparePaletteTabQuery(
  query: string
): Extract<PreparedPaletteQuery, { state: 'ready' }> | null {
  const prepared = preparePaletteQuery(query)
  return prepared.state === 'ready' ? prepared : null
}

export function isPaletteTabQueryRejected(query: string): boolean {
  return preparePaletteQuery(query).state === 'invalid'
}

export type PaletteTabRankInputs = {
  rank: PaletteDocumentRank
  /** Existing positional score: current tab, current worktree, then list order. */
  positionScore: number
  id: string
}

const RANK_KEYS: readonly (keyof PaletteDocumentRank)[] = [
  'exactIntent',
  'wholeQuery',
  'worstQuality',
  'usesSupportingEvidence',
  'fuzzyTokenCount',
  'fieldHopCount'
]

/** Lexicographic match rank first, then the section's existing recency order. */
export function comparePaletteTabResults(a: PaletteTabRankInputs, b: PaletteTabRankInputs): number {
  for (const key of RANK_KEYS) {
    if (a.rank[key] !== b.rank[key]) {
      return a.rank[key] - b.rank[key]
    }
  }
  if (a.positionScore !== b.positionScore) {
    return a.positionScore - b.positionScore
  }
  return a.id.localeCompare(b.id)
}
