import { useEffect } from 'react'
import { toast } from 'sonner'
import { formatPopupNotice } from './navigate/browser-notices'

/**
 * A client-hosted page's popups are gesture-gated and capped, and every outcome — blocked, opened
 * in an Orca tab, or handed to the default browser — leaves no other trace on this pane. One quiet
 * toast per page and origin says what happened, without spamming a site that retries.
 */
export function useBrowserClientHostedPopupNotices(browserPageId: string): void {
  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      toast.message(formatPopupNotice(event), {
        id: `browser-popup:${browserPageId}:${event.action}:${event.origin}`
      })
    })
  }, [browserPageId])
}
