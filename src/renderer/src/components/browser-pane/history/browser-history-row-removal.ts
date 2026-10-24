import { useCallback } from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { useAppStore } from '@/store'
import type { BrowserAddressBarSuggestion } from '../assemble-chrome/browser-address-bar-suggestions'

type RemovableRow = Pick<BrowserAddressBarSuggestion, 'normalizedUrl' | 'docLocation'>

export function isRemovableHistoryRow(row: RemovableRow): boolean {
  return row.docLocation !== undefined || row.normalizedUrl !== undefined
}

/** Removes a visited page or document from history, so it stops being suggested anywhere. */
export function useRemoveHistoryRow(): (row: RemovableRow) => void {
  const removeBrowserHistoryEntry = useAppStore((s) => s.removeBrowserHistoryEntry)
  const removeWorkspaceDocHistoryEntry = useAppStore((s) => s.removeWorkspaceDocHistoryEntry)
  return useCallback(
    (row: RemovableRow) => {
      if (row.docLocation) {
        removeWorkspaceDocHistoryEntry(row.docLocation)
      } else if (row.normalizedUrl !== undefined) {
        removeBrowserHistoryEntry(row.normalizedUrl)
      }
    },
    [removeBrowserHistoryEntry, removeWorkspaceDocHistoryEntry]
  )
}

/** Chrome's Shift+Delete (Shift+Fn+Delete on Mac laptops) on the highlighted row. */
export function isRemoveRowShortcut(event: React.KeyboardEvent): boolean {
  return (
    event.key === 'Delete' &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isImeOwnedKeyboardEvent(event)
  )
}
