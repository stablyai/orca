import { useEffect, useState } from 'react'
import type { BrowserPageSiteDisplay } from '../../../../../shared/browser-site-display'
import { addBrowserPageSiteDisplayListener } from '../host-guest/browser-page-zoom'

/** The page's current zoom and color scheme, re-read per URL because both belong to the site. */
export function useBrowserPageSiteDisplay(
  browserPageId: string,
  url: string,
  enabled: boolean
): BrowserPageSiteDisplay | null {
  const [display, setDisplay] = useState<BrowserPageSiteDisplay | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let current = true
    void window.api.browser.getPageSiteDisplay({ browserPageId }).then((next) => {
      if (current) {
        setDisplay(next)
      }
    })
    const removeListener = addBrowserPageSiteDisplayListener(browserPageId, (next) => {
      if (current) {
        setDisplay(next)
      }
    })
    return () => {
      current = false
      removeListener()
    }
  }, [browserPageId, url, enabled])
  return enabled ? display : null
}
