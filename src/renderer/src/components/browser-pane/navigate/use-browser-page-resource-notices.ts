import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { formatPermissionNotice, formatPopupNotice } from './browser-notices'

export type BrowserResourceNotice =
  | { kind: 'text'; text: string }
  | { kind: 'cookies-imported'; count: number }

export function useBrowserPageResourceNotices(browserTabId: string): {
  resourceNotice: BrowserResourceNotice | null
  setResourceNotice: (notice: string | null) => void
} {
  const [resourceNotice, setNotice] = useState<BrowserResourceNotice | null>(null)
  const setResourceNotice = useCallback(
    (notice: string | null) => setNotice(notice === null ? null : { kind: 'text', text: notice }),
    []
  )
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const clearBrowserSessionImportState = useAppStore((s) => s.clearBrowserSessionImportState)

  useEffect(() => {
    if (!browserSessionImportState) {
      return
    }
    if (browserSessionImportState.status === 'success' && browserSessionImportState.summary) {
      setNotice({
        kind: 'cookies-imported',
        count: browserSessionImportState.summary.importedCookies
      })
      clearBrowserSessionImportState()
    } else if (browserSessionImportState.status === 'error' && browserSessionImportState.error) {
      setResourceNotice(
        translate('browser.cookieImport.notice.failed', 'Cookie import failed: {{reason}}', {
          reason: browserSessionImportState.error
        })
      )
      clearBrowserSessionImportState()
    }
  }, [browserSessionImportState, clearBrowserSessionImportState, setResourceNotice])

  useEffect(() => {
    if (!resourceNotice) {
      return
    }
    const timer = setTimeout(() => setNotice(null), 10_000)
    return () => clearTimeout(timer)
  }, [resourceNotice])

  useEffect(() => {
    return window.api.browser.onPermissionDenied((event) => {
      if (event.browserPageId !== browserTabId) {
        return
      }
      setResourceNotice(formatPermissionNotice(event))
    })
  }, [browserTabId, setResourceNotice])

  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserTabId) {
        return
      }
      const notice = formatPopupNotice(event)
      if (notice) {
        setResourceNotice(notice)
      }
    })
  }, [browserTabId, setResourceNotice])

  return { resourceNotice, setResourceNotice }
}
