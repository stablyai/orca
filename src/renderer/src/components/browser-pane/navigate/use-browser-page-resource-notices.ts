import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { formatPermissionNotice, formatPopupNotice } from './browser-notices'

export function useBrowserPageResourceNotices(browserTabId: string): {
  resourceNotice: string | null
  setResourceNotice: React.Dispatch<React.SetStateAction<string | null>>
} {
  const [resourceNotice, setResourceNotice] = useState<string | null>(null)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const clearBrowserSessionImportState = useAppStore((s) => s.clearBrowserSessionImportState)

  useEffect(() => {
    if (!browserSessionImportState) {
      return
    }
    if (browserSessionImportState.status === 'success' && browserSessionImportState.summary) {
      const { importedCookies, domains } = browserSessionImportState.summary
      const domainPreview = domains.slice(0, 3).join(', ')
      const more = domains.length > 3 ? ` +${domains.length - 3} more` : ''
      setResourceNotice(
        `Imported ${importedCookies} cookies for ${domainPreview}${more}. Reload the page to use them.`
      )
      clearBrowserSessionImportState()
    } else if (browserSessionImportState.status === 'error' && browserSessionImportState.error) {
      setResourceNotice(`Cookie import failed: ${browserSessionImportState.error}`)
      clearBrowserSessionImportState()
    }
  }, [browserSessionImportState, clearBrowserSessionImportState])

  useEffect(() => {
    if (!resourceNotice) {
      return
    }
    const timer = setTimeout(() => setResourceNotice(null), 10_000)
    return () => clearTimeout(timer)
  }, [resourceNotice])

  useEffect(() => {
    return window.api.browser.onPermissionDenied((event) => {
      if (event.browserPageId !== browserTabId) {
        return
      }
      setResourceNotice(formatPermissionNotice(event))
    })
  }, [browserTabId])

  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserTabId) {
        return
      }
      setResourceNotice(formatPopupNotice(event))
    })
  }, [browserTabId])

  return { resourceNotice, setResourceNotice }
}
