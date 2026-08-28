import { useEffect } from 'react'
import { toast } from 'sonner'
import { formatPermissionNotice } from './navigate/browser-notices'

/**
 * A client-hosted page has no chrome banner to carry the local pane's resource notices, so a denied
 * permission would otherwise leave the site silently broken. One toast per page and permission,
 * worded exactly as the local pane words it.
 */
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
