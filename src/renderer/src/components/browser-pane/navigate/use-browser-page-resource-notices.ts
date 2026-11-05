import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
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
      const { importedCookies: count, domains: allDomains } = browserSessionImportState.summary
      const domains = allDomains.slice(0, 3).join(', ')
      const more = allDomains.length - 3
      setResourceNotice(
        more > 0
          ? translate(
              'browser.cookieImport.notice.importedMore',
              'Imported {{count}} cookies for {{domains}} +{{more}} more. Reload the page to use them.',
              {
                count,
                domains,
                more,
                defaultValue_one:
                  'Imported {{count}} cookie for {{domains}} +{{more}} more. Reload the page to use them.'
              }
            )
          : translate(
              'browser.cookieImport.notice.imported',
              'Imported {{count}} cookies for {{domains}}. Reload the page to use them.',
              {
                count,
                domains,
                defaultValue_one:
                  'Imported {{count}} cookie for {{domains}}. Reload the page to use them.'
              }
            )
      )
      clearBrowserSessionImportState()
    } else if (browserSessionImportState.status === 'error' && browserSessionImportState.error) {
      setResourceNotice(
        translate('browser.cookieImport.notice.failed', 'Cookie import failed: {{reason}}', {
          reason: browserSessionImportState.error
        })
      )
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
      const notice = formatPopupNotice(event)
      if (notice) {
        setResourceNotice(notice)
      }
    })
  }, [browserTabId])

  return { resourceNotice, setResourceNotice }
}
