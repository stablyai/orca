import { useEffect } from 'react'
import { toast } from 'sonner'
import { formatPopupNotice } from './navigate/browser-notices'

// Deduplicate blocked and external-popup notices per page and origin.
export function useBrowserClientHostedPopupNotices(browserPageId: string): void {
  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      const notice = formatPopupNotice(event)
      if (!notice) {
        return
      }
      toast.message(notice, {
        id: `browser-popup:${browserPageId}:${event.action}:${event.origin}`
      })
    })
  }, [browserPageId])
}
