import { issueBrowserGuestNavigation } from '../host-guest/browser-guest-metadata-cache'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import '../../../../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { browserFileUrlToAbsolutePath } from './browser-artifact-upload'
import type { BrowserTabPageState } from './browser-page-types'

/** A blank tab shows an empty bar, so typing never merges into placeholder text. */
export function toDisplayUrl(url: string): string {
  return isBlankBrowserUrl(url) ? '' : redactKagiSessionToken(url)
}

export { getBrowserDisplayTitle } from '../../../../../shared/browser/browser-display-title'

export function isChromiumErrorPage(url: string): boolean {
  return url.startsWith('chrome-error://')
}

export function getNotebookPathFromBrowserUrl(url: string): string | null {
  const filePath = browserFileUrlToAbsolutePath(url)
  return filePath?.toLowerCase().endsWith('.ipynb') ? filePath : null
}

export function getOpenableExternalUrl(currentUrl: string): string | null {
  return normalizeExternalBrowserUrl(redactKagiSessionToken(currentUrl))
}

export function retryBrowserTabLoad(
  webview: Electron.WebviewTag | null,
  browserTab: BrowserPageState,
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
): void {
  if (!webview) {
    return
  }

  const retryUrl = normalizeBrowserNavigationUrl(
    browserTab.loadError?.validatedUrl ?? browserTab.url
  )
  if (!retryUrl) {
    return
  }

  // Why: after chrome-error://, reload() only refreshes the error page — force navigation back to the attempted URL; keep the failure visible until success.
  onUpdatePageState(browserTab.id, {
    loading: true,
    title: retryUrl
  })
  issueBrowserGuestNavigation(webview, () => {
    webview.src = retryUrl
  })
}
