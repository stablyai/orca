import { useCallback, useMemo, useState } from 'react'
import type { PaletteObservedOccurrence } from './cmd-j/palette-observed-prefix'
import { paletteTranscriptWorkspaceHost } from './cmd-j/palette-transcript-host'
import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteTranscriptMatches } from './use-worktree-jump-palette-transcript-matches'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem
} from './worktree-jump-palette-model'
import { buildOpenTabPaletteItems } from './worktree-jump-palette-open-tab-items'
import { mergeWorkspaceTabTranscriptMatches } from './worktree-jump-palette-transcript-matches'

type WorkspaceTabTranscriptMergeInput = Pick<WorktreeJumpPaletteFilter, 'filterModel'> &
  Pick<
    WorktreeJumpPaletteTranscriptMatches,
    'transcriptMatches' | 'transcriptEligibleTabs' | 'transcriptGenerationKey'
  > & {
    protectedOccurrences?: readonly PaletteObservedOccurrence[]
    titleWorkspaceTabItems: WorkspaceTabPaletteItem[]
    workspaceTabEntries: readonly SearchableWorkspaceTab[]
    browserItems: BrowserPaletteItem[]
    simulatorItems: SimulatorPaletteItem[]
    paletteSearchContext: PaletteSearchContext
  }

function reserveWorkspaceTabExcerpt(
  item: WorkspaceTabPaletteItem,
  reserved: boolean
): WorkspaceTabPaletteItem {
  if (reserved) {
    return item.transcriptReserved ? item : { ...item, transcriptReserved: true }
  }
  if (!item.transcriptReserved && !item.transcriptSnippet && !item.transcript?.complete) {
    return item
  }
  return {
    id: item.id,
    type: item.type,
    result: item.result,
    transcriptReserved: false,
    ...(item.transcript ? { transcript: { ...item.transcript, complete: false } } : {})
  }
}

/** Merges transcript matches into the title-matched chats and assembles the open-tab rows. */
export function useWorkspaceTabTranscriptMerge({
  filterModel,
  protectedOccurrences = [],
  transcriptMatches,
  transcriptEligibleTabs,
  transcriptGenerationKey,
  titleWorkspaceTabItems,
  workspaceTabEntries,
  browserItems,
  simulatorItems,
  paletteSearchContext
}: WorkspaceTabTranscriptMergeInput): {
  workspaceTabItems: WorkspaceTabPaletteItem[]
  openTabItems: OpenTabPaletteItem[]
} {
  const executionHostIdForWorktree = useCallback(
    (worktree: Worktree) => paletteTranscriptWorkspaceHost(worktree, filterModel),
    [filterModel]
  )
  const isTranscriptWorktree = useCallback(
    (worktree: Worktree) => executionHostIdForWorktree(worktree) !== null,
    [executionHostIdForWorktree]
  )
  const merged = useMemo(
    () =>
      mergeWorkspaceTabTranscriptMatches({
        titleItems: titleWorkspaceTabItems,
        entries: workspaceTabEntries,
        matches: transcriptMatches,
        context: paletteSearchContext,
        isTranscriptWorktree,
        executionHostIdForWorktree,
        eligibleTabs: transcriptEligibleTabs
      }),
    [
      executionHostIdForWorktree,
      isTranscriptWorktree,
      paletteSearchContext,
      titleWorkspaceTabItems,
      transcriptMatches,
      transcriptEligibleTabs,
      workspaceTabEntries
    ]
  )
  const currentReservations = useMemo(
    () =>
      new Map(
        [...merged.titleItems, ...merged.transcriptOnlyItems].map(
          (item) => [item.id, Boolean(item.transcriptReserved)] as const
        )
      ),
    [merged]
  )
  const [reservation, setReservation] = useState({
    key: transcriptGenerationKey,
    tabs: currentReservations
  })
  const observedIds = new Set(protectedOccurrences.map((entry) => entry.id))
  const nextReservations = new Map(
    [...currentReservations].map(([key, eligible]) => {
      const previous =
        reservation.key === transcriptGenerationKey ? reservation.tabs.get(key) : undefined
      return [
        key,
        previous === true || observedIds.has(key) ? (previous ?? eligible) : eligible
      ] as const
    })
  )
  let reservedTabs = reservation.tabs
  if (
    reservation.key !== transcriptGenerationKey ||
    reservedTabs.size !== nextReservations.size ||
    [...nextReservations].some(([key, eligible]) => reservedTabs.get(key) !== eligible)
  ) {
    reservedTabs = nextReservations
    setReservation({ key: transcriptGenerationKey, tabs: reservedTabs })
  }
  const { workspaceTabItems, transcriptOnlyItems } = useMemo(
    () => ({
      workspaceTabItems: merged.titleItems.map((item) =>
        reserveWorkspaceTabExcerpt(item, reservedTabs.get(item.id) ?? false)
      ),
      transcriptOnlyItems: merged.transcriptOnlyItems.map((item) =>
        reserveWorkspaceTabExcerpt(item, reservedTabs.get(item.id) ?? false)
      )
    }),
    [merged, reservedTabs]
  )
  const openTabItems = useMemo<OpenTabPaletteItem[]>(
    () =>
      buildOpenTabPaletteItems({
        browserItems,
        simulatorItems,
        workspaceTabItems,
        transcriptOnlyItems
      }),
    [browserItems, simulatorItems, transcriptOnlyItems, workspaceTabItems]
  )
  return { workspaceTabItems, openTabItems }
}
