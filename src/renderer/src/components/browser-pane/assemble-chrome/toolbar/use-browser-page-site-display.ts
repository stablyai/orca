import { useEffect, useState } from 'react'
import type { BrowserPageSiteDisplay } from '../../../../../../shared/browser/site-settings/browser-site-display'
import { addBrowserPageSiteDisplayListener } from '../../host-guest/viewport/browser-page-zoom'
import type { BrowserPageSiteDisplaySource } from './browser-page-site-display-source'

/** The page's current zoom and color scheme, re-read per URL because both belong to the site. */
export function useBrowserPageSiteDisplay(
  browserPageId: string,
  source: BrowserPageSiteDisplaySource | null,
  url: string,
  enabled: boolean
): BrowserPageSiteDisplay | null {
  const [display, setDisplay] = useState<BrowserPageSiteDisplay | null>(null)
  useEffect(() => {
    if (!enabled || !source) {
      return
    }
    let current = true
    void source.read().then(
      (next) => {
        if (current) {
          setDisplay(next)
        }
      },
      () => undefined
    )
    const removeListener = addBrowserPageSiteDisplayListener(browserPageId, (next) => {
      if (current) {
        setDisplay(next)
      }
    })
    return () => {
      current = false
      removeListener()
    }
  }, [browserPageId, source, url, enabled])
  return enabled && source ? display : null
}
