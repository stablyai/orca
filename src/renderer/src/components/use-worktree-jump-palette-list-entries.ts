import { useEffect, useMemo } from 'react'
import { getWorktreePaletteSelectionItemIds } from '@/lib/worktree-palette-create-action'
import { buildPaletteListEntryRenderKeys } from '@/components/cmd-j/palette-list-entry-render-keys'
import type { PaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import { reconcilePaletteObservedPrefix } from './cmd-j/palette-observed-prefix'
import {
  useCommitPalettePresentation,
  type WorktreeJumpPaletteObservedPrefix
} from './use-worktree-jump-palette-observed-prefix'
import {
  buildWorktreeJumpPaletteListEntries,
  type WorktreeJumpPaletteListLayoutInput
} from './worktree-jump-palette-list-layout'
import type { WorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'

type WorktreeJumpPaletteListEntriesInput = WorktreeJumpPaletteListLayoutInput &
  WorktreeJumpPaletteSections &
  Pick<WorktreeJumpPaletteLocalState, 'autoSelectedItemIdRef'> &
  Partial<Pick<WorktreeJumpPaletteObservedPrefix, 'protectedOccurrences' | 'commitPresentation'>>

const NO_COMMIT = (): void => {}

export function useWorktreeJumpPaletteListEntries(input: WorktreeJumpPaletteListEntriesInput) {
  const {
    hasQuery,
    openTabsLeadSections,
    paletteSections,
    showCreateAction,
    autoSelectedItemIdRef,
    taskSourceUrl,
    handleExpandSection,
    middleLeadsSections,
    taskItems,
    protectedOccurrences,
    commitPresentation
  } = input
  const rankedEntries = useMemo(
    () =>
      buildWorktreeJumpPaletteListEntries({
        hasQuery,
        openTabsLeadSections,
        paletteSections,
        showCreateAction,
        taskSourceUrl,
        handleExpandSection,
        middleLeadsSections,
        taskItems
      }),
    [
      handleExpandSection,
      hasQuery,
      middleLeadsSections,
      openTabsLeadSections,
      paletteSections,
      showCreateAction,
      taskSourceUrl,
      taskItems
    ]
  )
  const listEntries = useMemo(
    () =>
      reconcilePaletteObservedPrefix({
        prefix: protectedOccurrences ?? [],
        entries: rankedEntries,
        availableItems: [...paletteSections.availableItems, ...taskItems],
        onExpandSection: handleExpandSection
      }),
    [
      protectedOccurrences,
      rankedEntries,
      paletteSections.availableItems,
      taskItems,
      handleExpandSection
    ]
  )
  const selectableItems = useMemo<PaletteItem[]>(
    () =>
      listEntries.filter(
        (entry): entry is PaletteItem =>
          entry.type !== 'section-header' &&
          entry.type !== 'hint' &&
          entry.type !== 'create-worktree'
      ),
    [listEntries]
  )
  const listEntryRenderKeys = useMemo(
    () => buildPaletteListEntryRenderKeys(listEntries.map((entry) => entry.id)),
    [listEntries]
  )
  const selectionItemIds = useMemo(
    () => getWorktreePaletteSelectionItemIds(listEntries, listEntryRenderKeys),
    [listEntries, listEntryRenderKeys]
  )
  useCommitPalettePresentation(commitPresentation ?? NO_COMMIT, listEntries, listEntryRenderKeys)
  useEffect(() => {
    autoSelectedItemIdRef.current = selectionItemIds[0] ?? null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the controller ref preserves its original stable identity.
  }, [selectionItemIds])
  return { listEntries, listEntryRenderKeys, selectableItems, selectionItemIds }
}

export type WorktreeJumpPaletteListEntries = ReturnType<typeof useWorktreeJumpPaletteListEntries>
