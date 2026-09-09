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
import type { PaletteIndexedField } from './indexed-field'
import { comparePaletteEntityRanks, type PaletteActivityRank } from './palette-ranking'

const NO_RANGES: readonly MatchRange[] = []

export function isOmniboxPaletteTabFieldAllowed(field: Pick<PaletteIndexedField, 'id'>): boolean {
  return field.id !== PALETTE_TAB_WORKTREE_FIELD_ID && field.id !== PALETTE_TAB_REPO_FIELD_ID
}

export type PaletteTabIndexedMatch = { index: number; ranges: readonly MatchRange[] }

export type PaletteTabMatch = {
  qualityClass: PaletteResultQualityClass
  rank: PaletteDocumentRank
  titleRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  workspaceRanges: readonly MatchRange[]
  secondaryMatches: readonly PaletteTabIndexedMatch[]
  typeAliasMatches: readonly PaletteTabIndexedMatch[]
  /** First display-preferred proof retained for older row adapters. */
  secondary: PaletteTabIndexedMatch | null
  typeAlias: PaletteTabIndexedMatch | null
}

function indexedMatches(
  rangesByField: ReadonlyMap<string, readonly MatchRange[]>,
  prefix: string
): PaletteTabIndexedMatch[] {
  const matches: PaletteTabIndexedMatch[] = []
  for (const [fieldId, ranges] of rangesByField) {
    const index = parsePaletteTabIndexedFieldId(fieldId, prefix)
    if (index !== null) {
      matches.push({ index, ranges })
    }
  }
  return matches.sort((a, b) => a.index - b.index)
}

export function matchPaletteTabDocument(
  document: PaletteDocument,
  query: Extract<PreparedPaletteQuery, { state: 'ready' }>,
  options: { isFieldAllowed?: (field: PaletteIndexedField) => boolean } = {}
): PaletteTabMatch | null {
  const match = matchPaletteDocument({
    document,
    tokens: query.tokens,
    normalizedQuery: query.normalized,
    tokenCountBeforeDeduplication: query.tokenCountBeforeDeduplication,
    isFieldAllowed: options.isFieldAllowed
  })
  if (!match) {
    return null
  }
  const ranges = match.rangesByField
  const secondaryMatches = indexedMatches(ranges, PALETTE_TAB_SECONDARY_FIELD_PREFIX)
  const typeAliasMatches = indexedMatches(ranges, PALETTE_TAB_ALIAS_FIELD_PREFIX)
  return {
    qualityClass: match.qualityClass,
    rank: match.rank,
    titleRanges: ranges.get(PALETTE_TAB_TITLE_FIELD_ID) ?? NO_RANGES,
    worktreeRanges: ranges.get(PALETTE_TAB_WORKTREE_FIELD_ID) ?? NO_RANGES,
    branchRanges: ranges.get(PALETTE_TAB_BRANCH_FIELD_ID) ?? NO_RANGES,
    repoRanges: ranges.get(PALETTE_TAB_REPO_FIELD_ID) ?? NO_RANGES,
    workspaceRanges: ranges.get(PALETTE_TAB_WORKSPACE_FIELD_ID) ?? NO_RANGES,
    secondaryMatches,
    typeAliasMatches,
    secondary: secondaryMatches[0] ?? null,
    typeAlias: typeAliasMatches[0] ?? null
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
  identity: string
  activity: PaletteActivityRank
}

/** Shared semantic, bucketed-recency, placement, position, and identity order. */
export function comparePaletteTabResults(a: PaletteTabRankInputs, b: PaletteTabRankInputs): number {
  return comparePaletteEntityRanks(
    { rank: a.rank, activity: a.activity, position: a.positionScore, identity: a.identity },
    { rank: b.rank, activity: b.activity, position: b.positionScore, identity: b.identity }
  )
}
