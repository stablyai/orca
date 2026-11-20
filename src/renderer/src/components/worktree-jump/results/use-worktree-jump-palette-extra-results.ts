import { useMemo } from 'react'
import { usePaletteExtraSources } from '@/components/cmd-j/palette-extra-sources'
import {
  BOT_PALETTE_SOURCE_ID,
  type PaletteExtraSource
} from '@/components/cmd-j/palette-extra-results'
import { comparePaletteRankedItems } from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import {
  encodePaletteIdentity,
  preparePaletteActivity,
  type PaletteSearchContext
} from '../../../../../shared/palette-match/palette-ranking'
import type { ExtraPaletteItem } from '../worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from '../state/use-worktree-jump-palette-local-state'

export type PaletteExtraSection = { source: PaletteExtraSource; items: ExtraPaletteItem[] }

export function useWorktreeJumpPaletteExtraResults({
  paletteSearchQuery,
  paletteSearchContext,
  visible,
  filterActive,
  taskSourceUrl,
  scoped
}: Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery' | 'taskSourceUrl'> & {
  paletteSearchContext: PaletteSearchContext
  visible: boolean
  filterActive: boolean
  /** Showing only bots: filters are paused and only the Bots source lists. */
  scoped: boolean
}) {
  const { sources: allSources, hidesWorkspace: hidesPaletteWorkspace } = usePaletteExtraSources({
    query: paletteSearchQuery,
    visible,
    scoped
  })
  const sources = useMemo(
    () =>
      scoped ? allSources.filter((source) => source.id === BOT_PALETTE_SOURCE_ID) : allSources,
    [allSources, scoped]
  )
  const hasQuery = paletteSearchQuery.length > 0
  // Filters and issue/PR URLs scope the palette to workspaces; the @ scope pauses filters for bots.
  const suppressed = !scoped && (filterActive || Boolean(taskSourceUrl))
  const botSource = allSources.find((source) => source.id === BOT_PALETTE_SOURCE_ID)
  // A filter hiding bots that match a typed query offers to search bots instead; a pasted link doesn't.
  const filterHiddenBotMatches =
    !scoped && filterActive && !taskSourceUrl && hasQuery ? (botSource?.results.length ?? 0) : 0
  const botCatalogSize = botSource?.catalogSize ?? 0
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
  return { extraSections, hidesPaletteWorkspace, filterHiddenBotMatches, botCatalogSize }
}

export type WorktreeJumpPaletteExtraResults = ReturnType<typeof useWorktreeJumpPaletteExtraResults>
