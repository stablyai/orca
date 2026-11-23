import { useMemo } from 'react'
import type { BrowserPageZoomDirection } from '../../../../../../shared/browser/site-settings/browser-page-zoom'
import type {
  BrowserPageSiteDisplay,
  BrowserSiteColorScheme
} from '../../../../../../shared/browser/site-settings/browser-site-display'

/** Reads and changes a page's site zoom and color scheme wherever the page renders: this desktop or its host. */
export type BrowserPageSiteDisplaySource = {
  read: () => Promise<BrowserPageSiteDisplay | null>
  zoom: (direction: BrowserPageZoomDirection) => Promise<BrowserPageSiteDisplay | null>
  setColorScheme: (
    colorScheme: BrowserSiteColorScheme | null
  ) => Promise<BrowserPageSiteDisplay | null>
}

/** A page whose guest runs in this desktop, so main reads its site settings directly. */
export function useLocalBrowserPageSiteDisplaySource(
  browserPageId: string
): BrowserPageSiteDisplaySource {
  return useMemo(
    () => ({
      read: () => window.api.browser.getPageSiteDisplay({ browserPageId }),
      zoom: (direction) => window.api.browser.zoomPage({ browserPageId, direction }),
      setColorScheme: (colorScheme) =>
        window.api.browser.setPageSiteColorScheme({ browserPageId, colorScheme })
    }),
    [browserPageId]
  )
}
