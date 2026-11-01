import { useCallback } from 'react'
import { useRemoveHistoryRow } from '../history/browser-history-row-removal'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

/** Removes a dropdown row, then puts back what was typed if that row filled the bar. */
export function useRemoveSuggestionRow(
  restoreTypedQuery: () => void
): (row: BrowserAddressBarSuggestion) => void {
  const removeHistoryRow = useRemoveHistoryRow()
  return useCallback(
    (row: BrowserAddressBarSuggestion) => {
      removeHistoryRow(row)
      // Why: a previewed or inline-completed row would otherwise stay in the bar for Enter to submit.
      restoreTypedQuery()
    },
    [removeHistoryRow, restoreTypedQuery]
  )
}
