import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function useClearAddressBarHistory(restoreTypedQuery: () => void): () => void {
  const clearBrowserHistory = useAppStore((s) => s.clearBrowserHistory)

  return useCallback(() => {
    restoreTypedQuery()
    clearBrowserHistory()
    toast.success(
      translate(
        'auto.components.browser.pane.browser.address.bar.suggestions.clearHistorySuccess',
        'Browsing history cleared'
      )
    )
  }, [clearBrowserHistory, restoreTypedQuery])
}
