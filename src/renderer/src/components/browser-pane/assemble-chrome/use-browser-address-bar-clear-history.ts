import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function useClearAddressBarHistory({
  clearSuggestionPreview,
  restoreTypedQuery
}: {
  clearSuggestionPreview: () => void
  restoreTypedQuery: () => void
}): () => void {
  const clearBrowserHistory = useAppStore((s) => s.clearBrowserHistory)

  return useCallback(() => {
    clearSuggestionPreview()
    clearBrowserHistory()
    restoreTypedQuery()
    toast.success(
      translate(
        'auto.components.browser.pane.browser.address.bar.suggestions.clearHistorySuccess',
        'Browsing history cleared'
      )
    )
  }, [clearBrowserHistory, clearSuggestionPreview, restoreTypedQuery])
}
