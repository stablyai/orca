import { BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN } from './browser-site-permission'

/** A site's own color scheme; a site with none matches Orca's theme. */
export type BrowserSiteColorScheme = 'light' | 'dark'

/** What a browser profile remembers about how one site is shown. */
export type BrowserSiteDisplay = {
  zoomLevel?: number
  colorScheme?: BrowserSiteColorScheme
}

/** How the page in a tab is shown right now, for the browser menu. */
export type BrowserPageSiteDisplay = {
  /** Null for pages no site owns; neither setting applies to them. */
  site: string | null
  zoomLevel: number
  /** False while the site uses Default Zoom. */
  siteHasZoom: boolean
  colorScheme: BrowserSiteColorScheme | null
}

export function isBrowserSiteColorScheme(value: unknown): value is BrowserSiteColorScheme {
  return value === 'light' || value === 'dark'
}

/**
 * The hostname, port ignored: Chromium shares page zoom across ports, so `localhost:3000` and
 * `localhost:5173` must be one site or they would keep resetting each other. Null for pages no site
 * owns (about:blank, data:, chrome errors).
 */
export function browserSiteDisplayKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname || null
    }
  } catch {
    // Not a URL; no site.
  }
  return null
}
