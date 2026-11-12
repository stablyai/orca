import { useCallback, useId, useMemo } from 'react'
import type { WorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'

type WorktreeJumpPaletteOptionsInput = Pick<WorktreeJumpPaletteListEntries, 'selectionItemIds'> &
  Pick<
    WorktreeJumpPaletteSelectionLifecycle,
    'commandSelectedItemId' | 'handleCommandSelectionChange'
  >

/** Listbox option state owned by the palette: the result list is windowed, so cmdk never registers its rows. */
export function useWorktreeJumpPaletteOptions({
  selectionItemIds,
  commandSelectedItemId,
  handleCommandSelectionChange
}: WorktreeJumpPaletteOptionsInput) {
  const optionIdPrefix = `${useId()}option`
  const optionIndexById = useMemo(
    () => new Map(selectionItemIds.map((id, index) => [id, index])),
    [selectionItemIds]
  )
  const getOptionId = useCallback(
    (itemId: string): string | null => {
      const index = optionIndexById.get(itemId)
      return index === undefined ? null : `${optionIdPrefix}-${index}`
    },
    [optionIdPrefix, optionIndexById]
  )
  const getOptionProps = useCallback(
    (itemId: string) => {
      const index = optionIndexById.get(itemId)
      return {
        id: index === undefined ? undefined : `${optionIdPrefix}-${index}`,
        'aria-posinset': index === undefined ? undefined : index + 1,
        'aria-setsize': index === undefined ? undefined : selectionItemIds.length,
        value: itemId,
        selected: itemId === commandSelectedItemId,
        onHighlight: () => handleCommandSelectionChange(itemId)
      }
    },
    [
      commandSelectedItemId,
      handleCommandSelectionChange,
      optionIdPrefix,
      optionIndexById,
      selectionItemIds.length
    ]
  )
  return {
    activeOptionId: getOptionId(commandSelectedItemId),
    getOptionId,
    getOptionProps
  }
}

export type WorktreeJumpPaletteOptions = ReturnType<typeof useWorktreeJumpPaletteOptions>
