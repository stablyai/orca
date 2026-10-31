import { useEffect } from 'react'
import { toast } from 'sonner'
import { formatPermissionNotice } from './navigate/browser-notices'

/** Mirror local permission-denial wording in toasts because client-hosted chrome has no resource banner. */
export function useBrowserClientHostedPermissionNotices(browserPageId: string): void {
  useEffect(() => {
    return window.api.browser.onPermissionDenied((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      toast.message(formatPermissionNotice(event), {
        id: `browser-permission-denied:${browserPageId}:${event.permission}`
      })
    })
  }, [browserPageId])
}
