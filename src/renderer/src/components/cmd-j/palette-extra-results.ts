import type React from 'react'
import type { Translate } from '@/i18n/use-translate'
import type { Worktree } from '../../../../shared/worktree/types'
import type { MatchRange } from '../../../../shared/palette-match/normalized-text'
import type { PaletteResultQualityClass } from '../../../../shared/palette-match/match-quality'
import {
  buildPaletteDocument,
  type PaletteDocumentRank
} from '../../../../shared/palette-match/palette-document'
import { matchPaletteDocument } from '../../../../shared/palette-match/match-document'
import { preparePaletteQuery } from '../../../../shared/palette-match/palette-query'

/** One row a non-workspace source contributes to Cmd+J. */
export type PaletteExtraResult = {
  id: string
  title: string
  titleRanges: readonly MatchRange[]
  /** null in the empty query, where rows are listed without a match. */
  rank: PaletteDocumentRank | null
  qualityClass: PaletteResultQualityClass | null
  lastActiveAt: number | null
  /** Source-defined order: empty-query order, and the typed tie-break after rank and activity. */
  order: number
  dimmed?: boolean
  /** Drawn in the row's 16px lead slot. */
  leading?: React.ReactNode
  /** Inline after the title and age, truncated. */
  line?: React.ReactNode
  /** Right side, where workspace rows show their host and repo chips. */
  trailing?: React.ReactNode
  onSelect: () => void
}

/** One section a source contributes, with its rows for the current query. */
export type PaletteExtraSource = {
  id: string
  sectionLabel: (t: Translate) => string
  emptyQueryCap: number
  /** Empty query: above Recent Chats & Terminals, or after Recent Workspaces (default). The default selection stays on the first row below a 'first' section. */
  emptyQueryPlacement?: 'first' | 'last'
  /** Typed queries: where the section sits when it does not lead the list. */
  typedPlacement: 'before-workspaces' | 'after-workspaces'
  /** Lead the list when its best match equals the best workspace or tab match, not only when it beats it. */
  leadsOnTie: boolean
  /** Typed: matching rows only. Empty query: every row, unranked. */
  results: readonly PaletteExtraResult[]
  /** Workspaces the source represents itself; their tabs stay in Open Tabs and recents. */
  hidesWorkspace?: (worktree: Worktree) => boolean
}

export type PaletteExtraMatch = {
  rank: PaletteDocumentRank
  qualityClass: PaletteResultQualityClass
  rangesByField: ReadonlyMap<string, readonly MatchRange[]>
}

/** Ranks a source's row with the same engine as workspaces, so qualities compare across sections. */
export function matchPaletteExtraFields(
  id: string,
  fields: readonly { id: string; text: string; role: 'primary' | 'secondary' }[],
  query: string
): PaletteExtraMatch | null {
  const prepared = preparePaletteQuery(query)
  if (prepared.state !== 'ready') {
    return null
  }
  const match = matchPaletteDocument({
    document: buildPaletteDocument({
      id,
      visibleFields: fields.map((field) => ({
        id: field.id,
        profile: field.role === 'primary' ? 'structured-label' : 'prose',
        text: field.text,
        role: field.role,
        destinationEligible: field.role === 'primary'
      })),
      evidence: []
    }),
    tokens: prepared.tokens,
    normalizedQuery: prepared.normalized,
    tokenCountBeforeDeduplication: prepared.tokenCountBeforeDeduplication
  })
  return match
    ? { rank: match.rank, qualityClass: match.qualityClass, rangesByField: match.rangesByField }
    : null
}
