import { useCallback, useId, useMemo } from 'react'
import type { WorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'

type WorktreeJumpPaletteOptionsInput = Pick<
  WorktreeJumpPaletteListEntries,
  'listEntries' | 'listEntryRenderKeys'
> &
  Pick<
    WorktreeJumpPaletteSelectionLifecycle,
    'commandSelectedItemId' | 'handleCommandSelectionChange'
  >

/** Listbox option state owned by the palette: the result list is windowed, so cmdk never registers its rows. */
export function useWorktreeJumpPaletteOptions({
  listEntries,
  listEntryRenderKeys,
  commandSelectedItemId,
  handleCommandSelectionChange
}: WorktreeJumpPaletteOptionsInput) {
  const optionIdPrefix = `${useId()}option`
  // Every rendered option counts, disabled ones included; headings are not options.
  const optionIds = useMemo(
    () =>
      listEntries.flatMap((entry, index) =>
        entry.type === 'section-header' ? [] : [listEntryRenderKeys[index] ?? entry.id]
      ),
    [listEntries, listEntryRenderKeys]
  )
  const optionIndexById = useMemo(
    () => new Map(optionIds.map((id, index) => [id, index])),
    [optionIds]
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
        'aria-setsize': index === undefined ? undefined : optionIds.length,
        value: itemId,
        selected: itemId === commandSelectedItemId,
        onHighlight: () => handleCommandSelectionChange(itemId)
      }
    },
    [
      commandSelectedItemId,
      handleCommandSelectionChange,
      optionIdPrefix,
      optionIds.length,
      optionIndexById
    ]
  )
  return {
    activeOptionId: getOptionId(commandSelectedItemId),
    getOptionId,
    getOptionProps
  }
}

export type WorktreeJumpPaletteOptions = ReturnType<typeof useWorktreeJumpPaletteOptions>
