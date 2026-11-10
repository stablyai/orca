import { useMemo } from 'react'
import { usePaletteExtraSources } from '@/components/cmd-j/palette-extra-sources'
import type { PaletteExtraSource } from '@/components/cmd-j/palette-extra-results'
import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import {
  encodePaletteIdentity,
  preparePaletteActivity,
  type PaletteSearchContext
} from '../../../../shared/palette-match/palette-ranking'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExtraPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'

export type PaletteExtraSection = { source: PaletteExtraSource; items: ExtraPaletteItem[] }

export function useWorktreeJumpPaletteExtraResults({
  paletteSearchQuery,
  paletteSearchContext,
  visible,
  filterActive,
  taskSourceUrl
}: Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery' | 'taskSourceUrl'> & {
  paletteSearchContext: PaletteSearchContext
  visible: boolean
  filterActive: boolean
}) {
  const sources = usePaletteExtraSources({ query: paletteSearchQuery, visible })
  const hasQuery = paletteSearchQuery.length > 0
  // Filters and issue/PR URLs scope the palette to workspaces.
  const suppressed = filterActive || Boolean(taskSourceUrl)
  const extraSections = useMemo<PaletteExtraSection[]>(() => {
    if (suppressed) {
      return []
    }
    const ranked = (item: ExtraPaletteItem) => ({
      rank: item.result.rank,
      order: item.result.order,
      identity: item.id,
      activity: preparePaletteActivity(item.result.lastActiveAt, paletteSearchContext)
    })
    return sources
      .map((source) => {
        const items = source.results.map((result): ExtraPaletteItem => ({
          id: encodePaletteIdentity(['extra', source.id, result.id]),
          type: 'extra',
          sourceId: source.id,
          result
        }))
        items.sort((a, b) =>
          hasQuery
            ? comparePaletteRankedItems(ranked(a), ranked(b))
            : a.result.order - b.result.order
        )
        return { source, items }
      })
      .filter((section) => section.items.length > 0)
  }, [hasQuery, paletteSearchContext, sources, suppressed])
  const hidesPaletteWorkspace = useMemo(() => {
    const predicates = sources.flatMap((source) =>
      source.hidesWorkspace ? [source.hidesWorkspace] : []
    )
    return predicates.length
      ? (worktree: Worktree) => predicates.some((predicate) => predicate(worktree))
      : null
  }, [sources])
  return { extraSections, hidesPaletteWorkspace }
}

export type WorktreeJumpPaletteExtraResults = ReturnType<typeof useWorktreeJumpPaletteExtraResults>
