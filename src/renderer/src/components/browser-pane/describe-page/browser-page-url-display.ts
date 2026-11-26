import { issueBrowserGuestNavigation } from '../host-guest/metadata/browser-guest-metadata-cache'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import '../../../../../shared/orca-profiles/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken,
  resolveRemoteFailureExternalUrl
} from '../../../../../shared/browser/navigation/browser-url'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { forwardedUrlForRemoteUrl } from '@/lib/workspace-ports/workspace-port-urls'
import type { PortForwardEntry } from '../../../../../shared/remote-runtime/ssh/ssh-types'
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

/** For a page that browses through a remote host, whose loopback this desktop's browser cannot reach. */
export function getRemoteRoutedOpenableExternalUrl(currentUrl: string): string | null {
  return resolveRemoteFailureExternalUrl(redactKagiSessionToken(currentUrl))
}

/** For a page that browses through an SSH host, whose loopback this desktop reaches only through that port's forward. */
export function getSshRoutedOpenableExternalUrl(
  currentUrl: string,
  forwards: readonly PortForwardEntry[]
): string | null {
  const url = redactKagiSessionToken(currentUrl)
  // A public URL opens as is; only the SSH host's loopback needs its forward.
  const publicUrl = resolveRemoteFailureExternalUrl(url)
  if (publicUrl) {
    return publicUrl
  }
  const forwarded = forwardedUrlForRemoteUrl(url, forwards)
  return forwarded ? normalizeExternalBrowserUrl(forwarded) : null
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
