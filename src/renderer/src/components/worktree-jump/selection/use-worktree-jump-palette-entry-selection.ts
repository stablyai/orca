import { useEffect, useMemo, type RefObject } from 'react'
import { buildPaletteListEntryRenderKeys } from '@/components/cmd-j/palette-list-entry-render-keys'
import { getWorktreePaletteSelectionItemIds } from '@/lib/workspace/search/worktrees/worktree-palette-create-action'
import type { PaletteListEntry } from '../worktree-jump-palette-model'

export function useWorktreeJumpPaletteEntrySelection(
  listEntries: PaletteListEntry[],
  defaultSelectionStart: number,
  autoSelectedItemIdRef: RefObject<string | null>
) {
  const listEntryRenderKeys = useMemo(
    () => buildPaletteListEntryRenderKeys(listEntries.map((entry) => entry.id)),
    [listEntries]
  )
  const selectionItemIds = useMemo(
    () => getWorktreePaletteSelectionItemIds(listEntries, listEntryRenderKeys),
    [listEntries, listEntryRenderKeys]
  )
  // null keeps the shared rule: first row, never an unasked Create.
  const defaultSelectionItemId = useMemo(
    () =>
      defaultSelectionStart > 0
        ? (getWorktreePaletteSelectionItemIds(
            listEntries.slice(defaultSelectionStart),
            listEntryRenderKeys.slice(defaultSelectionStart)
          )[0] ?? null)
        : null,
    [defaultSelectionStart, listEntries, listEntryRenderKeys]
  )
  useEffect(() => {
    autoSelectedItemIdRef.current = defaultSelectionItemId ?? selectionItemIds[0] ?? null
  }, [autoSelectedItemIdRef, defaultSelectionItemId, selectionItemIds])
  return { listEntryRenderKeys, selectionItemIds, defaultSelectionItemId }
}
