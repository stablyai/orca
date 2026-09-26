import { useCallback, useMemo } from 'react'
import { resolveWorktreeFilterHostId } from '@/components/cmd-j/palette-filter-options'
import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
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
  WorktreeJumpPaletteTranscriptMatches & {
    titleWorkspaceTabItems: WorkspaceTabPaletteItem[]
    workspaceTabEntries: readonly SearchableWorkspaceTab[]
    browserItems: BrowserPaletteItem[]
    simulatorItems: SimulatorPaletteItem[]
    paletteSearchContext: PaletteSearchContext
  }

/** Merges transcript matches into the title-matched chats and assembles the open-tab rows. */
export function useWorkspaceTabTranscriptMerge({
  filterModel,
  transcriptMatches,
  titleWorkspaceTabItems,
  workspaceTabEntries,
  browserItems,
  simulatorItems,
  paletteSearchContext
}: WorkspaceTabTranscriptMergeInput): {
  workspaceTabItems: WorkspaceTabPaletteItem[]
  openTabItems: OpenTabPaletteItem[]
} {
  // Host-less worktrees are local even while a runtime is focused; runtime-owned ones carry an owner id.
  const isLocalWorktree = useCallback(
    (worktree: Worktree) =>
      !worktree.runtimeOwnerEnvironmentId &&
      resolveWorktreeFilterHostId(worktree, filterModel.repoById, LOCAL_EXECUTION_HOST_ID) ===
        LOCAL_EXECUTION_HOST_ID,
    [filterModel]
  )
  const { titleItems: workspaceTabItems, transcriptOnlyItems } = useMemo(
    () =>
      mergeWorkspaceTabTranscriptMatches({
        titleItems: titleWorkspaceTabItems,
        entries: workspaceTabEntries,
        matches: transcriptMatches,
        context: paletteSearchContext,
        isLocalWorktree
      }),
    [
      isLocalWorktree,
      paletteSearchContext,
      titleWorkspaceTabItems,
      transcriptMatches,
      workspaceTabEntries
    ]
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
